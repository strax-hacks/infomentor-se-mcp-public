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

const messageSummary = {
  id: 7001001,
  messageContextType: "Parent",
  sentUser: { id: 9001, displayName: "School" },
  isNew: true,
  messageSubject: "Child-specific message",
  timeSent: "2026-10-04T08:00:00",
};

const notification = {
  id: 8001001,
  title: "Child-specific notice",
  subTitle: "Notice",
  subjectsCourses: "",
  dateSent: "2026-10-04T08:00:00",
  appType: "School",
  state: "New",
  type: "MessageCreated",
  url: "/#/communication/messages/7001001",
  pupilIM2Id: 9002,
  pupilSourceId: "school|child-2|TEST",
  currentlySelectedPupil: true,
};

test("context-dependent reads select and verify the requested child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-selection-"));
  const sessionFile = join(directory, "session.json");
  const saved = captureSession(new CookieJar());
  saved.accountId = "parent";
  saved.selectedChildId = "child-1";
  await writeSession(saved, sessionFile);

  let selectedChild = "child-1";
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";

    if (url.pathname === "/" && method === "GET") return new Response(parentHtml(selectedChild));

    if (/^\/Account\/PupilSwitcher\/SwitchPupil\/\d+$/.test(url.pathname) && method === "GET") {
      selectedChild = url.pathname.endsWith("/101") ? "child-1" : "child-2";
      return new Response(null, {
        status: 302,
        headers: { Location: "https://hub.infomentor.se/" },
      });
    }

    if (url.pathname === "/Message/message/GetMessages" && method === "POST") {
      assert.equal(selectedChild, "child-2");
      return Response.json({ items: [messageSummary], more: false });
    }

    if (url.pathname === "/Message/message/GetMessage" && method === "POST") {
      assert.equal(selectedChild, "child-1");
      return Response.json({
        ...messageSummary,
        messageBodyPlainText: "The full message body.",
        toUsers: [{ id: 9002, displayName: "Child A" }],
        messageFolder: "inbox",
      });
    }

    if (url.pathname === "/NotificationApp/NotificationApp/appData" && method === "POST") {
      assert.equal(selectedChild, "child-2");
      return Response.json({
        notifications: [{ ...notification, currentlySelectedPupil: selectedChild === "child-2" }],
      });
    }

    return new Response("unexpected", { status: 404 });
  };

  try {
    const client = new InfoMentorClient({ sessionFile, fetch: fetcher });

    try {
      const messages = await client.getMessages({ childId: "child-2" });
      assert.equal(messages.selectedChildId, "child-2");
      assert.equal(selectedChild, "child-2");

      const message = await client.getMessage({ id: messageSummary.id, childId: "child-1" });
      assert.equal(message.selectedChildId, "child-1");
      assert.equal(message.message.messageBodyPlainText, "The full message body.");
      assert.equal(selectedChild, "child-1");

      const notifications = await client.getNotifications({
        childId: "child-2",
        selectedChildOnly: true,
      });
      assert.equal(notifications.childId, "child-2");
      assert.equal(notifications.notifications.length, 1);
      assert.equal(selectedChild, "child-2");

      const overview = await client.getOverview({ childId: "child-1" });
      assert.equal(overview.children.find((child) => child.selected)?.id, "child-1");
      assert.equal(selectedChild, "child-1");
    } finally {
      await client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
