import { userInfo } from "node:os";
import { oneLine, registry, type AuthProvider, type UserAuthStatus } from "@cotal-ai/core";
import { userAuthStateDir } from "../auth-paths.js";
import { loginRecoveryCommand } from "../cloud-login.js";
import { chatNameProblem } from "../chat-name.js";
import { CLI_USER_ACTOR } from "../connect.js";
import type { MeshTarget } from "../mesh-target.js";
import { CommandFailure } from "../output.js";
import { resolvePreference, type Preferences } from "../preferences.js";
import { workspaceSecretStore } from "../secret-store-fs.js";
import type { AdmittedChatSession, RosterView } from "./session.js";

/** The name a chat session appears as, and where it came from. */
export interface ChatName {
  readonly name: string;
  readonly source: "flag" | "preference" | "account" | "login";
  /** How the source reads in a sentence: "--name", "your saved name", "your sign-in at <idp>",
   *  "your OS login". */
  readonly from: string;
}

const SAVE_NAME = "save a name with `cotal config set name <name>`";

/** The OS login, trimmed, or "" when the OS reports none. */
function osLogin(): string {
  try {
    return userInfo().username.trim();
  } catch {
    return "";
  }
}

/** The account name the user-mode target's IdP gave at `cotal login`, through the space's
 *  registered auth provider, and the step that records it again. `remedy` is the front end's own
 *  way to name a session. */
async function accountName(target: Pick<MeshTarget, "space" | "root" | "userAuth">, remedy: string): Promise<{ found: ChatName; signIn: string }> {
  const space = target.space;
  if (!target.userAuth)
    throw new CommandFailure("refused", "UNSUPPORTED", "a user-mode chat name requires a recorded user-auth target", { target: { space } });
  const providerName = target.userAuth.provider;
  let provider: AuthProvider;
  try {
    provider = registry.resolve<AuthProvider>("auth-provider", providerName);
  } catch {
    throw new CommandFailure("refused", "UNSUPPORTED", `space "${space}" uses the "${providerName}" auth provider, which this build does not register`, { target: { space } });
  }
  let status: UserAuthStatus;
  try {
    status = await provider.userStatus({ store: workspaceSecretStore(target.root), dir: userAuthStateDir(target.root, space), space, actor: CLI_USER_ACTOR });
  } catch (e) {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `cannot read your sign-in for space "${space}": ${e instanceof Error ? e.message : String(e)}`, { target: { space } });
  }
  const idp = status.idpUrl;
  const signIn = `sign in again with \`${loginRecoveryCommand(idp)}\``;
  if (!status.login)
    throw new CommandFailure("refused", "AUTH_REQUIRED", `not signed in to ${idp}; run \`${loginRecoveryCommand(idp)}\``, { target: { space }, remedy: `run \`${loginRecoveryCommand(idp)}\`` });
  if (!status.login.name)
    throw new CommandFailure("refused", "AUTH_REQUIRED", `your sign-in at ${idp} has no name on record that an @mention can reach, because it was made by an older cotal or the provider gave none`, {
      target: { space },
      remedy: `${signIn}, ${remedy}, or ${SAVE_NAME}`,
    });
  return { found: { name: status.login.name, source: "account", from: `your sign-in at ${idp}` }, signIn };
}

/**
 * The name a chat session appears as. Highest first: `flag`; the `name` preference, so `cotal
 * config` shows the same winner; then the mode's own name, with no suffix: in user mode the account
 * name recorded at `cotal login`, in open and static mode the OS login. One mode's failure never
 * falls back to another mode's rule. `remedy` is how this front end names a session, such as
 * "pass `--name <name>`"; a refusal lists it with the remedies every front end shares.
 */
export async function resolveChatName(
  target: Pick<MeshTarget, "mode" | "space" | "root" | "userAuth">,
  opts: { readonly remedy: string; readonly flag?: string; readonly preferences?: Preferences; readonly login?: () => string },
): Promise<ChatName> {
  const chosen = resolvePreference("name", { flag: { name: "name", value: opts.flag }, preferences: opts.preferences }).winner;
  let found: ChatName;
  let signIn: string | undefined;
  if (chosen?.source === "flag") found = { name: chosen.value, source: "flag", from: "--name" };
  else if (chosen) found = { name: chosen.value, source: "preference", from: "your saved name" };
  else if (target.mode === "user") ({ found, signIn } = await accountName(target, opts.remedy));
  else if (target.mode === "open" || target.mode === "auth") found = { name: (opts.login ?? osLogin)(), source: "login", from: "your OS login" };
  else throw new CommandFailure("refused", "UNSUPPORTED", `chat has no name for a mesh recorded in "${String(target.mode)}" mode`, { target: { space: target.space } });
  const problem = chatNameProblem(found.name);
  if (problem)
    throw new CommandFailure("refused", "USAGE_INVALID", `${found.from}, ${JSON.stringify(oneLine(found.name))}, cannot be a chat name: ${problem}`, {
      target: { space: target.space },
      remedy: found.source === "flag" ? "pass another --name" : `${signIn ? `${signIn}, ` : ""}${opts.remedy}, or ${SAVE_NAME}`,
      selfContained: true,
    });
  return found;
}

/** Other live participants that carry this session's name, ignoring case. */
export interface NameInUse {
  readonly name: string;
  readonly holders: readonly { readonly id: string; readonly kind: string }[];
}

/** How long a new session waits for its roster before it checks whether its name is in use. */
const ROSTER_MS = 2_000;

/** The other live participants that already carry this session's name, which a direct message by
 *  that name could then not single out. Reads the roster until it is current or `waitMs` passes;
 *  undefined when none, or when the roster read does not succeed. */
export async function nameInUse(session: AdmittedChatSession, opts: { readonly waitMs?: number } = {}): Promise<NameInUse | undefined> {
  const self = session.identity();
  const deadline = Date.now() + (opts.waitMs ?? ROSTER_MS);
  let roster: RosterView;
  for (;;) {
    const read = await session.roster();
    if (read.outcome !== "ok") return undefined;
    roster = read.value;
    if (roster.view === "current" || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const holders = roster.rows
    .filter((row) => row.id !== self.principal && row.status !== "offline" && row.name.toLowerCase() === self.label.toLowerCase())
    .map((row) => ({ id: row.id, kind: row.sessionKind === "chat" ? "chat session" : row.kind }));
  return holders.length ? { name: self.label, holders } : undefined;
}

/** The warning for a name in use, ending with how this front end changes the name. */
export function nameInUseText(found: NameInUse, remedy: string): string {
  const who = found.holders.map((h) => `${h.id} (${h.kind})`).join(", ");
  return `the name "${found.name}" is already in use here by ${who}; a direct message to "${found.name}" refuses as ambiguous while both are present, so ${remedy}`;
}
