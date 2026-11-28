import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computerSpaces, computerSpaceState, computerSummary, SERVICE_START, spaceStateKnown, surfaceInputs, surfaceState, type SurfaceWord } from "../src/model.ts";

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
  assert.equal(computerSummary([row, { ...row, space: "other", observed: "disconnected" }], false), "attention");
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

test("one state feeds the window, the pill, the dot and the tray", () => {
  const row = { space: "mine", desired: true, observed: "connected" };
  const words: SurfaceWord[] = ["Connected", "Starting", "Offline", "Can't connect", "Sign in required", "Service stopped", "Updating", "Not set up", "Disk full", "Repair needed"];
  const cases: { name: string; input: Parameters<typeof surfaceState>[0]; word: SurfaceWord; dot: "ok" | "waiting" | "problem" }[] = [
    { name: "a space answers", input: { rows: [row], anyConnected: true }, word: "Connected", dot: "ok" },
    { name: "one refused row cannot make the computer connected", input: { rows: [row, { space: "other", desired: true, observed: "connected", lastRefusal: "The connector could not start." }], anyConnected: true }, word: "Connected", dot: "ok" },
    { name: "every desired row is refused", input: { rows: [{ space: "one", desired: true, observed: "connected", lastRefusal: "Held by another sign-in." }, { space: "two", desired: true, observed: "connected", lastRefusal: "Held by another sign-in." }], anyConnected: true }, word: "Can't connect", dot: "problem" },
    { name: "a space is starting", input: { rows: [{ ...row, observed: "starting" }], anyConnected: false }, word: "Starting", dot: "waiting" },
    { name: "the network is off", input: { rows: [{ ...row, observed: "offline" }], anyConnected: false }, word: "Offline", dot: "problem" },
    { name: "a space is not answering", input: { rows: [{ ...row, observed: "unreachable" }], anyConnected: false }, word: "Can't connect", dot: "problem" },
    { name: "sign-in is required", input: { rows: [], anyConnected: false, signInRequired: true }, word: "Sign in required", dot: "problem" },
    { name: "the service is stopped", input: { rows: [], anyConnected: false, service: "stopped" }, word: "Service stopped", dot: "problem" },
    { name: "an update is running", input: { rows: [row], anyConnected: true, updating: true }, word: "Updating", dot: "waiting" },
    { name: "nothing is set up", input: { rows: [], anyConnected: false, service: "not-set-up" }, word: "Not set up", dot: "waiting" },
    { name: "the disk is full", input: { rows: [row], anyConnected: true, diskFull: true }, word: "Disk full", dot: "problem" },
    { name: "a repair is reported", input: { rows: [row], anyConnected: true, repairNeeded: true }, word: "Repair needed", dot: "problem" },
    { name: "no space can run", input: { rows: [{ ...row, desired: false, observed: "removed on this computer" }], anyConnected: false }, word: "Connected", dot: "ok" },
  ];
  for (const item of cases) {
    const state = surfaceState(item.input);
    assert.equal(state.word, item.word, item.name);
    assert.equal(state.dot, item.dot, `${item.name} dot follows the word`);
    assert.equal(words.includes(state.word), true, `${item.name} uses one of the ten words`);
    assert.equal(/daemon|generation|Needs attention/.test(`${state.word} ${state.title}`), false, `${item.name} uses no internal word`);
  }
  assert.equal(cases.length, words.length + 3, "every word has a row, plus one refused beside a working space, every row refused, and the case where nothing can run");
  assert.equal(surfaceState({ rows: [], anyConnected: false, accountKnown: true }).title, "This computer is connected to your account", "signed in with no spaces keeps its title");
  assert.equal(surfaceState({ rows: [{ space: "mine", desired: false, observed: "removed on this computer" }], anyConnected: false }).title, "No space is using this computer", "the last space removed keeps the idle title");
  assert.equal(surfaceState({ rows: [], anyConnected: false, diskFull: true }).description, "Free up space on this computer. Cotal continues by itself once there is room.");
  assert.equal(surfaceState({ rows: [], anyConnected: false, service: "stopped" }).description, "You stopped the background service. Start it to run agents on this computer again.");
  assert.equal(surfaceState({ rows: [], anyConnected: false, signInRequired: true, computerRemoved: true }).description, "This computer was removed from your account. Sign in to add it back.");
  const frame = { diskFull: true, generation: { installed: "2", running: "1", waiting: "preparing" }, recovery: { code: "DAEMON_LOST" }, account: { mode: "sign-in-required", reason: "computer-removed" } };
  const read = surfaceInputs(frame, [row], true);
  assert.equal(read.diskFull && read.updating && read.repairNeeded && read.signInRequired && read.computerRemoved, true, "the frame's fields reach the shared state");
  const dropped = surfaceInputs({}, [row], true);
  assert.equal(dropped.diskFull || dropped.updating || dropped.repairNeeded || dropped.signInRequired, false, "a frame without the fields does not invent them");
  const bothRefused = [{ space: "one", desired: true, observed: "connected", lastRefusal: "Held." }, { space: "two", desired: true, observed: "connected", lastRefusal: "Held." }];
  const refused = surfaceInputs({ account: { spaces: bothRefused } }, bothRefused, true);
  assert.equal(refused.anyConnected, false, "answering Managers do not connect refused rows");
  assert.equal(surfaceState(refused).title, "Can't connect to your spaces");
  assert.deepEqual(SERVICE_START, { op: "start" }, "the stopped card and the tray send one Start request");
});
