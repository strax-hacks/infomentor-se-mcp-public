import { resolve } from "node:path";
import { SessionStoreError, readPrivateFile } from "./shared/session-store/index.js";
import { z } from "zod";
import { InfoMentorHttp, parseForms } from "./http.js";
import { withSessionLock } from "./lock.js";
import { credentialsSchema, readCredentials, type Credentials } from "./credentials.js";
import {
  captureSession,
  InfoMentorError,
  LOGIN_URL,
  PARENT_URL,
  rateLimitCooldown,
  readSession,
  restoreCookies,
  savedSessionSchema,
  SESSION_MAX_BYTES,
  sessionPath,
  throwIfAborted,
  trustedUrl,
  writeSession,
  type SavedSession,
  type SessionOptions,
} from "./session.js";

export type ImportOptions = SessionOptions & {
  /** Replace a saved session that belongs to a different verified account. Default false. */
  allowAccountChange?: boolean;
};

export type LoginOptions = ImportOptions & {
  timeoutMs?: number;
  signal?: AbortSignal;
};

function loginDeadline(timeoutMs = 300_000): AbortSignal {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000)
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Login timeout must be between 1 millisecond and one hour.",
    );

  return AbortSignal.timeout(timeoutMs);
}

const loginTimedOut = () =>
  new InfoMentorError("LOGIN_TIMEOUT", "Sign-in timed out. The previous saved session was kept.");

/**
 * Swedish InfoMentor normally uses the parent hub to mint a one-time relay token
 * before showing the ASP.NET username/password form. Some sessions already land on
 * the Swedish login page, so the relay is optional; every discovered relay is still
 * validated and submitted explicitly without page JavaScript or a browser.
 */
export async function authenticate(
  http: InfoMentorHttp,
  credentials: Credentials,
  signal?: AbortSignal,
): Promise<void> {
  const checked = credentialsSchema.safeParse(credentials);

  if (!checked.success)
    throw new InfoMentorError("INVALID_CONFIGURATION", "Enter a valid username and password.");

  const loginPage = await http.request(PARENT_URL, undefined, signal, PARENT_URL);

  const initialRelay = parseForms(loginPage.text).find(
    (candidate) => candidate.id === "openid_message" && candidate.fields.has("oauth_token"),
  );

  const formPage = initialRelay
    ? await postRelay(http, relayForm(loginPage.text, loginPage.url), loginPage.url, signal)
    : await http.request(LOGIN_URL, undefined, signal, LOGIN_URL);

  const form = parseForms(formPage.text).find(
    (candidate) => candidate.fields.has("__VIEWSTATE") && candidate.fields.has("__EVENTVALIDATION"),
  );

  if (!form || form.method !== "post")
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "InfoMentor returned an unsupported Swedish login form.",
    );
  const action = trustedUrl(new URL(form.action, formPage.url).href);

  if (action.origin !== new URL(LOGIN_URL).origin)
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "InfoMentor changed its Swedish password form destination. Login stopped.",
    );
  form.fields.set("login_ascx$txtNotandanafn", checked.data.username);
  form.fields.set("login_ascx$txtLykilord", checked.data.password);
  form.fields.set("login_ascx$btnLogin", "Logga in");
  let authenticatedPage;

  try {
    authenticatedPage = await http.request(action.href, form.fields, signal, formPage.url);
  } finally {
    form.fields.delete("login_ascx$txtLykilord");
    checked.data.password = "";
  }

  if (
    parseForms(authenticatedPage.text).some(
      (candidate) => candidate.id === "openid_message" && candidate.fields.has("oauth_token"),
    )
  )
    await postRelay(
      http,
      relayForm(authenticatedPage.text, authenticatedPage.url),
      authenticatedPage.url,
      signal,
    );

  if (!(await http.isAuthenticated(signal)))
    throw new InfoMentorError(
      "LOGIN_REQUIRED",
      "InfoMentor did not accept the login. Check your credentials; no automatic retry was made.",
    );
}

function relayForm(html: string, pageUrl: string) {
  const relay = parseForms(html).find(
    (candidate) => candidate.id === "openid_message" && candidate.fields.has("oauth_token"),
  );

  if (!relay)
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "InfoMentor did not return its expected Swedish authentication handoff.",
    );

  if (relay.method !== "post")
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "InfoMentor returned an unsupported authentication handoff.",
    );

  const destination = trustedUrl(new URL(relay.action, pageUrl).href);

  if (destination.origin !== new URL(LOGIN_URL).origin)
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "InfoMentor returned an unsupported Swedish authentication destination.",
    );

  return { relay, destination };
}

async function postRelay(
  http: InfoMentorHttp,
  value: ReturnType<typeof relayForm>,
  source: string,
  signal?: AbortSignal,
) {
  return http.request(value.destination.href, value.relay.fields, signal, source);
}

export function hasConfiguredCredentials(options: SessionOptions): boolean {
  return (
    Boolean(options.credentialsFile ?? process.env["INFOMENTOR_SE_CREDENTIALS_FILE"]) ||
    process.env["INFOMENTOR_SE_USERNAME"] !== undefined ||
    process.env["INFOMENTOR_SE_PASSWORD"] !== undefined
  );
}

/** Build a verified candidate; the caller commits only after checking account/context. */
export async function createAuthenticatedHttp(
  options: LoginOptions,
  deadline = loginDeadline(options.timeoutMs),
): Promise<InfoMentorHttp> {
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let credentials: Credentials | undefined;

  try {
    throwIfAborted(signal);
    const file = options.credentialsFile ?? process.env["INFOMENTOR_SE_CREDENTIALS_FILE"];

    if (file) credentials = await readCredentials(resolve(file), signal);
    else if (
      process.env["INFOMENTOR_SE_USERNAME"] !== undefined ||
      process.env["INFOMENTOR_SE_PASSWORD"] !== undefined
    ) {
      const configured = credentialsSchema.safeParse({
        username: process.env["INFOMENTOR_SE_USERNAME"],
        password: process.env["INFOMENTOR_SE_PASSWORD"],
      });

      if (!configured.success)
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "Use the app’s private secret input to provide both INFOMENTOR_SE_USERNAME (InfoMentor username or email) and INFOMENTOR_SE_PASSWORD to the login process. Never put their values in chat or MCP arguments.",
        );
      credentials = configured.data;
    } else
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "Credentials required. Use the app’s private secret input for INFOMENTOR_SE_USERNAME (InfoMentor username or email) and INFOMENTOR_SE_PASSWORD, then run infomentor-se-mcp login with those secrets injected into its environment. If the MCP process already has them, call infomentor_login. Alternatively supply credentialsFile or importFile. Never put secret values in chat or MCP arguments.",
      );

    const http = new InfoMentorHttp(undefined, 0, options.fetch);
    await authenticate(http, credentials, signal);
    credentials.password = "";
    await http.readParent(signal);

    return http;
  } catch (error) {
    if (deadline.aborted && !options.signal?.aborted) throw loginTimedOut();
    throwIfAborted(options.signal);
    throw error;
  } finally {
    if (credentials) credentials.password = "";
  }
}

export async function login(options: LoginOptions = {}): Promise<void> {
  const file = sessionPath(options.sessionFile);
  const deadline = loginDeadline(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  try {
    await withSessionLock(file, signal, async () => {
      const http = await createAuthenticatedHttp(options, deadline);
      const session = sessionFromHttp(http);
      await requireSameAccount(file, session, options.allowAccountChange);
      throwIfAborted(signal);
      await (options.writeSession ?? writeSession)(session, file, signal);
    });
  } catch (error) {
    if (deadline.aborted && !options.signal?.aborted) throw loginTimedOut();
    throwIfAborted(options.signal);
    throw error;
  }
}

export function sessionFromHttp(http: InfoMentorHttp): SavedSession {
  const session = captureSession(http.jar);

  if (http.parent) {
    session.accountId = http.parent.account.currentUser.id;
    const selected = http.parent.account.pupils.filter((pupil) => pupil.selected);

    if (selected.length === 1 && selected[0]) session.selectedChildId = selected[0].id;
  }

  if (http.rateLimitedUntil > Date.now())
    session.rateLimitedUntil = new Date(http.rateLimitedUntil).toISOString();

  return session;
}

/** Cookies plus the pause InfoMentor requested, so every process sharing the file honours it. */
export function httpFromSession(
  session: SavedSession,
  fetcher?: SessionOptions["fetch"],
): InfoMentorHttp {
  return new InfoMentorHttp(restoreCookies(session), rateLimitCooldown(session), fetcher);
}

/**
 * An explicit login or import must not silently switch the saved account: a mistaken
 * credentials or session file would otherwise replace the account used by the MCP.
 * Missing and legacy-v1 files protect nothing. An unsafe or unrecognized existing file cannot
 * safely establish which account it represents, so replacement requires an explicit override.
 */
async function requireSameAccount(
  file: string,
  candidate: SavedSession,
  allowAccountChange: boolean | undefined,
): Promise<void> {
  if (allowAccountChange) return;
  let text: string;

  try {
    text = await readPrivateFile(file, { maxBytes: SESSION_MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === "NOT_FOUND") return;
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "The existing InfoMentor session cannot be verified. The previous session was kept. Log out first, or pass allowAccountChange to replace it.",
    );
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "The existing InfoMentor session cannot be verified. The previous session was kept. Log out first, or pass allowAccountChange to replace it.",
    );
  }

  const checked = z
    .union([z.object({ version: z.literal(1) }).passthrough(), savedSessionSchema])
    .safeParse(value);

  if (!checked.success)
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "The existing InfoMentor session cannot be verified. The previous session was kept. Log out first, or pass allowAccountChange to replace it.",
    );

  if (checked.data.version === 1) return;
  const previous = checked.data;

  if (
    previous.accountId !== undefined &&
    candidate.accountId !== undefined &&
    previous.accountId !== candidate.accountId
  )
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "The new sign-in belongs to a different InfoMentor account than the saved session. The previous session was kept. Log out first, or pass allowAccountChange to replace it.",
    );
}

export async function importSession(
  file: string,
  options: ImportOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const destination = sessionPath(options.sessionFile);
  await withSessionLock(destination, signal, async () => {
    const imported = await readSession(resolve(file));
    const http = httpFromSession(imported, options.fetch);
    await http.requireAuthentication(signal);
    await http.readParent(signal);
    const session = sessionFromHttp(http);
    await requireSameAccount(destination, session, options.allowAccountChange);
    await (options.writeSession ?? writeSession)(session, destination, signal);
  });
}
