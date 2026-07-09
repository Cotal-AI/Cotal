/**
 * LAUNCH-OPTIONS smoke — the contract of the opaque `launchOptions` RAW passthrough.
 *
 * launchOptions is a raw passthrough: the spawn capability is the trust boundary (WHO may spawn, via
 * the caller's authenticated identity), not WHICH flags a spawn carries. So there is no allow-list and
 * no deny-list — every option is forwarded to the host verbatim. Two layers:
 *  A. `connectorLaunchOptions` (the shared chokepoint every connector routes through): forwards every
 *     entry, guarding ONLY key shape for process integrity — it rejects an `=`-in-key that would garble
 *     a rendered flag, the prototype-pollution keys `__proto__`/`constructor`/`prototype`, and
 *     whitespace / leading-digit / empty keys. It does NOT police which flags are permitted.
 *  B. The two consuming connectors render every entry: claude as `--key value` (bare `--key` for
 *     empty), opencode by merging into `config.agent.cotal` — including keys a former policy refused.
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

// -- A. the shared guard (key shape ONLY — process integrity, not flag policy) ---------------------
// #1 the `=`-in-key: a map source doesn't split on `=`, so this key would otherwise render as the
// single token `--mcp-config=/tmp/evil.json` — a garbled flag rather than `--mcp-config /tmp/...`.
throws("`=`-in-key rejected (would garble the rendered flag)", () =>
  connectorLaunchOptions("t", { "mcp-config=/tmp/evil.json": "" }));
// #2 prototype pollution — JSON.parse makes __proto__ an OWN enumerable key (the real MCP/manifest vector).
throws("__proto__ rejected", () => connectorLaunchOptions("t", JSON.parse('{"__proto__":"x"}')));
throws("constructor rejected", () => connectorLaunchOptions("t", { constructor: "x" }));
throws("prototype rejected", () => connectorLaunchOptions("t", { prototype: "x" }));
// key shape
throws("whitespace-in-key rejected", () => connectorLaunchOptions("t", { "a b": "x" }));
throws("leading-digit key rejected", () => connectorLaunchOptions("t", { "1flag": "x" }));
throws("empty key rejected", () => connectorLaunchOptions("t", { "": "x" }));
eq("hyphen/underscore key accepted", connectorLaunchOptions("t", { "top_p": "1", "max-budget-usd": "5" }),
  [["top_p", "1"], ["max-budget-usd", "5"]]);
// RAW passthrough: any well-shaped key is returned — no allow-list, no deny-list.
eq("any well-shaped key returned (no allow-list)",
  connectorLaunchOptions("t", { settings: "/x", model: "y", "add-dir": "/" }),
  [["settings", "/x"], ["model", "y"], ["add-dir", "/"]]);
// nothing to render
eq("undefined bag → []", connectorLaunchOptions("t", undefined), []);

// -- B. per-connector consumption (RAW — every well-shaped flag renders) ----------------------------
const base = {
  space: "smoke", name: "t", role: "worker", id: "id1", creds: "/tmp/none.creds",
  servers: "nats://127.0.0.1:1", subscribe: ["general"], allowSubscribe: ["general"], allowPublish: [],
};
const argPair = (args: readonly string[], flag: string, val: string): boolean => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] === val;
};

// claude renders every flag (`--k v`, bare `--k` for empty) — including ones a former allow-list refused.
const cs = claudeConnector.buildLaunch({ ...base, launchOptions: { verbose: "", "max-budget-usd": "5" } });
check("claude renders bare --verbose", cs.args.includes("--verbose"), cs.args);
check("claude renders --max-budget-usd 5", argPair(cs.args, "--max-budget-usd", "5"), cs.args);
const csRaw = claudeConnector.buildLaunch({ ...base, launchOptions: { settings: "/tmp/s.json", "add-dir": "/", betas: "some-preview" } });
check("claude renders --settings (raw passthrough)", argPair(csRaw.args, "--settings", "/tmp/s.json"), csRaw.args);
check("claude renders --add-dir (raw passthrough)", argPair(csRaw.args, "--add-dir", "/"), csRaw.args);
check("claude renders --betas (raw passthrough)", argPair(csRaw.args, "--betas", "some-preview"), csRaw.args);
throws("claude still rejects `=`-in-key smuggle at buildLaunch", () =>
  claudeConnector.buildLaunch({ ...base, launchOptions: JSON.parse('{"mcp-config=/tmp/e.json":""}') }));

// opencode merges every key into config.agent.cotal — including ones a former deny-list reserved.
const os = opencodeConnector.buildLaunch({ ...base, launchOptions: { temperature: "0.2", topP: "0.9", permission: "allow", tools: "x" } });
const oc = JSON.parse(os.env!.OPENCODE_CONFIG_CONTENT!) as { agent?: { cotal?: Record<string, unknown> }; default_agent?: string };
check("opencode merges tuning keys into config.agent.cotal", oc.agent?.cotal?.temperature === "0.2" && oc.agent?.cotal?.topP === "0.9", oc.agent?.cotal);
check("opencode merges former-reserved keys (raw passthrough)", oc.agent?.cotal?.permission === "allow" && oc.agent?.cotal?.tools === "x", oc.agent?.cotal);
check("opencode pins the cotal agent as default", oc.default_agent === "cotal" && oc.agent?.cotal?.mode === "primary", oc);
throws("opencode still rejects proto pollution at buildLaunch", () =>
  opencodeConnector.buildLaunch({ ...base, launchOptions: JSON.parse('{"__proto__":"x"}') }));

console.log(`\nLAUNCH-OPTIONS SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
