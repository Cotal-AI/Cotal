/** Rule 0's refusal-code table: the one action each error screen offers. A render sweep imports the
 *  same list, and status-field states (space-row sentences, Disk full, Service stopped and the rest)
 *  live in a second exported list beside it, so no state is written twice. */
export type RuleZeroAction = "repair" | "login" | "install" | "connect" | "spaces" | "refresh" | "installer" | "none";

export const REFUSAL_CODES: Readonly<Record<string, RuleZeroAction>> = {
  // The service belongs to another installation, answers without a unit, or cannot be verified.
  ANOTHER_INSTALLATION: "repair", CONFLICT: "repair", RUNNING_WITHOUT_UNIT: "repair", LOCK_HELD: "repair", PEER_NOT_LOCK_OWNER: "repair",
  // Another OS account's service: nothing in this app can fix it, so no button is offered.
  PEER_UID_MISMATCH: "none",
  // The service was started and does not answer, stopped mid-operation, or its native state is unknown.
  NOT_ANSWERING: "repair", DAEMON_LOST: "repair", OPERATION_UNKNOWN: "repair", TARGET_UNAVAILABLE: "repair", TARGET_NOT_FOUND: "repair",
  // Generic computer-side failures the catch-all used to answer with a status re-read.
  OPERATION_FAILED: "repair", OPERATION_PARTIAL: "repair", DEPENDENCY_UNAVAILABLE: "repair", LIFECYCLE_BLOCKED: "repair",
  MANAGER_UNAVAILABLE: "repair", GENERATION_PENDING: "repair", PERMISSION_DENIED: "repair", NO_RUNTIME_DIR: "repair",
  UNSUPPORTED_PLATFORM: "repair", UNSUPPORTED: "repair", USAGE_INVALID: "repair", BAD_REQUEST: "repair",
  // Causes with their own working fix.
  NOT_RUNNING: "install", DENIED: "login", EXPIRED: "login", CREDENTIAL_EXPIRED: "login", AUTH_REQUIRED: "login", NOT_SIGNED_IN: "login",
  NO_AVAILABLE_CONNECTOR: "connect", SEATS_ACTIVE: "connect", VERSION_MISMATCH: "connect", NO_SPACES: "spaces",
  // Waiting on someone or something outside this computer, or a failure inside the window: checking again is the fix.
  APPROVAL_PENDING: "refresh", UNREACHABLE: "refresh", RETRY: "refresh",
  // This copy of the app is incomplete; only its installer can fix it.
  SETUP_INTERRUPTED: "installer",
};

/** Text a person reads that is written for a terminal. */
export const COMMAND_TEXT = /`|\bcotal\s|systemctl|loginctl|launchctl|schtasks/;

/** Text a person reads that names a web address or a file path. */
export const ADDRESS_TEXT = /https?:\/\/|\/(?:Users|Applications|usr|opt|home)\//;

/** One of the ten words the window, pill, tray and tooltip share. */
export type SurfaceWord = "Connected" | "Starting" | "Offline" | "Can't connect" | "Sign in required" | "Service stopped" | "Updating" | "Not set up" | "Disk full" | "Repair needed";

/** A state that reaches the window as a status field rather than a refusal code. `state` is a render
 *  stub state (render/fixtures.mjs nativeStub): `statusExtra` adds fields to every status frame and
 *  `stoppedDetail` replaces the stopped service's refusal detail. `action` is the label of the one
 *  enabled button; absent means the state offers none. */
export interface StatusFieldCase { name: string; state: Record<string, unknown>; word: SurfaceWord; title: string; action?: string }

const held = (space: string) => ({ space, desired: true, observed: "connected", lastRefusal: "The local space connection is held by https://old.example/api/auth." });
const connected = (space: string) => ({ space, desired: true, observed: "connected" });
const account = (spaces: unknown[]) => ({ mode: "account", hostSupport: "supported", spaces });
// readyAccountSpaces answers one launch-ready Manager per desired space, so a refused space's Manager
// answers too, as on the computer where both spaces were refused while their Managers ran.
const ready = { installed: true, signedIn: true, connected: true, readyAccountSpaces: true };

export const STATUS_FIELD_CASES: readonly StatusFieldCase[] = [
  { name: "every-space-refused", state: { ...ready, account: account([held("acme-team"), held("research")]) }, word: "Can't connect", title: "Can't connect to your spaces" },
  { name: "one-refused-one-connected", state: { ...ready, account: account([held("acme-team"), connected("research")]) }, word: "Connected", title: "This computer is connected" },
  { name: "disk-full", state: { ...ready, account: account([connected("acme-team")]), statusExtra: { diskFull: true } }, word: "Disk full", title: "Your disk is full", action: "Check again" },
  { name: "service-stopped-by-you", state: { installed: true, signedIn: true, serviceStopped: true, stoppedDetail: { installed: true, stopped: "by-you" } }, word: "Service stopped", title: "The background service is stopped", action: "Start" },
  { name: "update-waiting", state: { ...ready, account: account([connected("acme-team")]), statusExtra: { generation: { installed: "0.184.0", running: "0.183.0", waiting: "preparing activation" } } }, word: "Updating", title: "Cotal is updating" },
  // Only a computer without an account writes a Manager's next into Details; an account computer
  // returns before that line, so this case must use the single-space path.
  { name: "manager-next-names-a-command", state: { installed: true, signedIn: true, managers: [{ space: "acme-team", state: "starting", reason: "the hosted Manager parent IPC probe did not answer", next: "inspect `cotal daemon status --space acme-team`" }] }, word: "Starting", title: "This computer is starting" },
];
