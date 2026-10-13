import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { CookieJar } from "tough-cookie";
import { InfoMentorClient } from "../src/client.js";
import { captureSession, writeSession } from "../src/session.js";

const notification = {
  id: 9001101,
  title: "Synthetic week",
  subTitle: "",
  subjectsCourses: "",
  dateSent: "2025-01-02T10:00:00",
  appType: "CalendarV2",
  state: "New",
  type: "CalendarV2",
  url: "/#/calendarv2/whole_week?selectedYear=2025&selectedWeek=2",
  pupilIM2Id: 9003101,
  pupilSourceId: "synthetic-school|child-1",
  currentlySelectedPupil: false,
};
const row = {
  id: 70001,
  title: "Synthetic lesson",
  text: "<p>Synthetic description</p>",
  startDateFull: "2025-01-08T09:00:00",
  endDateFull: "2025-01-08T10:00:00",
  startDate: "2025-01-08",
  endDate: "2025-01-08",
};
async function fixture(
  run: (client: InfoMentorClient, state: { selected: string; reads: number }) => Promise<void>,
  entries: unknown[] = [row],
  item = notification,
  fault: "none" | "selection" | "restoration" | "account" | "drift" | "feed" = "none",
) {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-week-"));
  const sessionFile = join(directory, "session.json");
  const saved = captureSession(new CookieJar());
  saved.accountId = "parent";
  saved.selectedChildId = "child-2";
  await writeSession(saved, sessionFile);
  const state = { selected: "child-2", reads: 0 };
  const parentHtml = () => {
    const pupils = ["child-1", "child-2"].map((id, index) => ({
      id,
      name: `Synthetic ${index}`,
      selected: state.selected === id,
      switchPupilUrl: `/Account/PupilSwitcher/SwitchPupil/${index + 101}`,
    }));
    return `<script>IMHome.home.homeData = ${JSON.stringify({ account: { currentUser: { id: fault === "account" && state.reads ? "other-account" : "parent" }, pupils }, apps: [] })}; IMHome.home.init(IMHome.home.homeData);</script>`;
  };
  const client = new InfoMentorClient({
    sessionFile,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/") return new Response(parentHtml());
      if (url.pathname.includes("SwitchPupil")) {
        if (
          (fault === "selection" && url.pathname.endsWith("101")) ||
          (fault === "restoration" && url.pathname.endsWith("102"))
        )
          return new Response("Synthetic selection failure");
        state.selected = url.pathname.endsWith("101") ? "child-1" : "child-2";
        return new Response(null, {
          status: 302,
          headers: { Location: "https://hub.infomentor.se/" },
        });
      }
      if (url.pathname.includes("NotificationApp")) return Response.json({ notifications: [item] });
      if (url.pathname === "/calendarv2/calendarv2/getentries") {
        assert.equal(init?.method, "POST");
        assert.equal(state.selected, "child-1");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          startDate: "2025-01-06",
          endDate: "2025-01-12",
        });
        state.reads++;
        if (fault === "drift") state.selected = "child-2";
        if (fault === "feed") return Response.json({ malformed: true });
        return Response.json(entries);
      }
      return new Response("unexpected", { status: 404 });
    },
  });
  try {
    await run(client, state);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("whole-week rejects selection drift during the authenticated feed read", async () => {
  await fixture(
    async (client) => {
      await assert.rejects(client.getCalendarWeek({ notificationId: notification.id }), {
        code: "INVALID_SESSION",
      });
    },
    [row],
    notification,
    "drift",
  );
});

test("an empty calendar week is a legitimate complete result", async () => {
  await fixture(async (client, state) => {
    const result = await client.getCalendarWeek({ notificationId: notification.id });
    assert.deepEqual(result.events, []);
    assert.equal(result.skipped, 0);
    assert.equal(state.selected, "child-2");
  }, []);
});

test("malformed calendar rows are counted rather than silently completing a week", async () => {
  await fixture(
    async (client) => {
      const result = await client.getCalendarWeek({ notificationId: notification.id });
      assert.equal(result.events.length, 1);
      assert.equal(result.skipped, 1);
      assert.equal(result.events[0]?.eventId, row.id);
    },
    [row, { id: "bad" }],
  );
});

test("whole-week rejects non-whole-week routes", async () => {
  await fixture(
    async (client, state) => {
      await assert.rejects(client.getCalendarWeek({ notificationId: notification.id }), {
        code: "UNEXPECTED_PAGE",
      });
      assert.equal(state.reads, 0);
      assert.equal(state.selected, "child-2");
    },
    [],
    { ...notification, url: "/#/calendarv2/day?selectedYear=2025&selectedWeek=2" },
  );
});

test("whole-week rejects malformed or absent explicit week parameters without date fallback", async () => {
  for (const suffix of [
    "selectedYear=bad&selectedWeek=2",
    "selectedYear=2025&selectedWeek=bad",
    "selectedYear=2025&selectedWeek=53",
    "selectedYear=2025&selectedWeek=0",
    "selectedYear=2025",
    "selectedWeek=2",
    "selectedYear=0000&selectedWeek=2",
    "selectedYear=2025&selectedYear=2026&selectedWeek=2",
  ]) {
    await fixture(
      async (client, state) => {
        await assert.rejects(client.getCalendarWeek({ notificationId: notification.id }));
        assert.equal(state.reads, 0);
        assert.equal(state.selected, "child-2");
      },
      [],
      { ...notification, url: `/#/calendarv2/whole_week?${suffix}` },
    );
  }
});

test("whole-week rejects non-calendar notification types even with a calendar app label", async () => {
  await fixture(
    async (client, state) => {
      await assert.rejects(client.getCalendarWeek({ notificationId: notification.id }), {
        code: "INVALID_CONFIGURATION",
      });
      assert.equal(state.reads, 0);
    },
    [],
    { ...notification, type: "NewsItem" },
  );
});

test("whole-week typed read retains exact row identities and restores the original child", async () => {
  await fixture(async (client, state) => {
    const result = await client.getCalendarWeek({ notificationId: notification.id });
    assert.equal(result.kind, "calendar_week");
    assert.equal(result.notification.id, notification.id);
    assert.equal(result.childId, "child-1");
    assert.equal(result.startDate, "2025-01-06");
    assert.equal(result.endDate, "2025-01-12");
    assert.deepEqual(
      result.events.map((event) => event.eventId),
      [70001],
    );
    assert.equal(result.events[0]?.text, "Synthetic description");
    assert.equal(result.skipped, 0);
    assert.equal(state.reads, 1);
    assert.equal(state.selected, "child-2");
  });
});
