import { createHash, randomUUID } from "node:crypto";
import { readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateDir,
  readPrivateFile,
  sweepTempInDirectory,
  writePrivateFile,
} from "./shared/session-store/index.js";
import { z } from "zod";
import { calendarEventSchema, type CalendarEvent } from "./calendar.js";
import { newsItemSchema, type NewsItem } from "./news.js";
import {
  InfoMentorError,
  PARENT_URL,
  messageDetailSchema,
  messagesPageSchema,
  notificationsDataSchema,
  notificationSchema,
  pupilSchema,
  sessionPath,
  timetableSchema,
  throwIfAborted,
  timetableEntrySchema,
} from "./session.js";

export const collectRequestSchema = z
  .object({
    cursor: z.uuid().optional(),
    includeExisting: z.boolean().default(false),
    maxMessagePages: z.number().int().min(1).max(100).default(20),
  })
  .strict();

const childSchema = pupilSchema.omit({ selected: true });

const collectedNewsDetailSchema = newsItemSchema
  .omit({ notification: true, retrievedAt: true })
  .extend({ kind: z.literal("news") });

const collectedCalendarDetailSchema = calendarEventSchema
  .omit({ notification: true, retrievedAt: true })
  .extend({ kind: z.literal("calendar") });

const notificationDetailSchema = z.discriminatedUnion("kind", [
  collectedNewsDetailSchema,
  collectedCalendarDetailSchema,
]);

const collectedNotificationSchema = notificationSchema
  .omit({ currentlySelectedPupil: true })
  .extend({
    detailStatus: z.enum(["resolved", "not_supported"]),
    detail: notificationDetailSchema.optional(),
  });

const kindSchema = z.enum(["child", "timetable", "message", "notification"]);

const folderSchema = z.enum(["inbox", "sent"]);

const referenceSchema = z.object({
  kind: kindSchema,
  sourceId: z.string(),
  folder: folderSchema.optional(),
  childIds: z.array(z.string()),
});

const updateFields = referenceSchema.omit({ kind: true }).shape;

const skippedSchema = z
  .number()
  .int()
  .nonnegative()
  .describe("Number of malformed upstream items omitted from this output.");

const skippedByFeedSchema = z.object({
  timetable: skippedSchema,
  messages: skippedSchema,
  notifications: skippedSchema,
});

export const collectionSchema = z.object({
  baseline: z.boolean(),
  cursor: z.uuid(),
  retrievedAt: z.iso.datetime(),
  skipped: skippedSchema.describe("Total malformed upstream items omitted from all feeds."),
  skippedByFeed: skippedByFeedSchema,
  children: z.array(childSchema),
  updates: z.array(
    z.discriminatedUnion("kind", [
      z.object({ ...updateFields, kind: z.literal("child"), data: childSchema }),
      z.object({
        ...updateFields,
        kind: z.literal("timetable"),
        data: z.array(timetableEntrySchema).nullable(),
      }),
      z.object({ ...updateFields, kind: z.literal("message"), data: messageDetailSchema }),
      z.object({
        ...updateFields,
        kind: z.literal("notification"),
        data: collectedNotificationSchema,
      }),
    ]),
  ),
  missing: z.array(referenceSchema),
});

export type CollectRequest = z.input<typeof collectRequestSchema>;

export type Collection = z.infer<typeof collectionSchema>;

type Update = Collection["updates"][number];

type Feed = keyof Collection["skippedByFeed"];

const feedNames: readonly Feed[] = ["timetable", "messages", "notifications"];

const feedForKind: Record<Update["kind"], Feed | undefined> = {
  child: undefined,
  timetable: "timetable",
  message: "messages",
  notification: "notifications",
};

type Folder = z.infer<typeof folderSchema>;

const collectionParentSchema = z.object({
  account: z.object({
    currentUser: z.object({ id: z.string().min(1) }),
    pupils: z.array(pupilSchema),
  }),
  apps: z.array(z.object({ codeName: z.string() })),
});

export type CollectionParent = z.infer<typeof collectionParentSchema>;

export type CollectionSource = {
  sessionFile: string;
  signal?: AbortSignal | undefined;
  getParent(signal: AbortSignal): Promise<CollectionParent>;
  selectChild(childId: string, signal: AbortSignal): Promise<CollectionParent>;
  readTimetable(
    parent: CollectionParent,
    signal: AbortSignal,
  ): Promise<z.infer<typeof timetableSchema> | null>;
  getMessages(
    folder: Folder,
    page: number,
    signal: AbortSignal,
  ): Promise<z.infer<typeof messagesPageSchema>>;
  getMessage(id: number, signal: AbortSignal): Promise<z.infer<typeof messageDetailSchema>>;
  getNotifications(signal: AbortSignal): Promise<z.infer<typeof notificationsDataSchema>>;
  /** Resolve notification references for the high-level collection workflow. */
  resolveNewsItem?: (
    notificationId: number,
    signal: AbortSignal,
    notification?: z.infer<typeof notificationSchema>,
  ) => Promise<NewsItem>;
  resolveCalendarEvent?: (
    notificationId: number,
    signal: AbortSignal,
    notification?: z.infer<typeof notificationSchema>,
  ) => Promise<CalendarEvent>;
};

const fingerprintSchema = referenceSchema.omit({ childIds: true }).extend({
  childId: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  summaryHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

const snapshotSchema = z.object({
  version: z.literal(1),
  accountHash: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprints: z.array(fingerprintSchema),
});

type Fingerprint = z.infer<typeof fingerprintSchema>;

type UpdateMetadata = { summaryHash?: string };

type Notification = z.infer<typeof notificationSchema>;

type AddUpdate = (update: Update, childId: string, metadata?: UpdateMetadata) => void;

type AddKnownFingerprint = (fingerprint: Fingerprint) => void;

type Snapshot = z.infer<typeof snapshotSchema>;

const MAX_BYTES = 8 * 1024 * 1024;

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function referenceKey(item: z.infer<typeof referenceSchema> | Fingerprint): string {
  return JSON.stringify([item.kind, item.sourceId, item.folder ?? null]);
}

function fingerprintLookupKey(
  kind: z.infer<typeof kindSchema>,
  sourceId: string,
  childId: string,
  folder?: Folder,
): string {
  return JSON.stringify([JSON.stringify([kind, sourceId, folder ?? null]), childId]);
}

function fingerprintKey(item: Fingerprint): string {
  return fingerprintLookupKey(item.kind, item.sourceId, item.childId, item.folder);
}

function fingerprintsEqual(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.hash === right.hash &&
    (left.summaryHash === undefined ||
      right.summaryHash === undefined ||
      left.summaryHash === right.summaryHash)
  );
}

function changedSelection(): never {
  throw new InfoMentorError(
    "UNEXPECTED_PAGE",
    "The InfoMentor account or selected child changed during collection. No cursor was advanced. Check the overview and retry.",
  );
}

function checkedParent(parent: CollectionParent): CollectionParent {
  const checked = collectionParentSchema.safeParse(parent);

  if (!checked.success) changedSelection();
  const ids = new Set(checked.data.account.pupils.map((child) => child.id));

  if (ids.size !== checked.data.account.pupils.length) changedSelection();

  return checked.data;
}

function accountHash(parent: CollectionParent): string {
  return hash(JSON.stringify([PARENT_URL, parent.account.currentUser.id]));
}

function childList(parent: CollectionParent): string {
  return JSON.stringify(
    parent.account.pupils
      .map(({ id, name }) => ({ id, name }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  );
}

function selectedChild(parent: CollectionParent): string | undefined {
  const selected = parent.account.pupils.filter((child) => child.selected);

  if (parent.account.pupils.length && selected.length !== 1) changedSelection();

  return selected[0]?.id;
}

function confirmParent(
  parent: CollectionParent,
  initial: CollectionParent,
  childId?: string,
): void {
  if (accountHash(parent) !== accountHash(initial) || childList(parent) !== childList(initial))
    changedSelection();

  if (childId !== undefined && selectedChild(parent) !== childId) changedSelection();
}

function cursorError(): never {
  throw new InfoMentorError(
    "INVALID_CONFIGURATION",
    "The collection cursor is unavailable, expired, invalid, or belongs to another account. Omit it to establish a new baseline.",
  );
}

async function readSnapshot(directory: string, cursor: string, owner: string): Promise<Snapshot> {
  const path = join(directory, cursor + ".json");

  try {
    const info = await stat(path);

    if (!info.isFile() || info.size > MAX_BYTES || Date.now() - info.mtimeMs > RETENTION_MS)
      cursorError();

    const snapshot = snapshotSchema.parse(
      JSON.parse(await readPrivateFile(path, { maxBytes: MAX_BYTES })),
    );

    if (snapshot.accountHash !== owner) cursorError();
    const keys = new Set(snapshot.fingerprints.map(fingerprintKey));

    if (keys.size !== snapshot.fingerprints.length) cursorError();

    return snapshot;
  } catch {
    return cursorError();
  }
}

async function saveSnapshot(
  directory: string,
  cursor: string,
  snapshot: Snapshot,
  signal: AbortSignal,
): Promise<void> {
  const contents = JSON.stringify(snapshot);

  if (Buffer.byteLength(contents) > MAX_BYTES)
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "The collection snapshot exceeds the supported size. No cursor was advanced.",
    );
  await ensurePrivateDir(directory, { enforceMode: true });
  await writePrivateFile(join(directory, cursor + ".json"), contents, { fsync: true, signal });
}

async function pruneSnapshots(directory: string): Promise<void> {
  await sweepTempInDirectory(directory);

  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const path = join(directory, name);

    try {
      const info = await stat(path);

      if (info.isFile() && Date.now() - info.mtimeMs > RETENTION_MS)
        await rm(path, { force: true });
    } catch {
      // Retention is best effort; another collection may have removed an expired snapshot.
    }
  }
}

async function collectMessagesForChild(
  source: CollectionSource,
  childId: string,
  maxPages: number,
  signal: AbortSignal,
  previousItems: Map<string, Fingerprint>,
  add: AddUpdate,
  addKnownFingerprint: AddKnownFingerprint,
): Promise<number> {
  let skipped = 0;

  for (const folder of ["inbox", "sent"] as const)
    skipped += await collectFolderMessages(
      source,
      childId,
      folder,
      maxPages,
      signal,
      previousItems,
      add,
      addKnownFingerprint,
    );

  return skipped;
}

async function collectFolderMessages(
  source: CollectionSource,
  childId: string,
  folder: Folder,
  maxPages: number,
  signal: AbortSignal,
  previousItems: Map<string, Fingerprint>,
  add: AddUpdate,
  addKnownFingerprint: AddKnownFingerprint,
): Promise<number> {
  const seen = new Set<number>();
  let skipped = 0;

  for (let page = 1; page <= maxPages; page++) {
    const messages = messagesPageSchema.parse(await source.getMessages(folder, page, signal));
    skipped += messages.skipped;

    for (const summary of messages.items) {
      if (seen.has(summary.id))
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor message pages overlap or changed during collection. No cursor was advanced.",
        );
      seen.add(summary.id);

      const summaryHash = hash(JSON.stringify(summary));
      const previous = previousItems.get(
        fingerprintLookupKey("message", String(summary.id), childId, folder),
      );

      // Message bodies are immutable for the normal InfoMentor workflow. Keep
      // the previous body fingerprint when the server summary is unchanged;
      // old snapshots without summaryHash are fetched once to upgrade safely.
      if (previous?.summaryHash === summaryHash) {
        addKnownFingerprint({ ...previous, summaryHash });
        continue;
      }

      const detail = messageDetailSchema.parse(await source.getMessage(summary.id, signal));

      if (detail.id !== summary.id)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor returned a different message than requested. No cursor was advanced.",
        );
      add(
        { kind: "message", sourceId: String(detail.id), folder, childIds: [], data: detail },
        childId,
        { summaryHash },
      );
    }

    if (!messages.more) return skipped;

    if ((!messages.items.length && messages.skipped === 0) || page === maxPages)
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "The complete message history could not be collected within maxMessagePages. Increase the limit and retry; no cursor was advanced.",
      );
  }

  return skipped;
}

async function resolveCollectedNotification(
  item: Notification,
  source: CollectionSource,
  signal: AbortSignal,
): Promise<z.infer<typeof collectedNotificationSchema>> {
  throwIfAborted(signal);

  if (item.type === "NewsItem") {
    if (!source.resolveNewsItem)
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        `The high-level collection source cannot resolve NewsItem notification ${item.id}; no cursor was advanced.`,
      );

    try {
      const resolved = await source.resolveNewsItem(item.id, signal, item);
      const { notification: _notification, retrievedAt: _retrievedAt, ...detail } = resolved;
      return collectedNotificationSchema.parse({
        ...item,
        detailStatus: "resolved",
        detail: collectedNewsDetailSchema.parse({ kind: "news", ...detail }),
      });
    } catch (error) {
      if (error instanceof InfoMentorError)
        throw new InfoMentorError(
          error.code,
          `InfoMentor could not resolve NewsItem notification ${item.id}; no cursor was advanced.`,
          error.retryAfterMs,
        );
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        `InfoMentor returned invalid details for NewsItem notification ${item.id}; no cursor was advanced.`,
      );
    }
  }

  if (item.type === "CalendarV2" || item.type === "CalendarV2EventCreated") {
    if (!source.resolveCalendarEvent)
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        `The high-level collection source cannot resolve ${item.type} notification ${item.id}; no cursor was advanced.`,
      );

    try {
      const resolved = await source.resolveCalendarEvent(item.id, signal, item);
      const { notification: _notification, retrievedAt: _retrievedAt, ...detail } = resolved;
      return collectedNotificationSchema.parse({
        ...item,
        detailStatus: "resolved",
        detail: collectedCalendarDetailSchema.parse({ kind: "calendar", ...detail }),
      });
    } catch (error) {
      if (error instanceof InfoMentorError)
        throw new InfoMentorError(
          error.code,
          `InfoMentor could not resolve ${item.type} notification ${item.id}; no cursor was advanced.`,
          error.retryAfterMs,
        );
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        `InfoMentor returned invalid details for ${item.type} notification ${item.id}; no cursor was advanced.`,
      );
    }
  }

  return collectedNotificationSchema.parse({ ...item, detailStatus: "not_supported" });
}

/** The caller holds the authenticated account lock for this entire operation. */
export async function collectUpdates(
  request: CollectRequest,
  source: CollectionSource,
): Promise<Collection> {
  const checkedInput = collectRequestSchema.safeParse(request);

  if (!checkedInput.success)
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Invalid collection request. Use a returned UUID cursor and maxMessagePages between 1 and 100.",
    );
  const input = checkedInput.data;
  const signal = source.signal ?? new AbortController().signal;
  const directory = sessionPath(source.sessionFile) + ".collections";
  throwIfAborted(signal);
  const initial = checkedParent(await source.getParent(signal));
  const originalChild = selectedChild(initial);
  const owner = accountHash(initial);
  const previous = input.cursor ? await readSnapshot(directory, input.cursor, owner) : undefined;
  const previousItems = new Map(previous?.fingerprints.map((item) => [fingerprintKey(item), item]));
  const current = new Map<string, Fingerprint>();
  const updates = new Map<string, Update>();
  let outputBytes = 0;
  const skippedByFeed = { timetable: 0, messages: 0, notifications: 0 };
  const resolvedNotificationCache = new Map<
    string,
    Promise<z.infer<typeof collectedNotificationSchema>>
  >();
  let collectionError: InfoMentorError | undefined;

  function recordCurrent(fingerprint: Fingerprint): void {
    const key = fingerprintKey(fingerprint);
    const existing = current.get(key);

    if (existing && !fingerprintsEqual(existing, fingerprint))
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor returned conflicting collection data. No cursor was advanced.",
      );
    current.set(key, fingerprint);
  }

  function addKnownFingerprint(fingerprint: Fingerprint): void {
    throwIfAborted(signal);
    recordCurrent(fingerprint);
  }

  function add(update: Update, childId: string, metadata: UpdateMetadata = {}): void {
    throwIfAborted(signal);
    const payload = JSON.stringify(update.data);

    const fingerprint: Fingerprint = {
      kind: update.kind,
      sourceId: update.sourceId,
      childId,
      hash: hash(payload),
      ...(metadata.summaryHash ? { summaryHash: metadata.summaryHash } : {}),
    };

    if (update.folder !== undefined) fingerprint.folder = update.folder;
    recordCurrent(fingerprint);

    const previousFingerprint = previousItems.get(fingerprintKey(fingerprint));
    if (
      (!previous && !input.includeExisting) ||
      (previousFingerprint !== undefined && fingerprintsEqual(previousFingerprint, fingerprint))
    )
      return;
    const groupKey = JSON.stringify([referenceKey(fingerprint), fingerprint.hash]);
    const grouped = updates.get(groupKey);

    if (grouped) {
      if (!grouped.childIds.includes(childId)) grouped.childIds.push(childId);
    } else {
      update.childIds = [childId];
      updates.set(groupKey, update);
      outputBytes += Buffer.byteLength(payload);

      if (outputBytes > MAX_BYTES)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "The collection exceeds the supported response size. No cursor was advanced.",
        );
    }
  }

  try {
    for (const child of initial.account.pupils) {
      let parent = checkedParent(await source.getParent(signal));
      confirmParent(parent, initial);

      if (selectedChild(parent) !== child.id)
        parent = checkedParent(await source.selectChild(child.id, signal));
      confirmParent(parent, initial, child.id);
      add(
        {
          kind: "child",
          sourceId: child.id,
          childIds: [],
          data: { id: child.id, name: child.name },
        },
        child.id,
      );

      const timetableFeed = timetableSchema
        .nullable()
        .parse(await source.readTimetable(parent, signal));

      skippedByFeed.timetable += timetableFeed?.skipped ?? 0;
      const timetable = timetableFeed?.items ?? null;

      const sortedTimetable =
        timetable?.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) ?? null;

      add(
        { kind: "timetable", sourceId: "timetable", childIds: [], data: sortedTimetable },
        child.id,
      );

      skippedByFeed.messages += await collectMessagesForChild(
        source,
        child.id,
        input.maxMessagePages,
        signal,
        previousItems,
        add,
        addKnownFingerprint,
      );

      const notificationFeed = notificationsDataSchema.parse(await source.getNotifications(signal));
      skippedByFeed.notifications += notificationFeed.skipped;

      for (const item of notificationFeed.notifications) {
        const sourceId = JSON.stringify([item.pupilSourceId, item.id]);
        const { currentlySelectedPupil: _currentlySelectedPupil, ...summary } = item;
        const summaryHash = hash(JSON.stringify(summary));
        const previous = previousItems.get(
          fingerprintLookupKey("notification", sourceId, child.id),
        );

        if (previous?.summaryHash === summaryHash) {
          addKnownFingerprint({ ...previous, summaryHash });
          continue;
        }

        const resolutionKey = JSON.stringify([sourceId, summaryHash]);
        let detailPromise = resolvedNotificationCache.get(resolutionKey);
        if (!detailPromise) {
          detailPromise = resolveCollectedNotification(item, source, signal);
          resolvedNotificationCache.set(resolutionKey, detailPromise);
        }
        const data = await detailPromise;

        add(
          {
            kind: "notification",
            sourceId,
            childIds: [],
            data,
          },
          child.id,
          { summaryHash },
        );
      }

      confirmParent(checkedParent(await source.getParent(signal)), initial, child.id);
    }

    confirmParent(checkedParent(await source.getParent(signal)), initial);
  } catch (error) {
    collectionError =
      error instanceof InfoMentorError
        ? error
        : new InfoMentorError(
            "UNEXPECTED_PAGE",
            "InfoMentor returned unsupported collection data. No cursor was advanced.",
          );
  } finally {
    if (originalChild !== undefined) {
      const restoreSignal = AbortSignal.timeout(20_000);

      try {
        let parent = checkedParent(await source.getParent(restoreSignal));

        if (
          accountHash(parent) !== owner ||
          !parent.account.pupils.some((child) => child.id === originalChild)
        )
          changedSelection();

        if (selectedChild(parent) !== originalChild)
          parent = checkedParent(await source.selectChild(originalChild, restoreSignal));

        if (accountHash(parent) !== owner || selectedChild(parent) !== originalChild)
          changedSelection();
        parent = checkedParent(await source.getParent(restoreSignal));

        if (accountHash(parent) !== owner || selectedChild(parent) !== originalChild)
          changedSelection();
      } catch (error) {
        const restoreError = error instanceof InfoMentorError ? error : undefined;
        collectionError = new InfoMentorError(
          collectionError?.code ?? restoreError?.code ?? "UNEXPECTED_PAGE",
          "InfoMentor could not confirm restoration of the original child. No cursor was advanced. Check the overview before continuing.",
          collectionError?.retryAfterMs ?? restoreError?.retryAfterMs,
        );
      }
    }
  }

  if (collectionError) throw collectionError;
  throwIfAborted(signal);

  const incompleteFeeds = new Set(feedNames.filter((feed) => skippedByFeed[feed] > 0));

  for (const [key, update] of updates) {
    const feed = feedForKind[update.kind];

    if (feed !== undefined && incompleteFeeds.has(feed)) updates.delete(key);
  }

  const nextBaseline = new Map(
    [...current].filter(([, item]) => {
      const feed = feedForKind[item.kind];

      return feed === undefined || !incompleteFeeds.has(feed);
    }),
  );

  for (const [key, item] of previousItems) {
    const feed = feedForKind[item.kind];

    if (feed !== undefined && incompleteFeeds.has(feed)) nextBaseline.set(key, item);
  }

  const missing = new Map<string, Collection["missing"][number]>();

  for (const [key, item] of previousItems) {
    const feed = feedForKind[item.kind];

    if (feed !== undefined && incompleteFeeds.has(feed)) continue;

    if (current.has(key)) continue;
    const groupedKey = referenceKey(item);
    const grouped = missing.get(groupedKey);

    if (grouped) grouped.childIds.push(item.childId);
    else {
      const reference: Collection["missing"][number] = {
        kind: item.kind,
        sourceId: item.sourceId,
        childIds: [item.childId],
      };

      if (item.folder !== undefined) reference.folder = item.folder;
      missing.set(groupedKey, reference);
    }
  }

  const unchanged =
    previous &&
    nextBaseline.size === previousItems.size &&
    [...nextBaseline].every(([key, item]) => {
      const prior = previousItems.get(key);
      return prior !== undefined && fingerprintsEqual(prior, item);
    });
  const baselineNeedsUpgrade =
    previous &&
    [...current].some(([key, item]) => {
      const prior = previousItems.get(key);
      return prior?.summaryHash === undefined && item.summaryHash !== undefined;
    });

  const cursor = unchanged && input.cursor ? input.cursor : randomUUID();

  const output = collectionSchema.parse({
    baseline: !previous,
    cursor,
    retrievedAt: new Date().toISOString(),
    skipped: Object.values(skippedByFeed).reduce((total, count) => total + count, 0),
    skippedByFeed,
    children: initial.account.pupils.map(({ id, name }) => ({ id, name })),
    updates: [...updates.values()],
    missing: [...missing.values()],
  });

  if (Buffer.byteLength(JSON.stringify(output)) > MAX_BYTES)
    throw new InfoMentorError(
      "UNEXPECTED_PAGE",
      "The collection exceeds the supported response size. No cursor was advanced.",
    );

  try {
    if (!unchanged || baselineNeedsUpgrade)
      await saveSnapshot(
        directory,
        cursor,
        { version: 1, accountHash: owner, fingerprints: [...nextBaseline.values()] },
        signal,
      );

    if (input.cursor) await utimes(join(directory, input.cursor + ".json"), new Date(), new Date());
  } catch (error) {
    throwIfAborted(signal);

    if (error instanceof InfoMentorError) throw error;
    throw new InfoMentorError(
      "INVALID_CONFIGURATION",
      "Cannot save the collection cursor. Check the session directory permissions.",
    );
  }

  await pruneSnapshots(directory).catch(() => {});

  return output;
}
