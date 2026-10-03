import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

test("the source MCP server speaks stdio, registers tools, and fails closed without a session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-mcp-source-"));
  const client = new Client({ name: "infomentor-source-smoke", version: "1.0.0" });
  let stderr = "";

  try {
    const transport = new StdioClientTransport({
      command: resolve("bin/infomentor-se-mcp"),
      args: ["serve"],
      cwd: resolve("."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: directory,
        TMPDIR: directory,
        INFOMENTOR_SE_BUN: process.execPath,
        INFOMENTOR_SE_SESSION_PATH: join(directory, "session.json"),
        INFOMENTOR_SE_CREDENTIALS_FILE: join(directory, "credentials.json"),
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "infomentor-se-mcp");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).toSorted(), [
      "infomentor_collect_updates",
      "infomentor_get_fritidsschema",
      "infomentor_get_fritidsschema_comment",
      "infomentor_get_overview",
      "infomentor_select_child",
      "infomentor_session_status",
      "infomentor_set_fritidsschema_comment",
      "infomentor_set_fritidsschema_times",
    ]);
    assert.ok(tools.every((tool) => tool.outputSchema));

    const status = await client.callTool({ name: "infomentor_session_status", arguments: {} });
    z.object({ authenticated: z.literal(false) }).parse(status.structuredContent);

    const overview = await client.callTool({ name: "infomentor_get_overview", arguments: {} });
    assert.equal(overview.isError, true);
    assert.equal(overview.structuredContent, undefined);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }

  assert.equal(stderr, "");
});

test("advanced notification and message tools are opt-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-mcp-advanced-"));
  const client = new Client({ name: "infomentor-advanced-smoke", version: "1.0.0" });

  try {
    const transport = new StdioClientTransport({
      command: resolve("bin/infomentor-se-mcp"),
      args: ["serve", "--allow-advanced-tools"],
      cwd: resolve("."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: directory,
        TMPDIR: directory,
        INFOMENTOR_SE_BUN: process.execPath,
        INFOMENTOR_SE_SESSION_PATH: join(directory, "session.json"),
        INFOMENTOR_SE_CREDENTIALS_FILE: join(directory, "credentials.json"),
      },
      stderr: "pipe",
    });

    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).toSorted(), [
      "infomentor_collect_updates",
      "infomentor_get_calendar_event",
      "infomentor_get_fritidsschema",
      "infomentor_get_fritidsschema_comment",
      "infomentor_get_message",
      "infomentor_get_messages",
      "infomentor_get_news_item",
      "infomentor_get_notifications",
      "infomentor_get_overview",
      "infomentor_select_child",
      "infomentor_session_status",
      "infomentor_set_fritidsschema_comment",
      "infomentor_set_fritidsschema_times",
    ]);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup tools remain independently opt-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-mcp-setup-"));
  const client = new Client({ name: "infomentor-setup-smoke", version: "1.0.0" });

  try {
    const transport = new StdioClientTransport({
      command: resolve("bin/infomentor-se-mcp"),
      args: ["serve", "--allow-setup-tools"],
      cwd: resolve("."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: directory,
        TMPDIR: directory,
        INFOMENTOR_SE_BUN: process.execPath,
        INFOMENTOR_SE_SESSION_PATH: join(directory, "session.json"),
        INFOMENTOR_SE_CREDENTIALS_FILE: join(directory, "credentials.json"),
      },
      stderr: "pipe",
    });

    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.equal(names.length, 12);
    assert.ok(names.includes("infomentor_login"));
    assert.ok(names.includes("infomentor_logout"));
    assert.ok(!names.includes("infomentor_get_notifications"));
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
