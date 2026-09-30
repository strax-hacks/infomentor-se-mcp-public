import { Parser } from "htmlparser2";
import { CookieJar } from "tough-cookie";
import { z } from "zod";
import {
  InfoMentorError,
  MAX_RATE_LIMIT_MS,
  PARENT_URL,
  loginRequiredError,
  pupilSchema,
  type HttpFetch,
  throwIfAborted,
  trustedUrl,
} from "./session.js";
import type { SaveTimeRegistrationsPayload } from "./fritidsschema.js";

class ResponseBodyTooLargeError extends Error {
  constructor() {
    super("Response body exceeded its size limit.");
    this.name = "ResponseBodyTooLargeError";
  }
}

async function readBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) return "";
  const decoder = new TextDecoder();
  const text: string[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();

      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw new ResponseBodyTooLargeError();
      text.push(decoder.decode(value, { stream: true }));
    }

    text.push(decoder.decode());

    return text.join("");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export type HttpPage = { url: string; text: string };

export type Form = { id: string; action: string; method: string; fields: URLSearchParams };

export function parseForms(html: string): Form[] {
  const forms: Form[] = [];
  let current: Form | undefined;

  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "form") {
        current = {
          id: attrs["id"] ?? "",
          action: attrs["action"] ?? "",
          method: (attrs["method"] ?? "get").toLowerCase(),
          fields: new URLSearchParams(),
        };
        forms.push(current);
      } else if (
        name === "input" &&
        current &&
        attrs["name"] &&
        attrs["type"]?.toLowerCase() === "hidden" &&
        attrs["disabled"] === undefined
      ) {
        current.fields.append(attrs["name"], attrs["value"] ?? "");
      }
    },
    onclosetag(name) {
      if (name === "form") current = undefined;
    },
  });

  parser.end(html);

  return forms;
}

/** Manual redirects keep cookie handling and destination validation on every hop. */
export class InfoMentorHttp {
  private cooldownUntil: number;
  parent: z.infer<typeof parentSchema> | undefined;
  constructor(
    readonly jar = new CookieJar(),
    cooldownUntil = 0,
    readonly fetch: HttpFetch = globalThis.fetch,
  ) {
    this.cooldownUntil = cooldownUntil;
  }

  /** Epoch milliseconds until which InfoMentor asked this session to pause; 0 when it did not. */
  get rateLimitedUntil(): number {
    return this.cooldownUntil;
  }

  async request(
    value: string,
    fields?: URLSearchParams,
    signal?: AbortSignal,
    source = PARENT_URL,
  ): Promise<HttpPage> {
    return this.requestWithBody(
      value,
      fields?.toString(),
      fields === undefined ? undefined : "application/x-www-form-urlencoded",
      signal,
      source,
    );
  }

  async requestJson(
    value: string,
    payload: unknown,
    signal?: AbortSignal,
    source = PARENT_URL,
  ): Promise<HttpPage> {
    let body: string;

    try {
      body = JSON.stringify(payload);
    } catch {
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "InfoMentor write payload could not be serialized.",
      );
    }

    return this.requestWithBody(value, body, "application/json", signal, source);
  }

  private async requestWithBody(
    value: string,
    body: string | undefined,
    contentType: string | undefined,
    signal?: AbortSignal,
    source = PARENT_URL,
  ): Promise<HttpPage> {
    if (Date.now() < this.cooldownUntil)
      throw new InfoMentorError(
        "RATE_LIMITED",
        "InfoMentor requested a pause. Wait before retrying.",
        this.cooldownUntil - Date.now(),
      );
    const deadline = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let url = trustedUrl(value);
    let requestBody = body;
    let previous = trustedUrl(source);

    try {
      for (let hop = 0; hop < 10; hop++) {
        throwIfAborted(requestSignal);

        const headers = new Headers({
          Accept: "application/json, text/html;q=0.9",
          Referer: previous.href,
        });

        const cookies = this.jar.getCookieStringSync(url.href);

        if (cookies) headers.set("Cookie", cookies);

        if (requestBody !== undefined) {
          if (contentType) headers.set("Content-Type", contentType);
          headers.set("Origin", previous.origin);
        }

        const response = await this.fetch(url, {
          method: requestBody === undefined ? "GET" : "POST",
          body: requestBody ?? null,
          headers,
          redirect: "manual",
          signal: requestSignal,
        });

        for (const cookie of response.headers.getSetCookie())
          this.jar.setCookieSync(cookie, url.href, { ignoreError: true });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");

          if (!location)
            throw new InfoMentorError(
              "UNEXPECTED_PAGE",
              "InfoMentor returned a redirect without a destination.",
            );
          const next = trustedUrl(new URL(location, url).href);

          if ([301, 302, 303].includes(response.status)) requestBody = undefined;

          // Credentials are posted only to the login form's origin, never forwarded by a 307/308.
          if (requestBody !== undefined && next.origin !== url.origin)
            throw new InfoMentorError(
              "UNEXPECTED_PAGE",
              "InfoMentor requested an unsupported cross-origin form redirect.",
            );
          previous = url;
          url = next;
          continue;
        }

        if (response.status === 429) {
          await response.body?.cancel();
          const retry = response.headers.get("retry-after");

          const milliseconds =
            retry && /^\d+$/.test(retry)
              ? Number(retry) * 1000
              : retry
                ? Date.parse(retry) - Date.now()
                : NaN;

          const wait = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 60_000;
          const now = Date.now();
          const cooldown = Math.min(wait, MAX_RATE_LIMIT_MS);
          this.cooldownUntil = now + cooldown;
          throw new InfoMentorError(
            "RATE_LIMITED",
            "InfoMentor is limiting requests. No automatic retry was made.",
            cooldown,
          );
        }

        let text: string;

        try {
          text = await readBody(response, 8 * 1024 * 1024, requestSignal);
        } catch (error) {
          if (!(error instanceof ResponseBodyTooLargeError)) throw error;
          throw new InfoMentorError(
            "UNEXPECTED_PAGE",
            "InfoMentor returned an unexpectedly large response.",
          );
        }

        if (
          /challenge-running|challenge-stage|challenges\.cloudflare\.com|<title[^>]*>\s*(?:just a moment|security check|verify you are human)/i.test(
            text,
          )
        )
          throw new InfoMentorError(
            "CHALLENGE_REQUIRED",
            "InfoMentor requires an interactive security check. Direct HTTP login cannot complete it; no automatic retry was made.",
          );

        if (response.status === 401) throw loginRequiredError();

        if (response.status === 403)
          throw new InfoMentorError(
            "ACCESS_DENIED",
            "InfoMentor denied access. Check the account before retrying.",
          );

        if (!response.ok)
          throw new InfoMentorError(
            "NETWORK_ERROR",
            "InfoMentor returned an error. Try again later.",
          );

        return { url: url.href, text };
      }

      throw new InfoMentorError("UNEXPECTED_PAGE", "InfoMentor returned too many redirects.");
    } catch (error) {
      throwIfAborted(signal);

      if (error instanceof InfoMentorError) throw error;

      if (deadline.aborted)
        throw new InfoMentorError("NETWORK_ERROR", "InfoMentor request timed out.");
      throw new InfoMentorError("NETWORK_ERROR", "InfoMentor request failed. Check the network.");
    }
  }

  async isAuthenticated(signal?: AbortSignal): Promise<boolean> {
    const page = await this.request(
      new URL("authentication/authentication/isauthenticated/", PARENT_URL).href,
      new URLSearchParams(),
      signal,
    );

    if (/^\s*(?:true|false)\s*$/.test(page.text)) return page.text.trim() === "true";

    if (/\/authentication\/authentication\/login(?:callback)?\b/i.test(new URL(page.url).pathname))
      return false;
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "InfoMentor returned an unsupported authentication response.",
    );
  }

  async requireAuthentication(signal?: AbortSignal): Promise<void> {
    if (!(await this.isAuthenticated(signal))) throw loginRequiredError();
  }

  /** InfoMentor's read endpoints use form POSTs, including paging and search. */
  async readAppData<T>(
    path: string,
    fields: Record<string, string>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requestAppData(path, fields, schema, signal);
  }

  /** Read an authenticated JSON endpoint whose contract uses a JSON request body. */
  async readJsonAppData<T>(
    path: string,
    payload: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const page = await this.requestJson(new URL(path, PARENT_URL).href, payload, signal);

    requireSchoolPage(page);

    try {
      return schema.parse(JSON.parse(page.text));
    } catch {
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor school data is unavailable or its format has changed.",
      );
    }
  }

  /** Explicitly named for the small set of school-data endpoints that mutate records. */
  async writeAppData<T>(
    path: string,
    fields: Record<string, string>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requestAppData(path, fields, schema, signal);
  }

  /** InfoMentor's time-registration save endpoint consumes the app's JSON body. */
  async writeJsonAppData<TResponse>(
    path: string,
    payload: SaveTimeRegistrationsPayload,
    schema: z.ZodType<TResponse>,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    const page = await this.requestJson(new URL(path, PARENT_URL).href, payload, signal);

    requireSchoolPage(page);

    try {
      return schema.parse(JSON.parse(page.text));
    } catch {
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor school data is unavailable or its format has changed.",
      );
    }
  }

  private async requestAppData<T>(
    path: string,
    fields: Record<string, string>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const page = await this.request(
      new URL(path, PARENT_URL).href,
      new URLSearchParams(fields),
      signal,
    );

    requireSchoolPage(page);

    try {
      return schema.parse(JSON.parse(page.text));
    } catch {
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor school data is unavailable or its format has changed.",
      );
    }
  }

  async readParent(signal?: AbortSignal, childId?: string): Promise<z.infer<typeof parentSchema>> {
    const page = await this.request(PARENT_URL, undefined, signal);
    requireSchoolPage(page);
    let parent = parseParent(page.text);

    if (childId !== undefined) {
      const child = parent.account.pupils.find((pupil) => pupil.id === childId);

      if (!child)
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "This child is not registered in the account. Use a child ID from infomentor_get_overview.",
        );

      if (!child.selected) {
        if (!child.switchPupilUrl)
          throw new InfoMentorError(
            "UNEXPECTED_PAGE",
            "InfoMentor did not provide a child switch link.",
          );
        const url = trustedUrl(new URL(child.switchPupilUrl, PARENT_URL).href);

        if (
          url.origin !== new URL(PARENT_URL).origin ||
          !/^\/Account\/PupilSwitcher\/SwitchPupil\/\d+$/i.test(url.pathname) ||
          url.search ||
          url.hash
        )
          throw new InfoMentorError(
            "UNEXPECTED_PAGE",
            "InfoMentor returned an unsupported child switch link.",
          );

        try {
          await this.request(url.href, undefined, signal);
          parent = await this.readParent(signal);
        } catch (cause) {
          const error = cause instanceof InfoMentorError ? cause : undefined;
          throw new InfoMentorError(
            error?.code ?? "UNEXPECTED_PAGE",
            "InfoMentor could not select the child. Selection may have changed; refresh infomentor_get_overview before continuing.",
            error?.retryAfterMs,
          );
        }
      }

      const selected = parent.account.pupils.filter((pupil) => pupil.selected);

      if (selected.length !== 1 || selected[0]?.id !== childId)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor did not confirm the requested child. Selection may have changed; refresh infomentor_get_overview before continuing.",
        );
    }

    this.parent = parent;

    return parent;
  }
}

function requireSchoolPage(page: HttpPage): void {
  const url = new URL(page.url);

  if (
    url.origin !== new URL(PARENT_URL).origin ||
    /^\/authentication\/authentication\/login(?:callback)?\b/i.test(url.pathname)
  )
    throw loginRequiredError();
}

export const parentSchema = z.object({
  account: z.object({
    currentUser: z.object({ id: z.string().min(1) }),
    pupils: z.array(pupilSchema.extend({ switchPupilUrl: z.string().nullish() })),
  }),
  apps: z.array(z.object({ codeName: z.string() })),
});

/** Read the JSON assignment; never evaluate scripts returned by the school site. */
export function parseParent(html: string): z.infer<typeof parentSchema> {
  let model: z.infer<typeof parentSchema> | undefined;
  let inScript = false;
  let script = "";

  const parser = new Parser({
    onopentag(name) {
      if (name === "script") {
        inScript = true;
        script = "";
      }
    },
    ontext(text) {
      if (inScript) script += text;
    },
    onclosetag(name) {
      if (name !== "script") return;
      inScript = false;
      const match = /IMHome\.home\.homeData\s*=\s*([\s\S]*?);\s*IMHome\.home\.init\(/.exec(script);

      if (!match?.[1]) return;

      try {
        model = parentSchema.parse(JSON.parse(match[1]));
      } catch {
        /* Reject incompatible bootstrap below. */
      }
    },
  });

  parser.end(html);

  if (!model)
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "InfoMentor parent data has changed or is unavailable.",
    );

  return model;
}
