import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type SessionPathOptions = {
  /** A pre-XDG location that keeps precedence while its file exists, so old installs keep working. */
  legacy?: string | undefined;
};

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `$XDG_CONFIG_HOME/<appName>/session.json`, defaulting to `~/.config/<appName>/session.json`.
 * A relative `XDG_CONFIG_HOME` is ignored, as the XDG base directory specification requires.
 */
export function defaultSessionPath(appName: string, options: SessionPathOptions = {}): string {
  if (!APP_NAME.test(appName)) throw new RangeError("appName must be a plain directory name.");

  if (options.legacy !== undefined && isExistingFile(options.legacy)) return options.legacy;
  const configured = process.env["XDG_CONFIG_HOME"];

  const base =
    configured !== undefined && isAbsolute(configured) ? configured : join(homedir(), ".config");

  return join(base, appName, "session.json");
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}
