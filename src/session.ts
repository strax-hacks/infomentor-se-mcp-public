import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  SessionStoreError,
  defaultSessionPath,
  readPrivateFile,
  writePrivateFile,
} from "./shared/session-store/index.js";
import { CookieJar } from "tough-cookie";
import { z } from "zod";

/** Swedish credential form; the parent hub starts the SSO relay before this form. */
export const LOGIN_URL = "https://infomentor.se/swedish/production/mentor/";

/** Swedish parent hub and the origin for authenticated school-data requests. */
export const PARENT_URL = "https://hub.infomentor.se/";

/** A session file holds a cookie jar and identifiers; anything larger is not one. */
export const SESSION_MAX_BYTES = 1_048_576;

/** A persisted rate-limit pause is honoured for at most this long, whatever the file says. */
export const MAX_RATE_LIMIT_MS = 3_600_000;

export type ErrorCode =
  | "LOGIN_REQUIRED"
  | "INVALID_SESSION"
  | "INVALID_CONFIGURATION"
  | "UNEXPECTED_PAGE"
  | "NETWORK_ERROR"
  | "LOGIN_TIMEOUT"
  | "CANCELLED"
  | "CHALLENGE_REQUIRED"
  | "RATE_LIMITED"
  | "ACCESS_DENIED"
  | "OPERATION_IN_PROGRESS";

/** Only these messages are safe for CLI/MCP output; never forward upstream bodies or URLs. */
export class InfoMentorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "InfoMentorError";
  }
}

export function loginRequiredError(): InfoMentorError {
  return new InfoMentorError(
    "LOGIN_REQUIRED",
    "Sign in first: run infomentor-se-mcp login on the MCP host, or call infomentor_login when the server was started with --allow-setup-tools.",
  );
}

export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type WriteSession = (
  session: SavedSession,
  path?: string,
  signal?: AbortSignal,
) => Promise<void>;

const isInfoMentorHost = (host: string): boolean =>
  host === "infomentor.se" || host.endsWith(".infomentor.se");

export function trustedUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new InfoMentorError("INVALID_CONFIGURATION", "Invalid InfoMentor URL.");
  }

  if (
    url.protocol !== "https:" ||
    !isInfoMentorHost(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Only HTTPS hosts under infomentor.se are supported.",
    );
  }

  return url;
}

/** New installs use the XDG location; an existing legacy file keeps its path. */
export function sessionPath(
  path = process.env["INFOMENTOR_SE_SESSION_PATH"] ??
    defaultSessionPath("infomentor-se-mcp", {
      legacy: join(homedir(), ".infomentor-se-mcp", "session.json"),
    }),
): string {
  if (!isAbsolute(path))
    throw new InfoMentorError("INVALID_CONFIGURATION", "The session file path must be absolute.");

  return path;
}

const cookieSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  domain: z.string().refine((value) => isInfoMentorHost(value.replace(/^\./, ""))),
  path: z.string().startsWith("/"),
  expires: z.string().optional(),
  maxAge: z.union([z.number(), z.literal("Infinity"), z.literal("-Infinity")]).optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  hostOnly: z.boolean().optional(),
  sameSite: z.enum(["strict", "lax", "none"]).optional(),
  creation: z.string().optional(),
  lastAccessed: z.string().optional(),
});

export const savedSessionSchema = z.object({
  version: z.literal(2),
  savedAt: z.iso.datetime(),
  cookies: z.array(cookieSchema),
  accountId: z.string().min(1).optional(),
  selectedChildId: z.string().min(1).optional(),
  rateLimitedUntil: z.iso.datetime().optional(),
});

export type SavedSession = z.infer<typeof savedSessionSchema>;

export type SessionOptions = {
  sessionFile?: string;
  credentialsFile?: string;
  fetch?: HttpFetch;
  writeSession?: WriteSession;
};

/** Epoch milliseconds until which every process sharing this session must pause; 0 when none. */
export function rateLimitCooldown(session: SavedSession): number {
  if (session.rateLimitedUntil === undefined) return 0;
  const until = Date.parse(session.rateLimitedUntil);

  if (!Number.isFinite(until) || until <= Date.now()) return 0;

  return Math.min(until, Date.now() + MAX_RATE_LIMIT_MS);
}

export const pupilSchema = z.object({ id: z.string(), name: z.string(), selected: z.boolean() });

export const timetableEntrySchema = z.object({
  start: z.string(),
  end: z.string(),
  title: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  notes: z.object({ roomInfo: z.string(), timetableNotes: z.string(), tutors: z.string() }),
  allDay: z.boolean(),
  establishmentName: z.string().nullable(),
});

const skippedSchema = z
  .number()
  .int()
  .nonnegative()
  .describe("Number of malformed upstream items omitted from this output.");

function parseItems<T>(items: unknown[], schema: z.ZodType<T>) {
  const parsed: T[] = [];
  let skipped = 0;

  for (const item of items) {
    const result = schema.safeParse(item);

    if (result.success) parsed.push(result.data);
    else skipped++;
  }

  return { items: parsed, skipped };
}

export const timetableSchema = z.object({
  items: z.array(timetableEntrySchema),
  skipped: skippedSchema,
});

export const timetableResponseSchema = z
  .object({ items: z.array(z.unknown()) })
  .transform(({ items }) => parseItems(items, timetableEntrySchema));

export const overviewSchema = z.object({
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  retrievedAt: z.iso.datetime(),
  children: z.array(pupilSchema),
  timetable: z.array(timetableEntrySchema).nullable(),
  skipped: skippedSchema,
});

export type Overview = z.infer<typeof overviewSchema>;

export const selectChildRequestSchema = z.object({ childId: z.string().min(1).max(1024) }).strict();

export type SelectChildRequest = z.infer<typeof selectChildRequestSchema>;

export const messagesRequestSchema = z
  .object({
    folder: z.enum(["inbox", "sent"]).default("inbox"),
    search: z.string().max(500).default(""),
    page: z.number().int().min(1).max(100_000).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const messageRequestSchema = z.object({ id: z.number().int().positive() }).strict();

export const notificationsRequestSchema = z
  .object({
    selectedChildOnly: z.boolean().default(false),
    includeCleared: z.boolean().default(false),
  })
  .strict();

const messageUserSchema = z.object({ id: z.number().int(), displayName: z.string().nullable() });

export const messageSummarySchema = z.object({
  id: z.number().int().positive(),
  messageContextType: z.string(),
  sentUser: messageUserSchema,
  isNew: z.boolean(),
  messageSubject: z.string(),
  timeSent: z.string(),
});

export const messageDetailSchema = messageSummarySchema.extend({
  messageBodyPlainText: z.string(),
  toUsers: z.array(messageUserSchema),
  messageFolder: z.string(),
});

export const messagesPageSchema = z.object({
  items: z.array(messageSummarySchema),
  more: z.boolean(),
  skipped: skippedSchema,
});

export const messagesPageResponseSchema = z
  .object({ items: z.array(z.unknown()), more: z.boolean() })
  .transform(({ items, more }) => ({ ...parseItems(items, messageSummarySchema), more }));

export const messagesSchema = messagesPageSchema.extend({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  folder: z.enum(["inbox", "sent"]),
  retrievedAt: z.iso.datetime(),
});

export const messageSchema = z.object({
  message: messageDetailSchema,
  retrievedAt: z.iso.datetime(),
});

export const notificationSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  subTitle: z.string(),
  subjectsCourses: z.string(),
  dateSent: z.string(),
  appType: z.string(),
  state: z
    .string()
    .describe(
      "Common values are New, Seen, Read, and Cleared; other upstream values pass through.",
    ),
  type: z.string(),
  url: z.string(),
  pupilIM2Id: z.number().int(),
  pupilSourceId: z.string(),
  currentlySelectedPupil: z.boolean(),
});

export const notificationsDataSchema = z.object({
  notifications: z.array(notificationSchema),
  skipped: skippedSchema,
});

export const notificationsResponseSchema = z
  .object({ notifications: z.array(z.unknown()) })
  .transform(({ notifications }) => {
    const parsed = parseItems(notifications, notificationSchema);

    return { notifications: parsed.items, skipped: parsed.skipped };
  });

export const notificationsSchema = notificationsDataSchema.extend({
  selectedChildOnly: z.boolean(),
  includeCleared: z.boolean(),
  retrievedAt: z.iso.datetime(),
});

export type MessagesRequest = z.input<typeof messagesRequestSchema>;

export type MessageRequest = z.input<typeof messageRequestSchema>;

export type NotificationsRequest = z.input<typeof notificationsRequestSchema>;

export type Messages = z.infer<typeof messagesSchema>;

export type Message = z.infer<typeof messageSchema>;

export type Notifications = z.infer<typeof notificationsSchema>;

export const sessionStatusSchema = z.object({
  authenticated: z.boolean(),
  nextStep: z.string().optional(),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export function captureSession(jar: CookieJar): SavedSession {
  return savedSessionSchema.parse({
    version: 2,
    savedAt: new Date().toISOString(),
    // tough-cookie omits value for empty cookies, including authentication deletion cookies.
    cookies: (jar.serializeSync()?.cookies ?? []).filter((cookie) => cookie.value),
  });
}

export function restoreCookies(session: SavedSession): CookieJar {
  try {
    const saved = savedSessionSchema.parse(session);

    return CookieJar.fromJSON(JSON.stringify({ cookies: saved.cookies }));
  } catch {
    throw new InfoMentorError("INVALID_SESSION", "Invalid session cookies. Sign in again.");
  }
}

/** Only a regular, owner-only file owned by this user is accepted; symlinks and copies with wider permissions are refused. */
export async function readSession(path = sessionPath()): Promise<SavedSession> {
  let text: string;

  try {
    text = await readPrivateFile(path, { maxBytes: SESSION_MAX_BYTES });
  } catch (error) {
    const code = error instanceof SessionStoreError ? error.code : "IO";

    if (code === "NOT_FOUND") throw loginRequiredError();

    if (code === "UNSAFE_FILE")
      throw new InfoMentorError(
        "INVALID_SESSION",
        "Cannot use the session file: it must be a regular file owned by you with owner-only permissions (chmod 600), not a symlink.",
      );
    throw new InfoMentorError(
      "INVALID_SESSION",
      "Cannot read the session file. Check its path and permissions.",
    );
  }

  try {
    return savedSessionSchema.parse(JSON.parse(text));
  } catch {
    throw new InfoMentorError(
      "INVALID_SESSION",
      "Invalid or older browser session file. Run login again to create an HTTP session.",
    );
  }
}

/** Atomic rename is the commit point; cancellation before it preserves the previous account. */
export async function writeSession(
  session: SavedSession,
  path = sessionPath(),
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const checked = savedSessionSchema.safeParse(session);

  if (!checked.success)
    throw new InfoMentorError("INVALID_SESSION", "Refusing to save an invalid InfoMentor session.");

  try {
    await writePrivateFile(path, JSON.stringify(checked.data), { fsync: true, signal });
  } catch (error) {
    throwIfAborted(signal);

    if (!(error instanceof SessionStoreError)) throw error;
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Cannot save the session file. Check the session directory permissions.",
    );
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new InfoMentorError(
      "CANCELLED",
      "Operation cancelled. The existing saved session was kept.",
    );
}
