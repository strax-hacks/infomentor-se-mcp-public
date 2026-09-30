import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { SessionStoreError, ioError, systemErrorCode, throwIfAborted } from "./errors.js";

export type ReadOptions = {
  /** Largest accepted file size in bytes; larger files are rejected before they are read. */
  maxBytes: number;
};

export type WriteOptions = {
  /** Flush the file and its directory before returning. Default true. */
  fsync?: boolean | undefined;
  /** An abort observed before the rename leaves the previous file untouched. */
  signal?: AbortSignal | undefined;
};

export type DirectoryOptions = {
  /** Also tighten an existing directory to mode 0700 on Unix. Default false. */
  enforceMode?: boolean | undefined;
};

export type SweepOptions = {
  /** Only temporaries at least this old are removed. Default five minutes. */
  olderThanMs?: number | undefined;
};

export const DEFAULT_SWEEP_AGE_MS = 300_000;

const TEMPORARY_SUFFIX = ".tmp";

// O_NOFOLLOW refuses symbolic links and O_NONBLOCK keeps a FIFO from blocking the open.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

export function assertNoHardLinks(nlink: number): void {
  if (nlink > 1)
    throw new SessionStoreError("UNSAFE_FILE", "Files with hard links are not supported.");
}

type FileState = { ino: number; size: number; mtimeMs: number };

export function fileChanged(before: FileState, after: FileState): boolean {
  return before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

/**
 * Read a file that must be a regular, single-link, owner-only file owned by this user.
 * Symbolic links, group or world access bits, foreign owners, and oversized or changing files are rejected.
 */
export async function readPrivateFile(path: string, options: ReadOptions): Promise<string> {
  const { maxBytes } = options;

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("maxBytes must be a non-negative integer.");
  let handle: FileHandle;

  try {
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    const code = systemErrorCode(error);

    if (code === "ENOENT")
      throw new SessionStoreError("NOT_FOUND", "The file does not exist.", { cause: error });

    if (code === "ELOOP" || code === "EMLINK")
      throw new SessionStoreError(
        "UNSAFE_FILE",
        "The path is a symbolic link; use a regular file.",
        { cause: error },
      );

    if (code === "EISDIR")
      throw new SessionStoreError("UNSAFE_FILE", "The path is not a regular file.", {
        cause: error,
      });
    throw new SessionStoreError("IO", "Cannot open the file. Check its path and permissions.", {
      cause: error,
    });
  }

  try {
    const info = await handle.stat();

    if (!info.isFile())
      throw new SessionStoreError("UNSAFE_FILE", "The path is not a regular file.");
    assertNoHardLinks(info.nlink);

    if (process.platform !== "win32") {
      if ((info.mode & 0o077) !== 0)
        throw new SessionStoreError(
          "UNSAFE_FILE",
          "The file is accessible to other users; use owner-only permissions (chmod 600).",
        );
      const uid = process.getuid?.();

      if (uid !== undefined && info.uid !== uid)
        throw new SessionStoreError("UNSAFE_FILE", "The file is owned by another user.");
    }

    if (info.size > maxBytes)
      throw new SessionStoreError("TOO_LARGE", "The file is larger than allowed.");
    // One extra byte detects a file that grows while it is read.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;

    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);

      if (bytesRead === 0) break;
      length += bytesRead;
    }

    if (length !== info.size)
      throw new SessionStoreError("IO", "The file changed while it was being read.");

    const after = await handle.stat();

    if (fileChanged(info, after))
      throw new SessionStoreError("IO", "The file changed while it was being read.");

    return buffer.toString("utf8", 0, length);
  } catch (error) {
    throw ioError(error, "Cannot read the file. Check its permissions.");
  } finally {
    await handle.close();
  }
}

/**
 * Replace `path` atomically with an owner-only file: an exclusive 0600 temporary is written and
 * flushed, then renamed over the destination, and the directory is flushed as well.
 */
export async function writePrivateFile(
  path: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
): Promise<void> {
  const fsync = options.fsync ?? true;
  throwIfAborted(options.signal);
  await ensurePrivateDir(dirname(path));
  const temporary = `${path}.${randomUUID()}${TEMPORARY_SUFFIX}`;

  try {
    let handle: FileHandle;

    try {
      handle = await open(temporary, "wx", 0o600);
    } catch (error) {
      throw ioError(error, "Cannot create a temporary file. Check the directory permissions.");
    }

    try {
      await handle.writeFile(data);

      if (fsync) await handle.sync();
    } catch (error) {
      throw ioError(error, "Cannot write the file. Check the disk and directory permissions.");
    } finally {
      await handle.close();
    }

    // The rename is the commit point; an abort observed here keeps the previous file.
    throwIfAborted(options.signal);

    try {
      await rename(temporary, path);
    } catch (error) {
      throw ioError(error, "Cannot replace the file. Check the directory permissions.");
    }

    if (fsync) await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Create `path` and missing parents with mode 0700; existing directories keep their mode unless asked. */
export async function ensurePrivateDir(
  path: string,
  options: DirectoryOptions = {},
): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await stat(path);

    if (!info.isDirectory())
      throw new SessionStoreError("UNSAFE_FILE", "The directory path is not a directory.");

    if (options.enforceMode && process.platform !== "win32" && (info.mode & 0o077) !== 0)
      await chmod(path, 0o700);
  } catch (error) {
    throw ioError(error, "Cannot create the directory. Check its permissions.");
  }
}

/** Remove orphaned `<name>.<token>.tmp` files and directories beside `path`. Returns the count. */
export function sweepTemp(path: string, options: SweepOptions = {}): Promise<number> {
  const prefix = `${basename(path)}.`;

  return sweep(
    dirname(path),
    (name) => name.startsWith(prefix) && name.endsWith(TEMPORARY_SUFFIX),
    options,
  );
}

/** Remove every orphaned `*.tmp` entry directly inside `directory`. Returns the count. */
export function sweepTempInDirectory(
  directory: string,
  options: SweepOptions = {},
): Promise<number> {
  return sweep(directory, (name) => name.endsWith(TEMPORARY_SUFFIX), options);
}

async function sweep(
  directory: string,
  matches: (name: string) => boolean,
  options: SweepOptions,
): Promise<number> {
  const olderThanMs = options.olderThanMs ?? DEFAULT_SWEEP_AGE_MS;

  if (!Number.isFinite(olderThanMs) || olderThanMs < 0)
    throw new RangeError("olderThanMs must be a non-negative number.");
  let names: string[];

  try {
    names = await readdir(directory);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return 0;
    throw ioError(error, "Cannot list the directory. Check its permissions.");
  }

  const cutoff = Date.now() - olderThanMs;
  let removed = 0;

  for (const name of names) {
    if (!matches(name)) continue;
    const entry = join(directory, name);
    let info;

    try {
      info = await lstat(entry);
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") continue;
      throw ioError(error, "Cannot inspect a temporary file. Check the directory permissions.");
    }

    if (info.mtimeMs > cutoff) continue;

    try {
      await rm(entry, { recursive: true, force: true });
    } catch (error) {
      throw ioError(error, "Cannot remove a temporary file. Check the directory permissions.");
    }

    removed++;
  }

  return removed;
}

// Directory flushes are best effort: the data file is already durable and renamed, and some
// filesystems refuse to open or sync a directory handle.
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle;

  try {
    handle = await open(directory, constants.O_RDONLY);
  } catch {
    return;
  }

  try {
    await handle.sync();
  } catch {
    // See above: durability of the rename itself is not required for correctness.
  } finally {
    await handle.close();
  }
}
