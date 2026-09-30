export type SessionStoreErrorCode =
  | "BUSY"
  | "CANCELLED"
  | "LOCK_LOST"
  | "NOT_FOUND"
  | "UNSAFE_FILE"
  | "TOO_LARGE"
  | "IO";

/** Every message is a literal without paths or file contents, so callers may forward it. */
export class SessionStoreError extends Error {
  constructor(
    readonly code: SessionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionStoreError";
  }
}

/** Node and Bun report filesystem failures as errors that carry a string code. */
export function systemErrorCode(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

export function ioError(cause: unknown, message: string): SessionStoreError {
  return cause instanceof SessionStoreError
    ? cause
    : new SessionStoreError("IO", message, { cause });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new SessionStoreError(
      "CANCELLED",
      "The operation was cancelled before it changed any file.",
    );
}
