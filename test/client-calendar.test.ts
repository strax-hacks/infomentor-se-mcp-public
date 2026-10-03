import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { CookieJar } from "tough-cookie";
import { InfoMentorClient } from "../src/client.js";
import { captureSession, writeSession } from "../src/session.js";

const parentHtml = (selectedChild: string): string => {
  const pupils = [
    {
      id: "child-1",
      name: "Child A",
      selected: selectedChild === "child-1",
      switchPupilUrl: "/Account/PupilSwitcher/SwitchPupil/101",
    },
    {
      id: "child-2",
      name: "Child B",
      selected: selectedChild === "child-2",
      switchPupilUrl: "/Account/PupilSwitcher/SwitchPupil/102",
    },
  ];
  const parent = { account: { currentUser: { id: "parent" }, pupils }, apps: [] };
  return `<script>IMHome.home.homeData = ${JSON.stringify(parent)}; IMHome.home.init(IMHome.home.homeData);</script>`;
};

const notification = {
  id: 9001001,
  title: "Ny kalenderhändelse",
  subTitle: "",
  subjectsCourses: "",
  dateSent: "2025-01-02T10:00:00",
  appType: "CalendarV2",
  state: "New",
  type: "CalendarV2EventCreated",
  url: "/#/calendarv2/whole_week?selectedYear=2025&selectedWeek=2&eventId=7654321",
  pupilIM2Id: 9003001,
  pupilSourceId: "synthetic-school|child-1",
  currentlySelectedPupil: false,
};

const calendarEvent = {
  id: 7654321,
  title: "Synthetic event",
  text: "<p>Bring the signed science worksheet to class.</p>",
  description: "<p>Bring the signed science worksheet to class.</p>",
  calendarEntryTypeId: 2,
  isAllDayEvent: true,
  startDateFull: "2025-01-08T00:00:00",
  endDateFull: "2025-01-09T00:00:00",
  startDate: "2025-01-08",
  endDate: "2025-01-09",
  formattedStartDate: "ons 08 jan",
  formattedEndDate: "ons 08 jan",
  startTime: "",
  endTime: "",
  hasAttachments: false,
  subjects: [{ id: 7001, title: "Science" }],
  courses: [],
  url: null,
};

test("CalendarV2 resolution selects the notification child, reads the selected week, and restores selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-calendar-client-"));
  const sessionFile = join(directory, "session.json");
  const saved = captureSession(new CookieJar());
  saved.accountId = "parent";
  saved.selectedChildId = "child-2";
  await writeSession(saved, sessionFile);

  let selectedChild = "child-2";
  const requests: Array<{ path: string; method: string; body: string }> = [];

  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ path: url.pathname, method, body });

    if (url.pathname === "/" && method === "GET") return new Response(parentHtml(selectedChild));

    if (/^\/Account\/PupilSwitcher\/SwitchPupil\/\d+$/.test(url.pathname) && method === "GET") {
      selectedChild = url.pathname.endsWith("/101") ? "child-1" : "child-2";
      return new Response(null, {
        status: 302,
        headers: { Location: "https://hub.infomentor.se/" },
      });
    }

    if (url.pathname === "/NotificationApp/NotificationApp/appData" && method === "POST")
      return Response.json({ notifications: [notification] });

    if (url.pathname === "/calendarv2/calendarv2/getentries" && method === "POST") {
      assert.equal(selectedChild, "child-1");
      assert.deepEqual(JSON.parse(body), { startDate: "2025-01-06", endDate: "2025-01-12" });
      return Response.json([calendarEvent]);
    }

    return new Response("unexpected", { status: 404 });
  };

  try {
    const client = new InfoMentorClient({ sessionFile, fetch: fetcher });
    try {
      const result = await client.getCalendarEvent({ notificationId: 9001001 });
      assert.equal(result.eventId, 7654321);
      assert.equal(result.title, "Synthetic event");
      assert.equal(result.subjects[0]?.title, "Science");
      assert.equal(result.text, "Bring the signed science worksheet to class.");
      assert.equal(result.startDate, "2025-01-08");
      assert.equal(result.isAllDayEvent, true);
      assert.equal(result.notification.pupilSourceId, notification.pupilSourceId);
      assert.equal(selectedChild, "child-2");
      assert.equal(
        requests.filter((request) => request.path === "/calendarv2/calendarv2/getentries").length,
        1,
      );
    } finally {
      await client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
