import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { CookieJar } from "tough-cookie";
import { InfoMentorClient } from "../src/client.js";
import { captureSession, writeSession } from "../src/session.js";

const schedule = {
  timeRegistrationId: 7001001,
  date: "2025-01-24T00:00:00",
  startDateTime: "2025-01-24T08:00:00",
  endDateTime: "2025-01-24T17:15:00",
  onLeave: false,
  isLocked: false,
  isSchoolClosed: false,
  canEdit: false,
  hasUnreadComments: false,
  hasComments: false,
  canEditComment: true,
};

test("public fritidsschema client read selects the child and returns entered times", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-fritid-read-"));
  const sessionFile = join(directory, "session.json");
  const saved = captureSession(new CookieJar());
  saved.accountId = "parent";
  saved.selectedChildId = "child-1";
  await writeSession(saved, sessionFile);

  let selectedChild = "child-1";

  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";

    if (url.pathname === "/" && method === "GET") {
      const pupils = [
        {
          id: "child-1",
          name: "First child",
          selected: selectedChild === "child-1",
          switchPupilUrl: "/Account/PupilSwitcher/SwitchPupil/101",
        },
        {
          id: "child-2",
          name: "Second child",
          selected: selectedChild === "child-2",
          switchPupilUrl: "/Account/PupilSwitcher/SwitchPupil/102",
        },
      ];

      const parent = {
        account: { currentUser: { id: "parent" }, pupils },
        apps: [{ codeName: "timeregistration" }],
      };

      return new Response(
        `<script>IMHome.home.homeData = ${JSON.stringify(parent)}; IMHome.home.init(IMHome.home.homeData);</script>`,
      );
    }

    if (/^\/Account\/PupilSwitcher\/SwitchPupil\/\d+$/.test(url.pathname) && method === "GET") {
      selectedChild = url.pathname.endsWith("/102") ? "child-2" : "child-1";

      return new Response(null, {
        status: 302,
        headers: { Location: "https://hub.infomentor.se/" },
      });
    }

    if (
      url.pathname === "/TimeRegistration/TimeRegistration/GetTimeRegistrations/" &&
      method === "POST"
    )
      return Response.json({
        startDate: "2025-01-20T00:00:00",
        endDate: "2025-01-26T00:00:00",
        days: [schedule, { malformed: true }],
      });

    return new Response("unexpected", { status: 404 });
  };

  try {
    const client = new InfoMentorClient({ sessionFile, fetch: fetcher });

    try {
      const result = await client.getFritidsschema({ childId: "child-2", date: "2025-01-24" });

      assert.equal(selectedChild, "child-2");
      assert.deepEqual(
        {
          childId: result.childId,
          date: result.date,
          timeRegistrationId: result.timeRegistrationId,
          startTime: result.startTime,
          endTime: result.endTime,
          skipped: result.skipped,
        },
        {
          childId: "child-2",
          date: "2025-01-24",
          timeRegistrationId: 7001001,
          startTime: "08:00",
          endTime: "17:15",
          skipped: 1,
        },
      );
    } finally {
      await client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
