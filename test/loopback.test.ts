import * as assert from "node:assert/strict";
import { test } from "bun:test";
import { authenticate } from "../src/login.js";
import { InfoMentorHttp, parseForms } from "../src/http.js";
import { InfoMentorError, LOGIN_URL, PARENT_URL } from "../src/session.js";

const parent = {
  account: {
    currentUser: { id: "parent" },
    pupils: [{ id: "child", name: "Child", selected: true, switchPupilUrl: null }],
  },
  apps: [{ codeName: "timeregistration" }],
};

const parentHtml = `<script>IMHome.home.homeData = ${JSON.stringify(parent)}; IMHome.home.init(IMHome.home.homeData);</script>`;

test("Swedish login follows the parent-hub relay, preserves cookies, and reads the parent page", async () => {
  const requests: string[] = [];
  let authenticated = false;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);

      if (url.pathname === "/" && request.method === "GET") {
        if (authenticated) return new Response(parentHtml);

        return new Response(
          '<form id="openid_message" method="post" action="https://infomentor.se/swedish/production/mentor/"><input type="hidden" name="oauth_token" value="token"></form>',
          { headers: { "Set-Cookie": "preflight=ok; Path=/; Secure; HttpOnly" } },
        );
      }

      if (url.pathname === "/swedish/production/mentor/" && request.method === "POST") {
        const body = await request.text();
        const fields = new URLSearchParams(body);

        if (fields.get("oauth_token") === "final-token") {
          authenticated = true;

          return new Response("relay complete", {
            headers: { "Set-Cookie": "IMHome=ok; Domain=.infomentor.se; Path=/; Secure; HttpOnly" },
          });
        }

        if (fields.has("login_ascx$btnLogin"))
          return new Response(
            '<form id="openid_message" method="post" action="https://infomentor.se/swedish/production/mentor/"><input type="hidden" name="oauth_token" value="final-token"></form>',
          );

        if (fields.has("oauth_token"))
          return new Response(
            '<form method="post" action="https://infomentor.se/swedish/production/mentor/"><input type="hidden" name="__VIEWSTATE" value="state"><input type="hidden" name="__EVENTVALIDATION" value="validation"><input type="submit" name="login_ascx$btnLogin" value="Logga in"></form>',
          );

        return new Response("unexpected login submission", { status: 400 });
      }

      if (url.pathname === "/authentication/authentication/isauthenticated/")
        return new Response("true");

      return new Response("unexpected", { status: 404 });
    },
  });

  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const source = new URL(input instanceof Request ? input.url : input.toString());

    return fetch(`http://127.0.0.1:${server.port}${source.pathname}${source.search}`, init);
  };

  try {
    const http = new InfoMentorHttp(undefined, 0, fetcher);
    await authenticate(http, { username: "synthetic-user", password: "synthetic-test-password" });
    const loaded = await http.readParent();

    assert.equal(loaded.account.currentUser.id, "parent");
    assert.match(http.jar.getCookieStringSync(PARENT_URL), /IMHome=ok/);
    assert.deepEqual(parseForms('<form id="relay"></form>'), [
      { id: "relay", action: "", method: "get", fields: new URLSearchParams() },
    ]);
    assert.deepEqual(requests, [
      "GET /",
      "POST /swedish/production/mentor/",
      "POST /swedish/production/mentor/",
      "POST /swedish/production/mentor/",
      "POST /authentication/authentication/isauthenticated/",
      "GET /",
    ]);
    assert.equal(LOGIN_URL, "https://infomentor.se/swedish/production/mentor/");
  } finally {
    await server.stop(true);
  }
});

const rateLimitFetcher = async (input: string | URL | Request): Promise<Response> => {
  const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;

  if (path === "/rate") return new Response(null, { status: 429, headers: { "Retry-After": "1" } });

  if (path === "/large") return new Response(new Uint8Array(8 * 1024 * 1024 + 1));

  return new Response("unexpected", { status: 404 });
};

test("HTTP rate limits and body caps remain fail-closed", async () => {
  const rateLimited = new InfoMentorHttp(undefined, 0, rateLimitFetcher);
  await assert.rejects(
    rateLimited.request(`${PARENT_URL}rate`),
    (error: Error) => error instanceof InfoMentorError && error.code === "RATE_LIMITED",
  );

  await assert.rejects(
    new InfoMentorHttp(undefined, 0, rateLimitFetcher).request(`${PARENT_URL}large`),
    /unexpectedly large/,
  );
});
