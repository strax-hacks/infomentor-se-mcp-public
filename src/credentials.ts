import { SessionStoreError, readPrivateFile } from "./shared/session-store/index.js";
import { z } from "zod";
import { InfoMentorError, throwIfAborted } from "./session.js";

export const credentialsSchema = z
  .object({ username: z.string().min(1).max(512), password: z.string().min(1).max(4096) })
  .strict();

export type Credentials = z.infer<typeof credentialsSchema>;

/** The file must be a regular, owner-only file owned by this user; symlinked secret mounts are refused. */
export async function readCredentials(file: string, signal?: AbortSignal): Promise<Credentials> {
  throwIfAborted(signal);
  let text: string;

  try {
    text = await readPrivateFile(file, { maxBytes: 16_384 });
  } catch (error) {
    throwIfAborted(signal);

    if (
      error instanceof SessionStoreError &&
      (error.code === "UNSAFE_FILE" || error.code === "TOO_LARGE")
    )
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "Use a private credentials JSON file (a regular file owned by you, chmod 600, not a symlink) containing username and password.",
      );
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Cannot read valid credentials. Supply a private JSON file containing username and password.",
    );
  }

  try {
    const value = credentialsSchema.parse(JSON.parse(text));
    throwIfAborted(signal);

    return value;
  } catch (error) {
    throwIfAborted(signal);

    if (error instanceof InfoMentorError) throw error;
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Cannot read valid credentials. Supply a private JSON file containing username and password.",
    );
  }
}
