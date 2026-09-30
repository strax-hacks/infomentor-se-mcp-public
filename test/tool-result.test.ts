import assert from "node:assert/strict";
import { test } from "bun:test";
import { z } from "zod";
import { toolResult } from "../src/tool-result.js";
import { InfoMentorError } from "../src/session.js";

test("toolResult returns structured content for a successful operation", async () => {
  const result = await toolResult(async () => ({ authenticated: true }));

  assert.deepEqual(result, {
    content: [{ type: "text", text: '{"authenticated":true}' }],
    structuredContent: { authenticated: true },
  });
});

test("toolResult exposes only reviewed InfoMentor errors", async () => {
  const result = await toolResult(async () => {
    throw new InfoMentorError("LOGIN_REQUIRED", "Sign in first.");
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: "Sign in first." }]);
  assert.equal(result.structuredContent, undefined);
});

test("toolResult redacts schema details and unknown exception messages", async () => {
  const schemaError = await toolResult(async () => z.string().parse({ unexpected: true }) as never);
  const unknownError = await toolResult(async () => {
    throw new Error("password=not-for-the-caller");
  });

  assert.equal(schemaError.isError, true);
  assert.deepEqual(schemaError.content, [
    { type: "text", text: "Invalid input or unexpected upstream data." },
  ]);
  assert.equal(unknownError.isError, true);
  assert.deepEqual(unknownError.content, [
    { type: "text", text: "The operation failed. Sensitive details were withheld." },
  ]);
});
