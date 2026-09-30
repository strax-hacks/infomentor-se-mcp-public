import { SessionStoreError, sweepTemp, withFileLock } from "./shared/session-store/index.js";
import { InfoMentorError, sessionPath, throwIfAborted } from "./session.js";

/** How long a request waits for another local process before reporting it as busy. */
export const LOCK_WAIT_MS = 30_000;

export type SessionLockOptions = { waitMs?: number | undefined };

/** Coordinates cooperating processes on one host using the same session-file path. */
export async function withSessionLock<T>(
  file: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
  options: SessionLockOptions = {},
): Promise<T> {
  throwIfAborted(signal);
  const absolute = sessionPath(file);

  try {
    return await withFileLock(
      absolute,
      { signal, waitMs: options.waitMs ?? LOCK_WAIT_MS },
      async () => {
        // Temporaries orphaned by a hard crash hold cookies; the lock holder removes old ones.
        await sweepTemp(absolute);

        return action();
      },
    );
  } catch (error) {
    if (error instanceof InfoMentorError) throw error;
    throwIfAborted(signal);

    if (!(error instanceof SessionStoreError)) throw error;

    if (error.code === "UNSAFE_FILE")
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "The InfoMentor session file has hard links, which are unsupported.",
      );

    if (error.code === "BUSY")
      throw new InfoMentorError(
        "OPERATION_IN_PROGRESS",
        "Another process is using this InfoMentor session and did not finish within the wait limit. Retry after its operation finishes.",
      );

    if (error.code === "LOCK_LOST")
      throw new InfoMentorError(
        "OPERATION_IN_PROGRESS",
        "Another process took over the InfoMentor session lock during this operation. Retry it.",
      );
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Cannot lock the session file. Check the session directory permissions.",
    );
  }
}
