import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { z } from "zod";
import { CookieJar } from "tough-cookie";
import { InfoMentorClient } from "../src/client.js";
import { captureSession, writeSession } from "../src/session.js";

const baseRow = {
  timeRegistrationId: 7001001,
  date: "2025-01-24T00:00:00",
  startDateTime: "2025-01-24T08:00:00",
  endDateTime: "2025-01-24T17:15:00",
  onLeave: false,
  isLocked: false,
  isSchoolClosed: false,
  canEdit: true,
  hasUnreadComments: false,
  hasComments: false,
  canEditComment: true,
  schoolOpeningTime: "2025-01-24T06:15:00",
  schoolClosingTime: "2025-01-24T17:15:00",
};

type SavePayload = z.infer<typeof savePayloadSchema>;

const savePayloadSchema = z.object({
  days: z.array(
    z
      .object({
        startDateTime: z.string(),
        endDateTime: z.string(),
      })
      .passthrough(),
  ),
  series: z.null(),
});

async function withClient(
  mutate: (row: typeof baseRow) => typeof baseRow = (row) => row,
  onSave: (payload: SavePayload) => void = () => {},
  persistSave = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-fritid-write-"));
  const sessionFile = join(directory, "session.json");
  const saved = captureSession(new CookieJar());
  saved.accountId = "parent";
  saved.selectedChildId = "child-1";
  await writeSession(saved, sessionFile);
  let row = mutate({ ...baseRow });

  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";

    if (url.pathname === "/" && method === "GET") {
      const parent = {
        account: {
          currentUser: { id: "parent" },
          pupils: [{ id: "child-1", name: "Child", selected: true, switchPupilUrl: null }],
        },
        apps: [{ codeName: "timeregistration" }],
      };

      return new Response(
        `<script>IMHome.home.homeData = ${JSON.stringify(parent)}; IMHome.home.init(IMHome.home.homeData);</script>`,
      );
    }

    if (
      url.pathname === "/TimeRegistration/TimeRegistration/GetTimeRegistrations/" &&
      method === "POST"
    )
      return Response.json({
        startDate: "2025-01-20T00:00:00",
        endDate: "2025-01-26T00:00:00",
        days: [row],
      });

    if (
      url.pathname === "/TimeRegistration/TimeRegistration/SaveTimeRegistrations/" &&
      method === "POST"
    ) {
      const payload = savePayloadSchema.parse(
        JSON.parse(await new Response(init?.body ?? null).text()),
      );

      onSave(payload);
      const next = payload.days[0];

      if (persistSave && next)
        row = {
          ...row,
          startDateTime: next.startDateTime,
          endDateTime: next.endDateTime,
          onLeave: false,
        };

      return Response.json({ success: true, notifications: [] });
    }

    return new Response("unexpected", { status: 404 });
  };

  return {
    client: new InfoMentorClient({ sessionFile, fetch: fetcher }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("setFritidsschemaTimes writes JSON and verifies the exact persisted times", async () => {
  let payload: SavePayload | undefined;

  const { client, cleanup } = await withClient(
    (row) => row,
    (value) => (payload = value),
  );

  try {
    const result = await client.setFritidsschemaTimes({
      childId: "child-1",
      date: "2025-01-24",
      startTime: "08:30",
      endTime: "16:45",
    });

    assert.equal(result.verified, true);
    assert.equal(result.changed, true);
    assert.equal(result.startTime, "08:30");
    assert.equal(result.endTime, "16:45");
    assert.equal(result.endTimeNextDay, false);
    assert.ok(payload);
    assert.equal(payload.series, null);
    const savedDay = payload.days[0];
    assert.ok(savedDay);
    assert.equal(savedDay.startDateTime, "2025-01-24T08:30:00");
  } finally {
    await client.close();
    await cleanup();
  }
});

test("setFritidsschemaTimes supports an explicit overnight end date", async () => {
  const { client, cleanup } = await withClient();

  try {
    const result = await client.setFritidsschemaTimes({
      childId: "child-1",
      date: "2025-01-24",
      startTime: "22:00",
      endTime: "01:00",
      endTimeNextDay: true,
    });

    assert.equal(result.endDateTime, "2025-01-25T01:00:00");
    assert.equal(result.endTimeNextDay, true);
  } finally {
    await client.close();
    await cleanup();
  }
});

test("setFritidsschemaTimes rejects a non-editable row without writing", async () => {
  let writes = 0;

  const { client, cleanup } = await withClient(
    (row) => ({ ...row, canEdit: false }),
    () => writes++,
  );

  try {
    await assert.rejects(
      client.setFritidsschemaTimes({
        childId: "child-1",
        date: "2025-01-24",
        startTime: "08:30",
        endTime: "16:45",
      }),
      /cannot be edited/,
    );
    assert.equal(writes, 0);
  } finally {
    await client.close();
    await cleanup();
  }
});

test("setFritidsschemaTimes fails closed when read-back does not match", async () => {
  const { client, cleanup } = await withClient(
    (row) => row,
    () => {},
    false,
  );

  try {
    await assert.rejects(
      client.setFritidsschemaTimes({
        childId: "child-1",
        date: "2025-01-24",
        startTime: "08:30",
        endTime: "16:45",
      }),
      /could not be verified/,
    );
  } finally {
    await client.close();
    await cleanup();
  }
});
