/**
 * The opt-in launch fields on the OpenCode launch path. Every cell calls `buildLaunch` and reads the
 * config it renders into `OPENCODE_CONFIG_CONTENT`, the only place OpenCode learns its permission
 * rules.
 *
 * `askPermissions` swaps the launch's allow-everything rules for T3 Code's approval-required ones:
 * every tool asks, except the ones T3 always allows and the agent's own `cotal_*` tools, and reading
 * an `.env` file asks. OpenCode applies the last rule that matches, so the catch-all must come first.
 *
 * Run: pnpm smoke:opencode-launch-fields
 */
import { opencodeConnector } from "../src/extension.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  x FAIL: ${name}`, extra ?? "");
  }
};

const WS = "/tmp/cotal-opencode-launch-fields-workspace";
type Config = { permission?: unknown; agent?: { cotal?: Record<string, unknown> } };
const config = (extra: Record<string, unknown>): Config => {
  const env = opencodeConnector.buildLaunch({ space: "s", name: "seat", workspaceRoot: WS, ...extra } as never).env as Record<string, string>;
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Config;
};
const refusalFor = (extra: Record<string, unknown>): string | null => {
  try {
    config(extra);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
};

check("control:a launch without askPermissions allows every tool", config({}).permission === "allow", config({}).permission);
check("control:askPermissions false allows every tool", config({ askPermissions: false }).permission === "allow");
check("supports:the connector declares askPermissions, so the Manager passes it on",
  opencodeConnector.supportsAskPermissions === true, opencodeConnector.supportsAskPermissions);

{
  const rules = config({ askPermissions: true }).permission as Record<string, unknown> | string;
  const r = typeof rules === "object" ? rules : {};
  check("ask:an askPermissions launch writes permission rules, not a blanket allow", typeof rules === "object", rules);
  check("ask:the catch-all asks and comes first, so a later rule can narrow it", Object.keys(r)[0] === "*" && r["*"] === "ask", Object.keys(r));
  check("ask:shell, edit, fetch and outside-directory access have no rule of their own, so they ask",
    ["bash", "edit", "webfetch", "websearch", "codesearch", "external_directory", "doom_loop"].every((k) => r[k] === undefined), r);
  check("allow:the tools T3 always allows are allowed",
    ["question", "glob", "grep", "lsp", "todowrite", "task", "skill"].every((k) => r[k] === "allow"), r);
  check("allow:the agent's own cotal_* tools are allowed", r["cotal_*"] === "allow", r);
  const read = (r.read ?? {}) as Record<string, unknown>;
  check("read:reading is allowed, an .env file asks, and .env.example is allowed after the .env rules",
    JSON.stringify(Object.entries(read)) === JSON.stringify([["*", "allow"], ["*.env", "ask"], ["*.env.*", "ask"], ["*.env.example", "allow"]]), read);
}
{
  const c = config({ askPermissions: true, launchOptions: { temperature: "0.2" } });
  check("options:other launch options still reach the cotal agent beside the asking rules",
    c.agent?.cotal?.temperature === "0.2" && typeof c.permission === "object" && c.agent?.cotal?.permission === undefined, c);
}
{
  const refusal = refusalFor({ askPermissions: true, launchOptions: { permission: "allow" } });
  check("refuse:askPermissions with a `permission` launch option, which would override the rules, refuses the launch",
    refusal?.includes("askPermissions") === true && refusal.includes("permission"), refusal);
  check("control:a `permission` launch option without askPermissions still launches",
    refusalFor({ launchOptions: { permission: "allow" } }) === null);
}

const EXPECTED = 12;
check(`meta:every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);
console.log(`opencode-launch-fields smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
