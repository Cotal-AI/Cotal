import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computerSpaces, computerSpaceState, computerSummary, spaceRowRefusal, SERVICE_START, spaceStateKnown, surfaceInputs, surfaceState, type SurfaceWord, forTerminal } from "../src/model.ts";

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
  // A saved refusal is the service's own sentence; the row says the cause in plain words instead.
  assert.equal(computerSpaceState({ ...row, lastRefusal: "The local space connection is held by https://cloud.cotal.ai/api/auth." }), "This space is set up under another sign-in on this computer.");
  assert.equal(computerSpaceState({ ...row, observed: "refused", lastRefusal: "a refusal this app has never seen" }), "Can't connect this space.");
});

/** Every saved refusal the background service writes for an account space (bin/daemon/account-reconcile.ts). */
const SAVED_REFUSALS: Record<string, { text: string; action: string; label: string }> = {
  // Until the same-account move exists, a holder that still answers leaves Remove as the row's only action.
  "The local space connection is held by https://cloud.cotal.ai/api/auth.": { text: "This space is set up under another sign-in on this computer.", action: "remove", label: "Remove" },
  "The local space connection is held by an unknown account.": { text: "This space is set up under another sign-in on this computer.", action: "remove", label: "Remove" },
  "no available application": { text: "No agent app is installed.", action: "apps", label: "Set up agent apps" },
  "not-signed-in": { text: "Sign in again to use this space.", action: "sign-in", label: "Sign in" },
  "credential-expired": { text: "Sign in again to use this space.", action: "sign-in", label: "Sign in" },
  "not-user-auth": { text: "Sign in again to use this space.", action: "sign-in", label: "Sign in" },
  "Manager is not answering": { text: "Starting this space. Cotal keeps trying by itself.", action: "check", label: "Check again" },
  "unreachable": { text: "Can't reach this space. Cotal keeps trying by itself.", action: "check", label: "Check again" },
  "account space is currently unavailable": { text: "Can't reach this space. Cotal keeps trying by itself.", action: "check", label: "Check again" },
  "disconnect refused; inspect daemon status before retrying": { text: "Couldn't remove this space from this computer. Cotal keeps trying by itself.", action: "check", label: "Check again" },
  "local removal could not stop the space; inspect daemon status": { text: "Couldn't remove this space from this computer.", action: "check", label: "Check again" },
  "space connection refused; inspect daemon status": { text: "Can't connect this space.", action: "check", label: "Check again" },
  "not-registered": { text: "Can't connect this space.", action: "check", label: "Check again" },
  "refused": { text: "Can't connect this space.", action: "check", label: "Check again" },
  "local-state-error": { text: "Can't connect this space.", action: "check", label: "Check again" },
  "account-mismatch": { text: "Can't connect this space.", action: "check", label: "Check again" },
  "ended": { text: "Can't connect this space.", action: "check", label: "Check again" },
  // A refusal code no version of this app has mapped still ends in a true sentence and one action.
  "NEVER_SEEN_REFUSAL: run `cotal daemon setup --space mine` at https://example.test/x": { text: "Can't connect this space.", action: "check", label: "Check again" },
};
const RAW = /`|\bcotal [a-z]|https?:\/\/|\bdaemon\b|\bManager\b|inspect |;/;

test("each saved space refusal shows one plain sentence and one action, never the service's text", () => {
  const row = { space: "mine", desired: true, observed: "not-requested" };
  const views = Object.entries(SAVED_REFUSALS).map(([lastRefusal, expected]) => [spaceRowRefusal({ ...row, lastRefusal }), expected] as const);
  assert.equal(views.length, 18);
  for (const [view, expected] of views) assert.deepEqual(view, expected);
  assert.deepEqual(views.filter(([view]) => RAW.test(view.text) || RAW.test(view.label)), []);
  assert.equal(new Set(views.map(([view]) => view.text)).size, 8);
  // A confirmed custody recovery keeps its own button, and the row names no sign-in address.
  const recovery = spaceRowRefusal({ ...row, lastRefusal: "The local space connection is held by https://old.example/api/auth.", custodyRecovery: { holder: "https://old.example/api/auth", candidate: "b".repeat(64) } });
  assert.deepEqual(recovery, { text: "This space is set up under another sign-in on this computer.", action: "recover", label: "Move to this account" });
});

test("a daemon text that names a web address is for a terminal, so the window does not show it", () => {
  assert.equal(forTerminal("the service stopped at https://cloud.cotal.ai/api/auth"), true);
  assert.equal(forTerminal("The background service did not answer. Check the host connection before retrying."), false);
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
  assert.deepEqual(surfaceState({ rows: [], anyConnected: false, signedOut: true }), { word: "Not set up", dot: "waiting", title: "You signed out", description: "Sign in to use this computer from your spaces again." }, "deliberate sign-out uses Not set up and You signed out");
  assert.equal(surfaceState({ rows: [], anyConnected: false, signedOut: true, service: "stopped" }).word, "Service stopped", "a stopped service still names itself after sign-out");
  const signedOutInputs = surfaceInputs({ account: { mode: "signed-out", idpUrl: "https://cotal.cloud/api/auth", spaces: [] } }, [], false);
  assert.equal(signedOutInputs.signedOut && !signedOutInputs.signInRequired, true, "deliberate sign-out is distinct from sign-in-required");
  assert.equal(surfaceInputs({ account: { mode: "signed-out", spaces: [] } }, [], false).signedOut, false, "never-signed-in account status is not a deliberate sign-out");
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
