import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computerSpaces, computerSpaceState, computerSummary, spaceRowRefusal, spaceStateKnown, surfaceState, type SurfaceState } from "../src/model.ts";

test("computer list follows desired intent while retaining connected local spaces", () => {
  const desired = { space: "mine", desired: true, observed: "starting" };
  const local = { space: "legacy", desired: false, observed: "connected" };
  assert.deepEqual(computerSpaces({ spaces: [desired, local] }), [desired, local]);
  assert.deepEqual(computerSpaces({ spaces: [{ ...desired, desired: false, observed: "disconnected" }, local] }), [local]);
  assert.deepEqual(computerSpaces({ spaces: [desired, local] }).map(row => row.space), ["mine", "legacy"]);
});

test("computer rows use observed account state and actionable refusal", () => {
  const row = { space: "mine", desired: true, observed: "connected" };
  assert.equal(computerSpaceState(row), "Starting");
  assert.equal(computerSpaceState(row, true), "Connected");
  assert.equal(computerSpaceState({ ...row, observed: "approval-pending" }), "Waiting for owner approval");
  assert.equal(computerSpaceState({ ...row, observed: "removed on this computer" }), "Removed on this computer");
  // A space that was just turned on reports not-requested until its Manager has booted.
  for (const observed of ["not-requested", "connecting", "starting", "restarting"]) assert.equal(computerSpaceState({ ...row, observed }), "Starting");
  assert.equal(computerSpaceState({ ...row, observed: "stopping" }), "Stopping");
  assert.equal(computerSpaceState({ ...row, observed: "refused" }), "Refused");
  assert.equal(computerSpaceState({ ...row, observed: "ended" }), "Ended by the space");
  assert.equal(computerSpaceState({ ...row, observed: "credential-expired" }), "Credential expired");
  assert.equal(computerSpaceState({ ...row, observed: "disconnected" }), "Disconnected");
  // A Manager that lost its connection reconnects by itself; the row says why it is not connected.
  assert.equal(computerSpaceState({ ...row, observed: "offline" }), "No internet connection");
  assert.equal(computerSpaceState({ ...row, observed: "unreachable" }), "Can't reach this space");
  assert.equal(computerSpaceState({ ...row, lastRefusal: "Ask the owner to approve this computer." }), "Ask the owner to approve this computer.");
  assert.equal(computerSpaceState({ ...row, observed: "refused", lastRefusal: "Ask the owner." }), "Ask the owner.");
  const heldRow = { ...row, lastRefusal: "The local space connection is held by https://cloud.cotal.ai/api/auth." };
  assert.equal(computerSpaceState(heldRow), heldRow.lastRefusal);
  assert.deepEqual(spaceRowRefusal(heldRow), {
    text: heldRow.lastRefusal,
    action: "remove",
    label: "Remove",
  });
  assert.deepEqual(spaceRowRefusal({ ...heldRow, custodyRecovery: { holder: "https://cloud.cotal.ai/api/auth", candidate: "b".repeat(64) } }), {
    text: heldRow.lastRefusal,
    action: "recover",
    label: "Use signed-in account",
  });
  assert.deepEqual(spaceRowRefusal(heldRow, {
    fromIdp: "https://cloud.cotal.ai/api/auth",
    toIdp: "https://cotal.cloud/api/auth",
    spaces: ["mine"],
  }), {
    text: "This space is set up under another sign-in on this computer.",
    action: "move",
    label: "Move to this account",
  });
});

test("window title and tray share one summary of the listed spaces", () => {
  const row = { space: "mine", desired: true, observed: "connecting" };
  assert.equal(computerSummary([], false), "idle");
  assert.equal(computerSummary([{ ...row, desired: false, observed: "removed on this computer" }], false), "idle");
  assert.equal(computerSummary([row], false), "starting");
  // Turning a space on, and a Manager winding down, are not failures.
  assert.equal(computerSummary([{ ...row, observed: "not-requested" }], false), "starting");
  assert.equal(computerSummary([{ ...row, observed: "stopping" }], false), "starting");
  assert.equal(computerSummary([{ ...row, observed: "refused" }], false), "attention");
  assert.equal(computerSummary([row, { ...row, space: "other", observed: "disconnected" }], false), "starting");
  // The row shows the saved refusal, so the title and tray must not say Starting.
  assert.equal(computerSummary([{ ...row, lastRefusal: "Manager is not answering" }], false), "attention");
  assert.equal(computerSummary([{ ...row, observed: "refused" }], true), "connected");
  // A lost connection names itself before other problems, because it can cause them.
  assert.equal(computerSummary([{ ...row, observed: "offline" }], false), "offline");
  assert.equal(computerSummary([{ ...row, observed: "unreachable" }], false), "unreachable");
  assert.equal(computerSummary([{ ...row, observed: "refused" }, { ...row, space: "other", observed: "unreachable" }, { ...row, space: "third", observed: "offline" }], false), "offline");
  assert.equal(computerSummary([{ ...row, observed: "refused" }, { ...row, space: "other", observed: "unreachable" }], false), "unreachable");
  assert.equal(computerSummary([{ ...row, observed: "offline" }], true), "connected");
});

test("every space state the daemon can report has a decided label", () => {
  const protocol = readFileSync(new URL("../../bin/daemon/protocol.ts", import.meta.url), "utf8");
  const members = (declaration: RegExp) => [...(declaration.exec(protocol)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(match => match[1]!);
  const service = members(/export type ServiceConnectionState =([^;]+);/);
  const manager = members(/export interface HostedManager \{[\s\S]*?\n  readonly state: ([^;]+);/);
  const connection = members(/export interface ManagerConnection \{[\s\S]*?\n  readonly state: ([^;]+);/);
  assert.equal(service.length, 16);
  assert.equal(manager.length, 6);
  assert.deepEqual(connection, ["offline", "unreachable"]);
  // The daemon reports an answering Manager as connected, and a lost connection by its kind.
  const reported = [...new Set([...service, ...manager.filter(state => state !== "answering"), ...connection])];
  assert.equal(reported.length, 22);
  assert.deepEqual(reported.filter(state => !spaceStateKnown(state)), []);
  assert.equal(spaceStateKnown("a state added later"), false);
});

test("Connection title and sidebar word/dot use the canonical tray state table", () => {
  const row = { space: "mine", desired: true, observed: "connected" };
  const idle = { rows: [], anyConnected: false };
  const desired = (observed: string) => ({ ...idle, rows: [{ ...row, observed }] });
  const cases: readonly (readonly [Parameters<typeof surfaceState>[0], SurfaceState["word"], SurfaceState["dot"], string])[] = [
    [{ rows: [row], anyConnected: true }, "Connected", "ok", "This computer is connected"],
    [desired("starting"), "Starting", "waiting", "This computer is starting"],
    [desired("offline"), "Offline", "problem", "No internet connection"],
    [desired("unreachable"), "Can't connect", "problem", "Can't reach your space"],
    [{ ...idle, signInRequired: true }, "Sign in required", "problem", "Sign in to keep this computer connected"],
    [{ ...idle, service: "stopped" }, "Service stopped", "problem", "The background service is stopped"],
    [{ ...idle, anyConnected: true, updating: true }, "Updating", "waiting", "Cotal is updating"],
    [{ ...idle, service: "not-set-up" }, "Not set up", "waiting", "This computer is not set up"],
    [{ ...idle, anyConnected: true, diskFull: true }, "Disk full", "problem", "Your disk is full"],
    [{ ...idle, repairNeeded: true }, "Repair needed", "problem", "This computer needs a repair"],
    [{ ...idle, rows: [{ ...row, lastRefusal: "Ask the owner" }, { ...row, space: "other", observed: "refused" }] }, "Can't connect", "problem", "Can't connect to your spaces"],
    [{ ...idle, starting: true }, "Starting", "waiting", "This computer is starting"],
    [{ ...idle, rows: [{ ...row, desired: false, observed: "removed on this computer" }] }, "Connected", "ok", "No space is using this computer"],
    [idle, "Connected", "ok", "This computer is connected to your account"],
  ];
  assert.equal(new Set(cases.map(([, word]) => word)).size, 10);
  for (const [input, word, dot, title] of cases) {
    const actual = surfaceState(input);
    assert.deepEqual([actual.word, actual.dot, actual.title], [word, dot, title]);
  }
  assert.equal(surfaceState({ ...idle, diskFull: true }).description, "Free up space on this computer. Cotal continues by itself once there is room.");
  assert.equal(surfaceState({ ...idle, service: "stopped" }).description, "You stopped the background service. Start it to run agents on this computer again.");
});
