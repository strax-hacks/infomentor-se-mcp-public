import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { SessionStoreError, ioError, systemErrorCode, throwIfAborted } from "./errors.js";
import { assertNoHardLinks, ensurePrivateDir } from "./files.js";

export type LockOptions = {
  /** Aborts waiting for the lock; work that already started is not interrupted. */
  signal?: AbortSignal | undefined;
  /** Longest wait for a busy lock before BUSY is thrown; 0 fails immediately. Default 30 s. */
  waitMs?: number | undefined;
};

export const DEFAULT_WAIT_MS = 30_000;

const MAX_POLL_MS = 250;

const OWNER_PATTERN = /^([1-9]\d*)-[\da-f-]{36}$/;

const MAX_PID = 2_147_483_647;

type Release = () => Promise<boolean>;

/**
 * Run `work` while holding the lock for `path`, coordinating every process on this host that uses
 * the same file. Errors thrown by `work` propagate unchanged; after `work` succeeds, LOCK_LOST is
 * thrown when another process removed or replaced this holder's owner file in the meantime.
 */
export async function withFileLock<T>(
  path: string,
  options: LockOptions,
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquire(path, options);
  const [settled] = await Promise.allSettled([Promise.resolve().then(work)]);
  const lost = await release();

  if (settled.status === "rejected") throw settled.reason;

  if (lost)
    throw new SessionStoreError(
      "LOCK_LOST",
      "Another process took over the session lock during this operation. Retry it.",
    );

  return settled.value;
}

async function acquire(path: string, options: LockOptions): Promise<Release> {
  const { signal } = options;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;

  if (!Number.isFinite(waitMs) || waitMs < 0)
    throw new RangeError("waitMs must be a non-negative number.");
  throwIfAborted(signal);
  const directory = await lockDirectory(path);
  await rejectHardLinkedTarget(path);
  const owner = `${process.pid}-${randomUUID()}`;
  const temporary = join(dirname(directory), `${basename(path)}.lock-tmp.${owner}`);
  const deadline = Date.now() + waitMs;
  let pollMs = 25;
  let spins = 0;
  let permissionMisses = 0;

  try {
    await mkdir(temporary, { mode: 0o700 });
    await writeFile(join(temporary, owner), "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    throw ioError(
      error,
      "Cannot create the session lock. Check the session directory permissions.",
    );
  }

  try {
    for (;;) {
      throwIfAborted(signal);
      const attempt = await publish(temporary, directory);

      if (attempt === "acquired") break;
      const occupant = await inspect(directory);

      if (occupant === "missing" && attempt === "permission" && ++permissionMisses >= 3)
        throw new SessionStoreError(
          "IO",
          "Cannot create the session lock. Check the session directory permissions.",
        );

      if (occupant !== "busy") {
        // Progress was made; yield occasionally so a pathological directory cannot spin.
        if (++spins % 16 === 0) await sleep(pollMs, signal);

        continue;
      }

      const remaining = deadline - Date.now();

      if (remaining <= 0)
        throw new SessionStoreError(
          "BUSY",
          "Another process holds the session lock. Retry after its operation finishes.",
        );
      await sleep(Math.min(pollMs, remaining), signal);
      pollMs = Math.min(pollMs * 2, MAX_POLL_MS);
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }

  const release: Release = () => removeOwner(directory, owner);

  if (signal?.aborted) {
    await release();
    throwIfAborted(signal);
  }

  return release;
}

async function lockDirectory(path: string): Promise<string> {
  const parent = dirname(path);
  await ensurePrivateDir(parent);

  try {
    // Aliased directories resolve to one lock; the lock lives beside the file it protects.
    return `${join(await realpath(parent), basename(path))}.lock`;
  } catch (error) {
    throw ioError(error, "Cannot resolve the session directory.");
  }
}

async function rejectHardLinkedTarget(path: string): Promise<void> {
  let info;

  try {
    info = await stat(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return;
    throw ioError(error, "Cannot inspect the session file. Check its path and permissions.");
  }

  if (info.isFile()) assertNoHardLinks(info.nlink);
}

/** Publishing a complete, non-empty directory avoids partially written lock ownership. */
async function publish(
  temporary: string,
  directory: string,
): Promise<"acquired" | "occupied" | "permission"> {
  try {
    await rename(temporary, directory);

    return "acquired";
  } catch (error) {
    const code = systemErrorCode(error);

    if (code === "ENOTEMPTY" || code === "EEXIST") return "occupied";

    // Windows can report EPERM for an existing directory; ownership is confirmed by inspection.
    if (code === "EPERM") return "permission";
    throw ioError(
      error,
      "Cannot create the session lock. Check the session directory permissions.",
    );
  }
}

async function inspect(directory: string): Promise<"busy" | "missing" | "retry"> {
  let owners: string[];

  try {
    owners = await readdir(directory);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return "missing";
    throw ioError(
      error,
      "Cannot inspect the session lock. Check the session directory permissions.",
    );
  }

  // Windows cannot always replace an empty directory, so a released shell is removed first.
  if (owners.length === 0) {
    await removeOwner(directory);

    return "retry";
  }

  const [previous] = owners;

  if (owners.length !== 1 || previous === undefined) return "busy";
  const pid = Number(OWNER_PATTERN.exec(previous)?.[1]);

  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) return "busy";

  if (isLive(pid)) return "busy";
  // Remove only that owner's unique filename. A replacement directory is non-empty, so competing
  // recovery attempts can neither rmdir it nor rename over it.
  await removeOwner(directory, previous);

  return "retry";
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return systemErrorCode(error) !== "ESRCH";
  }
}

/** Returns true when `owner` was already gone. */
async function removeOwner(directory: string, owner?: string): Promise<boolean> {
  let missing = false;

  if (owner !== undefined)
    try {
      await unlink(join(directory, owner));
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT")
        throw ioError(
          error,
          "Cannot release the session lock. Check the session directory permissions.",
        );
      missing = true;
    }

  try {
    await rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(systemErrorCode(error) ?? ""))
      throw ioError(
        error,
        "Cannot release the session lock. Check the session directory permissions.",
      );
  }

  return missing;
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await delay(ms, undefined, signal ? { signal } : undefined);
  } catch {
    throwIfAborted(signal);
  }
}
