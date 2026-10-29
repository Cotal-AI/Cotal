/** Native MCP discovery is the default; explicit selections and carried homes stay isolated.
 *  This calls the source adapter. The separate native-client fixture proves real MCP handshakes.
 *  Run: pnpm smoke:claude-mcp-default
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardLaunchArtifacts, discardLaunchMaterial, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { claudeConnector } from "../src/extension.js";

const root = mkdtempSync(join(tmpdir(), "cotal-mcp-default-"));
const profile = join(root, "profile");
const cwd = join(root, "project");
mkdirSync(profile); mkdirSync(cwd);
const osHome = join(root, "os-home"); mkdirSync(osHome);
const values = {
  HOME: osHome,
  USERPROFILE: osHome,
  CLAUDE_CONFIG_DIR: profile,
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  ENABLE_TOOL_SEARCH: "auto:5",
  MCP_TIMEOUT: "10000",
  MCP_CONNECTION_NONBLOCKING: "0",
  CLAUDE_CODE_OAUTH_TOKEN: "fixture-setup-token",
  USER_MCP_SECRET: "fixture-native-secret",
  SHARED_MCP_SECRET: "fixture-shared-secret",
  UNRELATED_PRIVATE_SECRET: "fixture-must-stay-out",
};
const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
const specs: LaunchSpec[] = [];
let passed = 0;
const check = (name: string, value: boolean) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const build = (extra: Partial<LaunchOpts> = {}) => {
  const spec = claudeConnector.buildLaunch({ space: "mcp_smoke", name: "native", events: false, cwd, ...extra });
  specs.push(spec); return spec;
};
const config = (spec: LaunchSpec) => {
  const value = spec.args[spec.args.indexOf("--mcp-config") + 1];
  return JSON.parse(value.startsWith("{") ? value : readFileSync(value, "utf8")) as { mcpServers: Record<string, { command: string; args?: string[] }> };
};
try {
  Object.assign(process.env, values);
  const native = { mcpServers: { personal: { command: "node", args: ["fixture.mjs"], env: { TOKEN: "${USER_MCP_SECRET}" } } } };
  const profileFile = join(profile, ".claude.json");
  const original = JSON.stringify(native);
  writeFileSync(profileFile, original);
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { repository: { command: "node", env: { TOKEN: "${UNRELATED_PRIVATE_SECRET}" } } } }));
  const ordinary = build();
  check("default launch retains native MCP discovery", !ordinary.args.includes("--strict-mcp-config"));
  check("default launch retains the selected Claude config directory", ordinary.env?.CLAUDE_CONFIG_DIR === profile);
  for (const key of ["ENABLE_CLAUDEAI_MCP_SERVERS", "ENABLE_TOOL_SEARCH", "MCP_TIMEOUT", "MCP_CONNECTION_NONBLOCKING"] as const)
    check(`native MCP switch ${key} keeps its explicit value`, ordinary.env?.[key] === values[key]);
  check("current user MCP references receive only their declared environment names", ordinary.env?.USER_MCP_SECRET === values.USER_MCP_SECRET && ordinary.env?.UNRELATED_PRIVATE_SECRET === undefined);
  check("native user config is not copied into the explicit MCP configuration", Object.keys(config(ordinary).mcpServers).join() === "cotal");
  check("native configuration is never rewritten", readFileSync(profileFile, "utf8") === original);
  check("Cotal keeps its explicit mesh seat entry and plugin hook loader", config(ordinary).mcpServers.cotal.args?.some((arg) => arg.endsWith("seat.cjs")) === true && ordinary.args.includes("--plugin-dir"));

  const none = build({ mcpServersExclusive: true, mcpServers: {} });
  check("an explicit empty selection isolates native MCP sources", none.args.includes("--strict-mcp-config") && Object.keys(config(none).mcpServers).join() === "cotal");
  check("an exclusive selection does not forward native user MCP secrets", none.env?.USER_MCP_SECRET === undefined);
  const shared = { declared: { command: "node", env: { TOKEN: "${SHARED_MCP_SECRET}" } } };
  const selected = build({ mcpServersExclusive: true, mcpServers: shared });
  check("an explicit named selection stays exclusive", selected.args.includes("--strict-mcp-config") && Object.keys(config(selected).mcpServers).sort().join() === "cotal,declared");
  check("selected shared references still reach the child without unrelated secrets", selected.env?.SHARED_MCP_SECRET === values.SHARED_MCP_SECRET && selected.env?.USER_MCP_SECRET === undefined && selected.env?.UNRELATED_PRIVATE_SECRET === undefined);
  check("the private shared configuration keeps references rather than resolved secrets", !JSON.stringify(config(selected)).includes(values.SHARED_MCP_SECRET));
  check("declared overrides do not implicitly disable native discovery", !build({ mcpServers: shared }).args.includes("--strict-mcp-config"));
  const shadowed = build({ mcpServers: { cotal: { command: "wrong-server" } } });
  check("a declared server cannot replace Cotal's own bridge", config(shadowed).mcpServers.cotal.command === "node");

  const other = join(root, "other-profile"); mkdirSync(other);
  writeFileSync(join(other, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  process.env.CLAUDE_CONFIG_DIR = other;
  check("changing the selected profile does not reuse the previous profile's secret references", build().env?.USER_MCP_SECRET === undefined);
  process.env.CLAUDE_CONFIG_DIR = profile;
  const carriedHome = join(root, "carried"); mkdirSync(carriedHome);
  // Node is only a --version command double here; this does not launch a Claude session.
  const carried = build({ resolvedBinaries: { claude: process.execPath }, carried: { home: carriedHome, transcript: join(root, "unused.jsonl"), cwd } });
  check("carried private homes remain isolated from native MCP sources", carried.args.includes("--strict-mcp-config") && carried.env?.USER_MCP_SECRET === undefined);
  check("carried private homes do not copy the operator's MCP configuration", carried.env?.CLAUDE_CONFIG_DIR === carriedHome && !("mcpServers" in JSON.parse(readFileSync(join(carriedHome, ".claude.json"), "utf8"))));
  console.log(`CLAUDE MCP DEFAULT OK (${passed} passed)`);
} finally {
  for (const spec of specs) {
    discardLaunchArtifacts(spec.artifacts);
    if (spec.env?.COTAL_LAUNCH_MATERIAL) discardLaunchMaterial(spec.env.COTAL_LAUNCH_MATERIAL);
  }
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
