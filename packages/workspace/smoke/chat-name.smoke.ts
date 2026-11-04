/**
 * Chat name pure smoke (no broker, no IdP).
 *
 * SCOPE, stated honestly: this checks the one decision of the name a chat session appears as
 * (`resolveChatName`), the rule every chat name is held to (`chatNameProblem`, also the `name`
 * preference's check), and the shared-name check a new session runs (`nameInUse`). The account name
 * comes from a recording auth provider registered under its own name; `@cotal-ai/auth`'s
 * `login-name.smoke` proves a real login records it, and `chat-static-live` proves `cotal chat` uses
 * the OS login.
 *
 * Run: pnpm smoke:chat-name
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type AuthProvider, type UserAuthStatus } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { chatNameProblem } from "../src/chat-name.js";
import { isCommandFailure, type CommandFailure } from "../src/output.js";
import { preferenceValueProblem, type Preferences } from "../src/preferences.js";
import { nameInUse, nameInUseText, resolveChatName, type AdmittedChatSession, type RosterRow } from "../src/chat/index.js";
import type { MeshTarget } from "../src/mesh-target.js";

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "cotal-chat-name-"));
const prefs = (name?: string): Preferences => ({ schemaVersion: 1, revision: 1, defaults: name === undefined ? {} : { name }, spaces: {} });
const NONE = prefs();
const IDP = "https://idp.example.test/api/auth";

let status: UserAuthStatus = { idpUrl: IDP };
const statusCalls: { space: string; actor: string }[] = [];
registry.register({
  kind: "auth-provider",
  name: "chat-name-smoke",
  async userStatus({ space, actor }: { space: string; actor: string }) {
    statusCalls.push({ space, actor });
    return status;
  },
} as unknown as AuthProvider);

type Target = Pick<MeshTarget, "mode" | "space" | "root" | "userAuth">;
const open: Target = { mode: "open", space: "demo", root };
const staticTarget: Target = { mode: "auth", space: "demo", root };
const user: Target = { mode: "user", space: "demo", root, userAuth: { provider: "chat-name-smoke", idp: { url: IDP, issuer: "https://idp.example.test", audience: "https://idp.example.test" } } };
const refusal = async (p: Promise<unknown>): Promise<CommandFailure | undefined> => p.then(() => undefined, (e: unknown) => (isCommandFailure(e) ? e : undefined));

try {
  console.log("1. chatNameProblem: the one rule for every chat name");
  const RULE = "a name is 1 to 128 characters, not blank and without control characters";
  check("an empty, blank, 129-character or control-character name is refused with the rule",
    ["", "   ", "x".repeat(129), "bell\u0007", "del\u007f", "line\nbreak"].every((v) => chatNameProblem(v) === RULE));
  check("a 128-character name, an email, spaces and slashes are accepted",
    ["x".repeat(128), "human@example.test", "Ops Lead", "a/b\\c"].every((v) => chatNameProblem(v) === undefined));
  check("the name preference is held to the same rule", preferenceValueProblem("name", " ")?.endsWith(RULE) === true && preferenceValueProblem("name", "Ops Lead") === undefined);

  console.log("2. open and static: the OS login, with no suffix");
  {
    const a = await resolveChatName(open, { preferences: NONE, login: () => "manas" });
    check("an open space names the session the OS login, with no host or suffix", a.name === "manas" && a.source === "login" && a.from === "your OS login", a);
    const s = await resolveChatName(staticTarget, { preferences: NONE, login: () => "manas" });
    check("a static space names it the OS login too", s.name === "manas" && s.source === "login", s);
    const bad = await refusal(resolveChatName(open, { preferences: NONE, login: () => "" }));
    check("an OS login that fails the rule refuses with the config remedy",
      bad?.code === "USAGE_INVALID" && bad.message.includes(RULE) && bad.remedy === "save a name with `cotal config set name <name>`", bad);
  }

  console.log("3. the flag, then the saved name, win over the mode's name");
  {
    const flag = await resolveChatName(open, { flag: "alice", preferences: prefs("Ops Lead"), login: () => "manas" });
    check("--name wins over a saved name and the OS login", flag.name === "alice" && flag.source === "flag" && flag.from === "--name", flag);
    const saved = await resolveChatName(open, { preferences: prefs("Ops Lead"), login: () => "manas" });
    check("a saved name wins over the OS login", saved.name === "Ops Lead" && saved.source === "preference" && saved.from === "your saved name", saved);
    statusCalls.length = 0;
    const savedUser = await resolveChatName(user, { preferences: prefs("Ops Lead") });
    check("a saved name wins in user mode without reading the sign-in", savedUser.name === "Ops Lead" && statusCalls.length === 0, { savedUser, statusCalls });
    const badFlag = await refusal(resolveChatName(open, { flag: "", preferences: NONE }));
    check("a flag that fails the rule refuses with the --name remedy", badFlag?.code === "USAGE_INVALID" && badFlag.remedy === "pass another --name", badFlag);
  }

  console.log("4. user: the account name recorded at cotal login");
  {
    status = { idpUrl: IDP, login: { sub: "u1", expiresAt: 0, name: "human@example.test" } };
    statusCalls.length = 0;
    let osRead = false;
    const a = await resolveChatName(user, { preferences: NONE, login: () => { osRead = true; return "manas"; } });
    check("a user space names the session the account name, read as the cli actor of that space",
      a.name === "human@example.test" && a.source === "account" && a.from === `your sign-in at ${IDP}` && JSON.stringify(statusCalls) === JSON.stringify([{ space: "demo", actor: "cli" }]), { a, statusCalls });
    check("user mode never reads the OS login", !osRead);

    status = { idpUrl: IDP };
    osRead = false;
    const out = await refusal(resolveChatName(user, { preferences: NONE, login: () => { osRead = true; return "manas"; } }));
    check("no cached login refuses as AUTH_REQUIRED naming the login command, with no OS-login fallback",
      out?.code === "AUTH_REQUIRED" && out.message === `not signed in to ${IDP}; run \`cotal login --idp ${IDP}\`` && !osRead, out);

    status = { idpUrl: IDP, login: { sub: "u1", expiresAt: 0 } };
    const nameless = await refusal(resolveChatName(user, { preferences: NONE, login: () => "manas" }));
    check("a login with no recorded name refuses as USAGE_INVALID with both remedies",
      nameless?.code === "USAGE_INVALID" && nameless.message === `your sign-in at ${IDP} has no account name on record, because it was made by an older cotal or the provider gave none`
        && nameless.remedy === `sign in again with \`cotal login --idp ${IDP}\`, or save a name with \`cotal config set name <name>\``, nameless);

    status = { idpUrl: IDP, login: { sub: "u1", expiresAt: 0, name: "x".repeat(129) } };
    const long = await refusal(resolveChatName(user, { preferences: NONE }));
    check("an account name that fails the rule refuses with the config remedy", long?.code === "USAGE_INVALID" && long.remedy === "save a name with `cotal config set name <name>`", long);

    const unknown = await refusal(resolveChatName({ ...user, userAuth: { ...user.userAuth!, provider: "absent-provider" } }, { preferences: NONE }));
    check("an unregistered auth provider refuses as UNSUPPORTED", unknown?.code === "UNSUPPORTED" && unknown.message.includes("absent-provider"), unknown);
    const odd = await refusal(resolveChatName({ ...open, mode: "other" as MeshTarget["mode"] }, { preferences: NONE, login: () => "manas" }));
    check("an unknown mode refuses instead of borrowing another mode's rule", odd?.code === "UNSUPPORTED", odd);
  }

  console.log("5. nameInUse: other live holders of the name, ignoring case");
  {
    const self = { principal: "local.me", label: "bob" };
    const sessionWith = (rows: RosterRow[], outcome: "ok" | "failed" = "ok") =>
      ({ identity: () => self, roster: async () => (outcome === "ok" ? { outcome, value: { rows, view: "current" as const } } : { outcome, error: { code: "x", message: "x" } }) }) as unknown as AdmittedChatSession;
    const me: RosterRow = { id: "local.me", name: "bob", kind: "endpoint", status: "idle", sessionKind: "chat" };
    const found = await nameInUse(sessionWith([me, { id: "local.other", name: "Bob", kind: "endpoint", status: "idle", sessionKind: "chat" }, { id: "local.agent", name: "BOB", kind: "agent", status: "working" }]));
    check("live holders of the name in another letter case are found, each with its kind",
      JSON.stringify(found) === JSON.stringify({ name: "bob", holders: [{ id: "local.other", kind: "chat session" }, { id: "local.agent", kind: "agent" }] }), found);
    check("the warning names the holders and ends with the front end's remedy",
      nameInUseText(found!, "do x") === `the name "bob" is already in use here by local.other (chat session), local.agent (agent); a direct message to "bob" refuses as ambiguous while both are present, so do x`);
    check("an offline record, only this session, or a failed roster read finds nothing",
      await nameInUse(sessionWith([me, { id: "local.gone", name: "bob", kind: "agent", status: "offline" }])) === undefined
        && await nameInUse(sessionWith([me])) === undefined
        && await nameInUse(sessionWith([me, { id: "local.other", name: "bob", kind: "endpoint", status: "idle" }], "failed")) === undefined);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  finish();
}
