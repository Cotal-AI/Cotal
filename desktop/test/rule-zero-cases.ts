/** Rule 0's refusal-code table: the one action each error screen offers. A render sweep imports the
 *  same list, and status-field states (space-row sentences, Disk full, Service stopped and the rest)
 *  live in a second exported list beside it, so no state is written twice. */
export type RuleZeroAction = "repair" | "login" | "install" | "connect" | "spaces" | "refresh" | "installer" | "none";

export const REFUSAL_CODES: Readonly<Record<string, RuleZeroAction>> = {
  // The service belongs to another installation, answers without a unit, or cannot be verified.
  ANOTHER_INSTALLATION: "repair", CONFLICT: "repair", LOCK_HELD: "repair", PEER_NOT_LOCK_OWNER: "repair",
  // Another OS account's service, or one started by hand with no unit: nothing in this app can fix it, so no button is offered.
  PEER_UID_MISMATCH: "none", RUNNING_WITHOUT_UNIT: "none",
  // The service was started and does not answer, stopped mid-operation, or its native state is unknown.
  NOT_ANSWERING: "repair", DAEMON_LOST: "repair", OPERATION_UNKNOWN: "repair", TARGET_UNAVAILABLE: "repair", TARGET_NOT_FOUND: "repair",
  // Generic computer-side failures the catch-all used to answer with a status re-read.
  OPERATION_FAILED: "repair", OPERATION_PARTIAL: "repair", DEPENDENCY_UNAVAILABLE: "repair", LIFECYCLE_BLOCKED: "repair",
  MANAGER_UNAVAILABLE: "repair", GENERATION_PENDING: "repair", PERMISSION_DENIED: "repair", NO_RUNTIME_DIR: "repair",
  // A hosted Manager setup refused, for example because the agent app connectors could not be set up:
  // setup's refusal carries the Manager's state as its cause. Repair's connectors step fixes that one.
  REFUSED: "repair",
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
