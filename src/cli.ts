#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { importSession, login } from "./login.js";
import { InfoMentorClient } from "./client.js";
import { createServer, packageInfo, type ServerOptions } from "./server.js";
import { InfoMentorError, sessionPath } from "./session.js";

const help = [
  "Usage: infomentor-se-mcp [command] [options]",
  "",
  "Commands:",
  "  login              Sign in over HTTPS using privately injected secrets or a credentials file",
  "  status             Verify the saved session without opening a window",
  "  logout             Delete the local session (does not revoke it on InfoMentor)",
  "  serve              Start the stdio MCP server (default)",
  "",
  "Options:",
  "  --session FILE     Session file (default: ~/.config/infomentor-se-mcp/session.json, or",
  "                     ~/.infomentor-se-mcp/session.json when that legacy file exists)",
  "  --credentials FILE Private JSON file with username/password (login and automatic renewal)",
  "  --import FILE      login: validate and import a session on a headless machine",
  "  --timeout SECONDS  login: maximum wait (default: 300)",
  "  --allow-account-change",
  "                     login: replace a saved session that belongs to another account",
  "  --allow-advanced-tools",
  "                     serve: also register lower-level message and notification/detail tools",
  "  --allow-setup-tools",
  "                     serve: also register the login, setup-status, cancel, and logout tools",
  "  -h, --help         Show help",
  "  -v, --version      Show version",
  "",
  "Environment: INFOMENTOR_SE_SESSION_PATH, INFOMENTOR_SE_CREDENTIALS_FILE,",
  "             INFOMENTOR_SE_USERNAME (username or email), INFOMENTOR_SE_PASSWORD",
].join("\n");

const stdout = (message: string): void => {
  process.stdout.write(message + "\n");
};

const stderr = (message: string): void => {
  process.stderr.write(message + "\n");
};

async function main(): Promise<void> {
  let parsed;

  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        session: { type: "string" },
        credentials: { type: "string" },
        import: { type: "string" },
        timeout: { type: "string" },
        "allow-account-change": { type: "boolean" },
        "allow-advanced-tools": { type: "boolean" },
        "allow-setup-tools": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch {
    // Retired: a stale password form can submit to a replacement loopback listener.
    if (
      process.argv.slice(2).some((arg) => arg === "--local-form" || arg.startsWith("--local-form="))
    )
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "--local-form has been removed. Use --credentials with a private JSON file or privately inject INFOMENTOR_SE_USERNAME and INFOMENTOR_SE_PASSWORD.",
      );
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Invalid arguments. Run infomentor-se-mcp --help.",
    );
  }

  const { values, positionals } = parsed;

  if (values.help) {
    stdout(help);

    return;
  }

  if (values.version) {
    stdout(packageInfo.version);

    return;
  }

  if (positionals.length > 1)
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Unexpected arguments. Run infomentor-se-mcp --help.",
    );
  const command = positionals[0] ?? "serve";

  if (command !== "login" && (values.import || values.timeout || values["allow-account-change"])) {
    throw new InfoMentorError("INVALID_CONFIGURATION", "Login options only apply to login.");
  }

  if (command !== "serve" && (values["allow-advanced-tools"] || values["allow-setup-tools"]))
    throw new InfoMentorError("INVALID_CONFIGURATION", "Server options only apply to serve.");

  if (values.import && values.credentials)
    throw new InfoMentorError("INVALID_CONFIGURATION", "Choose session import or login, not both.");

  const options: ServerOptions = {};

  if (values.session) options.sessionFile = resolve(values.session);

  if (values.credentials) options.credentialsFile = resolve(values.credentials);

  if (values["allow-advanced-tools"]) options.allowAdvancedTools = true;

  if (values["allow-setup-tools"]) options.allowSetupTools = true;

  if (command === "serve") {
    const handle = serveStdio(() => createServer(options));
    let closing = false;
    const shutdown = (exitCode: number): void => {
      if (closing) return;
      closing = true;
      process.exitCode = exitCode;
      void handle.close().catch(() => {
        process.exitCode = 1;
      });
    };

    process.once("SIGINT", () => shutdown(130));
    process.once("SIGTERM", () => shutdown(143));

    return;
  }

  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    switch (command) {
      case "login": {
        if (values.import) {
          await importSession(
            values.import,
            { ...options, allowAccountChange: values["allow-account-change"] ?? false },
            controller.signal,
          );
          stderr("Session imported and verified.");

          return;
        }

        const timeout = z.coerce
          .number()
          .int()
          .positive()
          .max(3600)
          .safeParse(values.timeout ?? "300");

        if (!timeout.success)
          throw new InfoMentorError(
            "INVALID_CONFIGURATION",
            "Timeout must be between 0 and 3600 seconds, excluding 0.",
          );

        const loginOptions = {
          ...options,
          signal: controller.signal,
          allowAccountChange: values["allow-account-change"] ?? false,
          timeoutMs: timeout.data * 1000,
        };

        await login(
          values.credentials
            ? { ...loginOptions, credentialsFile: resolve(values.credentials) }
            : loginOptions,
        );
        stderr("Signed in. Session saved to " + sessionPath(options.sessionFile));

        return;
      }

      case "status": {
        const client = new InfoMentorClient(options);

        try {
          const status = await client.getSessionStatus(controller.signal);
          stderr(
            status.authenticated
              ? "InfoMentor session is active."
              : (status.nextStep ?? "Sign in with infomentor_login."),
          );

          if (!status.authenticated) process.exitCode = 1;
        } finally {
          await client.close();
        }

        return;
      }

      case "logout": {
        const client = new InfoMentorClient(options);

        try {
          await client.logout();
        } finally {
          await client.close();
        }

        stderr("Local InfoMentor session removed.");

        return;
      }

      default:
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "Unknown command. Run infomentor-se-mcp --help.",
        );
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

void main().catch((cause: unknown) => {
  stderr(
    cause instanceof InfoMentorError
      ? cause.message
      : "InfoMentor operation failed. Check the network and session-file permissions.",
  );
  process.exitCode = cause instanceof InfoMentorError && cause.code === "CANCELLED" ? 130 : 1;
});
