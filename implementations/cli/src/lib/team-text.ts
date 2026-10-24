const TEAM_TEXT: Record<string, string> = {
  "fresh": "fresh boot",
  "additive": "additive ledger",
  "additive-channel-only": "additive channels",
  "additive-agent-only": "additive agents",
  "additive-mixed-team": "additive agents and channels",
  "broker-boot-returned": "boot returned",
  "broker-boot-degraded": "boot returned with a component unconfirmed",
  "broker-boot-unverified": "boot returned, summary predates its checks",
  "ownership-ledger-present": "ownership ledger present",
  "removal-returned": "removed",
  "channels-and-agents-returned": "agents joined and channels created",
  "agent-joins-returned": "agents joined",
  "channel-create-returned": "channels created",
  "unsettled": "unsettled",
  "unsettled-additive-attempt": "unsettled",
  "no-matching-summary": "no matching summary",
  "inspect-selected-stack": "inspect the stack",
  "review-scoped-native-teardown": "review its scoped teardown",
  "inspect-removal-history": "read its removal history",
  "reconcile-unsettled-removal": "settle its unfinished removal",
  "inspect-card-revisions-before-removal": "check its card revisions before removal",
  "inspect-native-incarnation-before-removal": "check its agents before removal",
};

/** How the team reports name a recorded record kind, state or next action. The JSON result keeps
 *  the recorded value; a value the table does not know prints with its hyphens as spaces. */
export function teamText(value: string): string {
  return TEAM_TEXT[value] ?? value.replaceAll("-", " ");
}

/** How the team reports name an auth mode, as the stack's member table does. */
export function authModeText(mode: string | null | undefined): string {
  if (mode === null || mode === undefined) return "not recorded";
  return mode === "user" || mode === "user-auth" ? "user auth" : mode === "auth" || mode === "static" || mode === "static-auth" ? "static auth" : mode;
}
