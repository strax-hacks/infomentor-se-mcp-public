import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { InfoMentorHttp, parseParent } from "../src/http.js";
import { PARENT_URL, InfoMentorError } from "../src/session.js";

test("HTTP responses over 8 MiB are rejected before buffering", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      controller.close();
    },
  });

  const fetcher = async (): Promise<Response> => new Response(body);
  const http = new InfoMentorHttp(undefined, 0, fetcher);

  await assert.rejects(http.request(PARENT_URL), /unexpectedly large/);
});

test("Retry-After HTTP-date produces a bounded cooldown", async () => {
  const retryAt = new Date(Date.now() + 60_000).toUTCString();

  const fetcher = async (): Promise<Response> =>
    new Response(null, { status: 429, headers: { "Retry-After": retryAt } });

  const http = new InfoMentorHttp(undefined, 0, fetcher);

  await assert.rejects(http.isAuthenticated(), (error: Error) => {
    return (
      error instanceof InfoMentorError &&
      error.code === "RATE_LIMITED" &&
      (error.retryAfterMs ?? 0) > 55_000 &&
      (error.retryAfterMs ?? 0) <= 60_000
    );
  });
});

test("malformed parent bootstrap is rejected without evaluation", () => {
  assert.throws(
    () => parseParent("<script>IMHome.home.homeData = {bad}; IMHome.home.init(1);</script>"),
    /changed or is unavailable/,
  );
});

test("CLI rejects arguments for the wrong command", async () => {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "status", "--timeout", "1"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  assert.equal(await child.exited, 1);
  assert.match(await new Response(child.stderr).text(), /Login options only apply to login/);
});

test("retired CLI form flags fail before any listener or provider request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-no-form-"));
  const preload = join(directory, "no-network.js");
  await writeFile(
    preload,
    `import { Server } from 'node:http';
Server.prototype.listen = () => process.exit(91);
Bun.serve = () => process.exit(91);
globalThis.fetch = () => process.exit(92);
`,
  );

  try {
    for (const args of [
      ["login", "--local-form"],
      ["login", "--local-form=true"],
      ["login", "--local-form=false"],
      ["status", "--local-form"],
      ["logout", "--local-form"],
      ["serve", "--local-form"],
      ["--local-form"],
    ]) {
      const child = Bun.spawn([process.execPath, "--preload", preload, "src/cli.ts", ...args], {
        cwd: process.cwd(),
        env: { INFOMENTOR_SE_SESSION_PATH: join(directory, "session.json") },
        timeout: 5_000,
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        assert.equal(await child.exited, 1);
        assert.equal(await new Response(child.stdout).text(), "");
        assert.match(
          await new Response(child.stderr).text(),
          /--local-form has been removed\. Use --credentials/,
        );
        assert.deepEqual(await readdir(directory), ["no-network.js"]);
      } finally {
        child.kill();
        await child.exited;
      }
    }

    const help = Bun.spawn([process.execPath, "src/cli.ts", "--help"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    assert.equal(await help.exited, 0);
    const output = await new Response(help.stdout).text();
    assert.doesNotMatch(output, /local-form/);
    assert.match(output, /--credentials/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
