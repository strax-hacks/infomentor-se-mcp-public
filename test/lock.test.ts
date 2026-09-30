import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { setImmediate as immediate } from "node:timers/promises";
import { withSessionLock } from "../src/lock.js";
import { InfoMentorError } from "../src/session.js";

const busy = (error: Error): boolean =>
  error instanceof InfoMentorError && error.code === "OPERATION_IN_PROGRESS";

const failFast = { waitMs: 0 };

test("session locks exclude live owners, recover dead owners safely, and release only their token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-lock-"));
  const file = join(directory, "session.json");
  const lock = `${file}.lock`;

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
    stdio: "ignore",
  });

  const childExit = once(child, "exit");

  try {
    await once(child, "spawn");
    assert.ok(child.pid);
    const childOwner = `${child.pid}-${randomUUID()}`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, childOwner), "", { mode: 0o600 });
    await assert.rejects(
      withSessionLock(file, undefined, async () => assert.fail(), failFast),
      busy,
    );
    assert.deepEqual(await readdir(lock), [childOwner]);

    child.kill();
    await childExit;

    // Concurrent stale recovery must not delete the first newly acquired owner's directory.
    let release: (() => void) | undefined;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let entered = 0;
    let attempted = 0;
    let allAttempted: (() => void) | undefined;

    const attemptsFinished = new Promise<void>((resolve) => {
      allAttempted = resolve;
    });

    const attempts = Array.from({ length: 12 }, async () => {
      try {
        return await withSessionLock(
          file,
          undefined,
          async () => {
            entered++;
            attempted++;

            if (attempted === 12) allAttempted?.();
            const owners = await readdir(lock);
            assert.equal(owners.length, 1);

            if (process.platform !== "win32") {
              const owner = owners[0];
              assert.ok(owner);
              assert.equal((await stat(lock)).mode & 0o777, 0o700);
              assert.equal((await stat(join(lock, owner))).mode & 0o777, 0o600);
            }

            await held;
            await assert.rejects(
              withSessionLock(file, undefined, async () => assert.fail(), failFast),
              busy,
            );

            return "collected";
          },
          failFast,
        );
      } catch (error) {
        attempted++;

        if (attempted === 12) allAttempted?.();
        throw error;
      }
    });

    const settled = Promise.allSettled(attempts);
    await attemptsFinished;
    assert.equal(entered, 1);
    release?.();
    const results = await settled;
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);

    for (const result of results)
      if (result.status === "rejected")
        assert.ok(
          result.reason instanceof InfoMentorError &&
            result.reason.code === "OPERATION_IN_PROGRESS",
        );
    assert.deepEqual(await readdir(directory), []);

    await assert.rejects(
      withSessionLock(file, undefined, async () => {
        throw new Error("Action failed");
      }),
      /Action failed/,
    );
    assert.deepEqual(await readdir(directory), []);

    await mkdir(lock, { mode: 0o700 });
    assert.equal(
      await withSessionLock(file, undefined, async () => "empty recovered"),
      "empty recovered",
    );
    assert.deepEqual(await readdir(directory), []);

    await assert.rejects(
      withSessionLock(file, AbortSignal.abort(), async () => assert.fail()),
      (error: Error) => error instanceof InfoMentorError && error.code === "CANCELLED",
    );
    assert.deepEqual(await readdir(directory), []);

    const controller = new AbortController();
    await assert.rejects(
      withSessionLock(file, controller.signal, async () => {
        controller.abort();
        throw new InfoMentorError(
          "CANCELLED",
          "Collection could not confirm restoration of the original child.",
        );
      }),
      /could not confirm restoration/,
    );

    if (process.platform !== "win32") {
      await mkdir(join(directory, "real"));
      await symlink("real", join(directory, "alias"), "dir");
      await withSessionLock(join(directory, "real", "session.json"), undefined, async () => {
        await assert.rejects(
          withSessionLock(
            join(directory, "alias", "session.json"),
            undefined,
            async () => assert.fail(),
            failFast,
          ),
          busy,
        );
      });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childExit;
    await rm(directory, { recursive: true, force: true });
  }
});

test("session locks wait a bounded time for another process and cancel while waiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-lock-wait-"));
  const file = join(directory, "session.json");

  try {
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;

    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = withSessionLock(file, undefined, async () => {
      entered?.();
      await held;

      return "held";
    });

    await holding;
    await assert.rejects(
      withSessionLock(file, undefined, async () => assert.fail(), failFast),
      busy,
    );
    await assert.rejects(
      withSessionLock(file, undefined, async () => assert.fail(), { waitMs: 1000 }),
      busy,
    );

    const controller = new AbortController();

    const cancelled = assert.rejects(
      withSessionLock(file, controller.signal, async () => assert.fail(), { waitMs: 10_000 }),
      (error: Error) => error instanceof InfoMentorError && error.code === "CANCELLED",
    );

    await immediate();
    controller.abort();
    await cancelled;

    const waiter = withSessionLock(file, undefined, async () => "waited", { waitMs: 10_000 });
    await immediate();
    release?.();
    assert.equal(await holder, "held");
    assert.equal(await waiter, "waited");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
