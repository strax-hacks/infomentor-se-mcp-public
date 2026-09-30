export { SessionStoreError, throwIfAborted } from "./errors.js";

export type { SessionStoreErrorCode } from "./errors.js";

export {
  DEFAULT_SWEEP_AGE_MS,
  ensurePrivateDir,
  readPrivateFile,
  sweepTemp,
  sweepTempInDirectory,
  writePrivateFile,
} from "./files.js";

export type { DirectoryOptions, ReadOptions, SweepOptions, WriteOptions } from "./files.js";

export { DEFAULT_WAIT_MS, withFileLock } from "./lock.js";

export type { LockOptions } from "./lock.js";

export { defaultSessionPath } from "./paths.js";

export type { SessionPathOptions } from "./paths.js";
