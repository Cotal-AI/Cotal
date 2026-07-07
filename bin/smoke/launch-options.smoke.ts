/**
 * LAUNCH-OPTIONS guard smoke — the security contract of the opaque `launchOptions` passthrough.
 *
 * Two layers:
 *  A. `connectorLaunchOptions` (the shared chokepoint every connector routes through): the key-shape
 *     grammar (rejects an `=`-in-key that would smuggle a reserved flag as one `--flag=value` argv
 *     token; rejects the prototype-pollution keys `__proto__`/`constructor`/`prototype`; rejects
 *     whitespace / leading-digit / empty keys), and the two policy modes (allow-list fails CLOSED,
 *     deny-list fails on named reserved keys).
 *  B. The two consuming connectors render/refuse per their own policy: claude ALLOW-lists a small set
 *     of benign tuning flags and refuses everything else (its flag surface is large + evolving);
 *     opencode DENY-lists the model/policy/structural keys of its fixed agent-config schema.
 *
 * The map sources (persona/manifest/MCP) arrive as JSON — a `__proto__` there is an OWN enumerable
 * key, unlike a JS object literal — so those cases use `JSON.parse` to reproduce the real vector.
 *
 * Pure (no NATS, no broker): buildLaunch only computes args/env here. Needs dist built (imports the
 * packages by name). Run with: pnpm smoke:launch-options
 */
import { connectorLaunchOptions } from "@cotal-ai/connector-core";
import { claudeConnector } from "@cotal-ai/connector-claude-code";
import { opencodeConnector } from "@cotal-ai/connector-opencode";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra === undefined ? "" : JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}
function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    check(label, false, "did not throw");
  } catch {
    check(label, true);
  }
}
const eq = (label: string, got: unknown, want: unknown): void =>
  check(label, JSON.stringify(got) === JSON.stringify(want), got);

// -- A. the shared guard ---------------------------------------------------------------------------
// #1 the `=`-in-key bypass: a map source doesn't split on `=`, so this key would otherwise render as
// the single token `--mcp-config=/tmp/evil.json` and defeat the reserved/allow check.
throws("`=`-in-key rejected (reserved-flag smuggle)", () =>
  connectorLaunchOptions("t", { "mcp-config=/tmp/evil.json": "" }, { allow: [] }));
// #2 prototype pollution — JSON.parse makes __proto__ an OWN enumerable key (the real MCP/manifest vector).
throws("__proto__ rejected", () => connectorLaunchOptions("t", JSON.parse('{"__proto__":"x"}'), { reserved: [] }));
throws("constructor rejected", () => connectorLaunchOptions("t", { constructor: "x" }, { reserved: [] }));
throws("prototype rejected", () => connectorLaunchOptions("t", { prototype: "x" }, { reserved: [] }));
// key shape
throws("whitespace-in-key rejected", () => connectorLaunchOptions("t", { "a b": "x" }, { reserved: [] }));
throws("leading-digit key rejected", () => connectorLaunchOptions("t", { "1flag": "x" }, { reserved: [] }));
throws("empty key rejected", () => connectorLaunchOptions("t", { "": "x" }, { reserved: [] }));
eq("hyphen/underscore key accepted", connectorLaunchOptions("t", { "top_p": "1", "max-budget-usd": "5" }, { reserved: [] }),
  [["top_p", "1"], ["max-budget-usd", "5"]]);
// #3 allow-list fails CLOSED
eq("allow: permitted key returned", connectorLaunchOptions("t", { verbose: "" }, { allow: ["verbose"] }), [["verbose", ""]]);
throws("allow: non-permitted key refused", () => connectorLaunchOptions("t", { settings: "/x" }, { allow: ["verbose"] }));
// deny-list
throws("reserved: reserved key refused", () => connectorLaunchOptions("t", { model: "x" }, { reserved: ["model"] }));
eq("reserved: non-reserved key returned", connectorLaunchOptions("t", { temperature: "0.2" }, { reserved: ["model"] }), [["temperature", "0.2"]]);
// nothing to render
eq("undefined bag → []", connectorLaunchOptions("t", undefined, { reserved: [] }), []);

// -- B. per-connector consumption ------------------------------------------------------------------
const base = {
  space: "smoke", name: "t", role: "worker", id: "id1", creds: "/tmp/none.creds",
  servers: "nats://127.0.0.1:1", subscribe: ["general"], allowSubscribe: ["general"], allowPublish: [],
};
const argPair = (args: readonly string[], flag: string, val: string): boolean => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] === val;
};

// claude ALLOW-list: benign tuning flags render (`--k v`, bare `--k` for empty), boundary flags refused.
const cs = claudeConnector.buildLaunch({ ...base, launchOptions: { verbose: "", "max-budget-usd": "5" } });
check("claude renders bare --verbose", cs.args.includes("--verbose"), cs.args);
check("claude renders --max-budget-usd 5", argPair(cs.args, "--max-budget-usd", "5"), cs.args);
throws("claude refuses --settings (allow-list, config-file load)", () =>
  claudeConnector.buildLaunch({ ...base, launchOptions: { settings: "/tmp/evil.json" } }));
throws("claude refuses --model override via --opt", () =>
  claudeConnector.buildLaunch({ ...base, launchOptions: { model: "x" } }));
throws("claude refuses --add-dir (filesystem scope)", () =>
  claudeConnector.buildLaunch({ ...base, launchOptions: { "add-dir": "/" } }));
throws("claude refuses --betas (opaque experimental-feature indirection)", () =>
  claudeConnector.buildLaunch({ ...base, launchOptions: { betas: "some-preview" } }));
throws("claude refuses `=`-in-key smuggle at buildLaunch", () =>
  claudeConnector.buildLaunch({ ...base, launchOptions: JSON.parse('{"mcp-config=/tmp/e.json":""}') }));

// opencode DENY-list: model-tuning keys merge into config.agent.cotal; model/policy/structural refused.
const os = opencodeConnector.buildLaunch({ ...base, launchOptions: { temperature: "0.2", topP: "0.9" } });
const oc = JSON.parse(os.env!.OPENCODE_CONFIG_CONTENT!) as { agent?: { cotal?: Record<string, unknown> }; default_agent?: string };
check("opencode merges tuning keys into config.agent.cotal", oc.agent?.cotal?.temperature === "0.2" && oc.agent?.cotal?.topP === "0.9", oc.agent?.cotal);
check("opencode pins the cotal agent as default", oc.default_agent === "cotal" && oc.agent?.cotal?.mode === "primary", oc);
throws("opencode refuses `permission` (per-agent policy injection)", () =>
  opencodeConnector.buildLaunch({ ...base, launchOptions: { permission: "allow" } }));
throws("opencode refuses `tools` (tool injection)", () =>
  opencodeConnector.buildLaunch({ ...base, launchOptions: { tools: "x" } }));
throws("opencode refuses `mcp` (server injection)", () =>
  opencodeConnector.buildLaunch({ ...base, launchOptions: { mcp: "x" } }));
throws("opencode refuses `plugin` (plugin injection)", () =>
  opencodeConnector.buildLaunch({ ...base, launchOptions: { plugin: "x" } }));
throws("opencode refuses proto pollution at buildLaunch", () =>
  opencodeConnector.buildLaunch({ ...base, launchOptions: JSON.parse('{"__proto__":"x"}') }));

console.log(`\nLAUNCH-OPTIONS SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
