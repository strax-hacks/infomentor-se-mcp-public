import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { collectUpdates, collectionSchema, type CollectionSource } from "../src/collection.js";
import { InfoMentorError, throwIfAborted, type Notifications } from "../src/session.js";

const summary = (id: number) => ({
  id,
  messageContextType: "General",
  sentUser: { id: 2, displayName: "Synthetic teacher" },
  isNew: true,
  messageSubject: "Synthetic subject",
  timeSent: "2026-09-11T08:00:00",
});

function sourceFor(sessionFile: string) {
  const state = {
    selected: "first",
    account: "parent",
    body: "Private message body",
    removed: false,
    drift: false,
    restoreFails: false,
    expires: false,
    expired: false,
    abort: new AbortController(),
    cancel: false,
    duplicateNoticeId: false,
    renameDuringScan: false,
    detailReads: 0,
    skipped: { timetable: 0, messages: 0, notifications: 0 },
  };

  const children = [
    { id: "first", name: "Synthetic first child" },
    { id: "second", name: "Synthetic second child" },
  ];

  const source: CollectionSource = {
    sessionFile,
    async getParent(signal) {
      throwIfAborted(signal);

      if (state.expired) throw new InfoMentorError("LOGIN_REQUIRED", "Sign in again.");

      return {
        account: {
          currentUser: { id: state.account },
          pupils: children.map((child) => ({ ...child, selected: child.id === state.selected })),
        },
        apps: [{ codeName: "timetable" }],
      };
    },
    async selectChild(childId, signal) {
      throwIfAborted(signal);

      if (state.restoreFails && childId === "first")
        throw new InfoMentorError("NETWORK_ERROR", "Synthetic restoration failure.");
      state.selected = childId;

      return source.getParent(signal);
    },
    async readTimetable(parent, signal) {
      throwIfAborted(signal);
      const selected = parent.account.pupils.find((child) => child.selected)?.id;
      const skipped = selected === "first" ? state.skipped.timetable : 0;

      return {
        items: skipped
          ? []
          : [
              {
                start: "2026-09-11T09:00:00",
                end: "2026-09-11T10:00:00",
                title: "Synthetic timetable",
                startTime: "09:00",
                endTime: "10:00",
                notes: { roomInfo: "", timetableNotes: "", tutors: "" },
                allDay: false,
                establishmentName: "Synthetic school",
              },
            ],
        skipped,
      };
    },
    async getMessages(folder, page, signal) {
      throwIfAborted(signal);

      if (state.expires) {
        state.expired = true;
        throw new InfoMentorError("LOGIN_REQUIRED", "Sign in again.");
      }

      const id = folder === "sent" ? 21 : page === 1 ? 11 : 12;

      const skipped =
        state.selected === "first" && folder === "inbox" && page === 1 ? state.skipped.messages : 0;

      return {
        items: state.removed && id === 12 ? [] : skipped ? [] : [summary(id)],
        more: folder === "inbox" && page === 1,
        skipped,
      };
    },
    async getMessage(id, signal) {
      throwIfAborted(signal);
      state.detailReads++;

      return {
        ...summary(id),
        messageBodyPlainText: id === 11 ? state.body : "Other private body",
        toUsers: [{ id: 3, displayName: "Synthetic guardian" }],
        messageFolder: id === 21 ? "Sent" : "Inbox",
      };
    },
    async getNotifications(signal) {
      throwIfAborted(signal);

      if (state.drift) state.selected = "second";

      if (state.cancel && state.selected === "second") state.abort.abort();

      if (state.renameDuringScan && state.selected === "second") {
        const firstChild = children[0];

        if (firstChild) firstChild.name = "Updated child name";
      }

      const notice: Notifications["notifications"][number] = {
        id: 1,
        title: "Synthetic notice",
        subTitle: "",
        subjectsCourses: "",
        dateSent: "2026-09-11",
        appType: "Message",
        state: "Cleared",
        type: "MessageCreated",
        url: "/#/message/show/11",
        pupilIM2Id: 1,
        pupilSourceId: "first",
        currentlySelectedPupil: state.selected === "first",
      };

      const notices = [notice];

      if (state.duplicateNoticeId) notices.push({ ...notice, pupilSourceId: "second" });

      const skipped = state.selected === "first" ? state.skipped.notifications : 0;

      return { notifications: skipped ? [] : notices, skipped };
    },
  };

  return { source, state };
}

const subtest = async (_name: string, work: () => Promise<void>): Promise<void> => work();

test("collection snapshots replay deltas, preserve context, and fail without advancing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-collection-"));

  try {
    await subtest(
      "baseline, identical grouping, full body edits, replay, and missing references",
      async () => {
        const sessionFile = join(directory, "normal.json");
        const { source, state } = sourceFor(sessionFile);
        const baseline = await collectUpdates({}, source);
        collectionSchema.parse(baseline);
        assert.equal(baseline.baseline, true);
        assert.deepEqual(baseline.updates, []);
        assert.equal(state.detailReads, 6);
        assert.equal(state.selected, "first");

        const stored = await readFile(
          join(sessionFile + ".collections", baseline.cursor + ".json"),
          "utf8",
        );

        assert.doesNotMatch(
          stored,
          /Private message|Synthetic first|Synthetic timetable|Synthetic teacher/,
        );

        if (process.platform !== "win32") {
          assert.equal((await stat(sessionFile + ".collections")).mode & 0o777, 0o700);
          assert.equal(
            (await stat(join(sessionFile + ".collections", baseline.cursor + ".json"))).mode &
              0o777,
            0o600,
          );
        }

        const unchanged = await collectUpdates({ cursor: baseline.cursor }, source);
        assert.equal(unchanged.cursor, baseline.cursor);
        assert.equal(unchanged.baseline, false);
        assert.deepEqual(unchanged.updates, []);
        assert.equal(state.detailReads, 12);

        const existing = await collectUpdates({ includeExisting: true }, source);
        assert.equal(existing.updates.length, 7);
        const timetable = existing.updates.find((item) => item.kind === "timetable");
        assert.ok(timetable);
        assert.deepEqual(timetable.childIds, ["first", "second"]);
        const notification = existing.updates.find((item) => item.kind === "notification");
        assert.ok(notification);
        assert.deepEqual(notification.childIds, ["first", "second"]);
        assert.equal(notification.data.state, "Cleared");
        assert.ok(!("currentlySelectedPupil" in notification.data));

        state.duplicateNoticeId = true;
        const duplicateId = await collectUpdates({ cursor: baseline.cursor }, source);
        assert.equal(duplicateId.updates.length, 1);
        const duplicate = duplicateId.updates[0];
        assert.ok(duplicate);
        assert.equal(duplicate.kind, "notification");
        assert.equal(duplicate.sourceId, '["second",1]');
        assert.deepEqual(duplicate.childIds, ["first", "second"]);
        state.duplicateNoticeId = false;

        state.body = "Changed body with an unchanged summary";
        const delta = await collectUpdates({ cursor: baseline.cursor }, source);
        assert.notEqual(delta.cursor, baseline.cursor);
        assert.equal(delta.updates.length, 1);
        assert.equal(delta.updates[0]?.kind, "message");
        assert.deepEqual(delta.updates[0].childIds, ["first", "second"]);
        const replay = await collectUpdates({ cursor: baseline.cursor }, source);
        assert.deepEqual(replay.updates, delta.updates);
        assert.equal(
          await readFile(join(sessionFile + ".collections", baseline.cursor + ".json"), "utf8"),
          stored,
        );
        const accepted = await collectUpdates({ cursor: delta.cursor }, source);
        assert.deepEqual(accepted.updates, []);

        state.removed = true;
        const missing = await collectUpdates({ cursor: delta.cursor }, source);
        assert.deepEqual(missing.missing, [
          { kind: "message", sourceId: "12", folder: "inbox", childIds: ["first", "second"] },
        ]);
        assert.deepEqual(missing.updates, []);
      },
    );

    await subtest("pagination limit restores selection and writes no snapshot", async () => {
      const sessionFile = join(directory, "limit.json");
      const { source, state } = sourceFor(sessionFile);
      state.selected = "second";
      await assert.rejects(collectUpdates({ maxMessagePages: 1 }, source), /maxMessagePages/);
      assert.equal(state.selected, "second");
      await assert.rejects(stat(sessionFile + ".collections"), { code: "ENOENT" });
    });

    await subtest(
      "selection interference and cancellation restore with a fresh signal",
      async () => {
        const sessionFile = join(directory, "drift.json");
        const { source, state } = sourceFor(sessionFile);
        state.drift = true;
        await assert.rejects(collectUpdates({}, source), /selected child changed/);
        assert.equal(state.selected, "first");
        state.drift = false;
        state.cancel = true;
        source.signal = state.abort.signal;
        await assert.rejects(collectUpdates({}, source), { code: "CANCELLED" });
        assert.equal(state.selected, "first");
        await assert.rejects(stat(sessionFile + ".collections"), { code: "ENOENT" });
      },
    );

    await subtest(
      "restoration failure prevents a cursor and preserves authentication errors",
      async () => {
        const sessionFile = join(directory, "restore.json");
        const { source, state } = sourceFor(sessionFile);
        state.restoreFails = true;
        await assert.rejects(collectUpdates({}, source), /restoration of the original child/);
        await assert.rejects(stat(sessionFile + ".collections"), { code: "ENOENT" });
        state.restoreFails = false;
        state.selected = "first";
        state.expires = true;
        await assert.rejects(collectUpdates({}, source), { code: "LOGIN_REQUIRED" });
        await assert.rejects(stat(sessionFile + ".collections"), { code: "ENOENT" });
      },
    );

    await subtest(
      "account mismatch and expired cursors require an explicit new baseline",
      async () => {
        const sessionFile = join(directory, "account.json");
        const { source, state } = sourceFor(sessionFile);
        const baseline = await collectUpdates({}, source);
        state.account = "different-parent";
        await assert.rejects(collectUpdates({ cursor: baseline.cursor }, source), {
          code: "INVALID_CONFIGURATION",
        });
        assert.equal((await readdir(sessionFile + ".collections")).length, 1);
        state.account = "parent";
        const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
        await utimes(join(sessionFile + ".collections", baseline.cursor + ".json"), old, old);
        await assert.rejects(collectUpdates({ cursor: baseline.cursor }, source), {
          code: "INVALID_CONFIGURATION",
        });
      },
    );

    await subtest("oversized output fails without a snapshot", async () => {
      const sessionFile = join(directory, "large.json");
      const { source, state } = sourceFor(sessionFile);
      state.body = "x".repeat(8 * 1024 * 1024);
      await assert.rejects(collectUpdates({ includeExisting: true }, source), /response size/);
      assert.equal(state.selected, "first");
      await assert.rejects(stat(sessionFile + ".collections"), { code: "ENOENT" });
    });

    await subtest(
      "roster edits abort collection but still restore the available original child",
      async () => {
        const sessionFile = join(directory, "rename.json");
        const { source, state } = sourceFor(sessionFile);
        state.renameDuringScan = true;
        await assert.rejects(collectUpdates({}, source), /selected child changed/);
        assert.equal(state.selected, "first");
        await assert.rejects(stat(sessionFile + ".collections"), { code: "ENOENT" });
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collection reports skipped upstream items while retaining valid feed data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-collection-skipped-"));

  try {
    const { source, state } = sourceFor(join(directory, "session.json"));
    state.skipped.timetable = 1;
    const collection = await collectUpdates({ includeExisting: true }, source);

    collectionSchema.parse(collection);
    assert.equal(collection.skipped, 1);
    assert.deepEqual(collection.skippedByFeed, {
      timetable: 1,
      messages: 0,
      notifications: 0,
    });
    assert.ok(collection.updates.some((update) => update.kind === "message"));
    assert.ok(!collection.updates.some((update) => update.kind === "timetable"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial feeds preserve their baselines through unchanged recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-collection-partial-history-"));

  try {
    const sessionFile = join(directory, "session.json");
    const { source, state } = sourceFor(sessionFile);
    const baseline = await collectUpdates({}, source);

    state.skipped = { timetable: 1, messages: 1, notifications: 1 };
    const partial = await collectUpdates({ cursor: baseline.cursor }, source);

    assert.equal(partial.skipped, 3);
    assert.deepEqual(partial.skippedByFeed, {
      timetable: 1,
      messages: 1,
      notifications: 1,
    });
    assert.deepEqual(partial.missing, []);
    assert.deepEqual(partial.updates, []);
    assert.equal(partial.cursor, baseline.cursor);

    state.skipped = { timetable: 0, messages: 0, notifications: 0 };
    const recovered = await collectUpdates({ cursor: partial.cursor }, source);

    assert.equal(recovered.skipped, 0);
    assert.deepEqual(recovered.missing, []);
    assert.deepEqual(recovered.updates, []);
    assert.equal(recovered.cursor, baseline.cursor);

    const repeated = await collectUpdates({ cursor: recovered.cursor }, source);
    assert.deepEqual(repeated.missing, []);
    assert.deepEqual(repeated.updates, []);
    assert.equal(repeated.cursor, baseline.cursor);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
