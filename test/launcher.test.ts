import assert from "node:assert/strict";
import { test } from "bun:test";

const launcher = `${process.cwd()}/bin/infomentor-se-mcp`;

test("the source launcher fails clearly when the separately installed Bun runtime is missing", async () => {
  const child = Bun.spawn(["/bin/sh", launcher, "--version"], {
    env: {
      PATH: "/usr/bin:/bin",
      INFOMENTOR_SE_BUN: "/missing/bun",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  assert.equal(await child.exited, 127);
  assert.match(
    await new Response(child.stderr).text(),
    /Install it separately.*bun.com\/docs\/installation/,
  );
});
