import assert from "node:assert/strict";
import manifest from "../package.json" with { type: "json" };
import { test } from "bun:test";

test("the npm manifest exposes a Node-compatible npx entrypoint", () => {
  const packageJson = manifest as {
    private?: boolean;
    bin?: Record<string, string>;
    files?: string[];
    engines?: Record<string, string>;
    scripts?: Record<string, string>;
    publishConfig?: Record<string, string>;
  };

  assert.notEqual(packageJson.private, true);
  assert.equal(packageJson.bin?.["infomentor-se-mcp"], "dist/cli.js");
  assert.ok(packageJson.files?.includes("dist"));
  assert.ok(packageJson.files?.includes("RELEASING.md"));
  assert.equal(packageJson.engines?.node, ">=20");
  assert.equal(packageJson.publishConfig?.registry, "https://registry.npmjs.org");
  assert.equal(packageJson.scripts?.build, "tsc -p tsconfig.build.json");
  assert.equal(packageJson.scripts?.prepack, "npm run build");
});
