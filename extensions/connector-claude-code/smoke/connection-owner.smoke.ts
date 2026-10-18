/*
 * A hosted Cotal connection stays with the Claude Code session that opened it, through the shipped
 * hook bundle (`dist/hook.cjs`). The `cotal_connect` answer the hook records is the real gateway's,
 * served by `handleGatewayRequest` and read back over MCP, so a change to that text reddens here.
 * Another session using the id is refused on every hosted tool; the opener, its subagents and an id
 * the hook never saw opened pass. Only the opener's disconnect releases the record.
 *
 * Run: pnpm smoke:claude-connection-owner
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/connection-owner.json
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleGatewayRequest, type GatewayConnection, type GatewayHost } from "@cotal-ai/connector-core";
import { FORKED_REASON } from "../src/connection-owner.js";

const here = dirname(fileURLToPath(import.meta.url));
const hookBundle = join(here, "..", "dist", "hook.cjs");
const root = mkdtempSync(join(tmpdir(), "cotal-conn-owner-"));
const data = join(root, "plugin-data");

const clean = { ...process.env };
for (const key of Object.keys(clean)) if (key.startsWith("COTAL_") || key === "CLAUDE_PLUGIN_DATA") delete clean[key];
const PLAIN = { CLAUDE_PLUGIN_DATA: data };

function runHook(env: Record<string, string>, event: Record<string, unknown>): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookBundle], { env: { ...clean, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ stdout: out.trim(), code }));
    child.stdin.end(JSON.stringify(event));
  });
}

const HOSTED = "mcp__claude_ai_Cotal__";
const pre = (session_id: string, tool: string, connection_id: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse",
  session_id,
  tool_name: HOSTED + tool,
  tool_input: { connection_id },
  ...extra,
});
const post = (session_id: string, tool: string, tool_input: Record<string, unknown>, tool_response: unknown) => ({
  hook_event_name: "PostToolUse",
  session_id,
  tool_name: HOSTED + tool,
  tool_input,
  tool_response,
});

let pass = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  assert.ok(condition, `${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const refused = (r: { stdout: string; code: number | null }): boolean => {
  try {
    const out = (JSON.parse(r.stdout) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    return r.code === 0 && out?.permissionDecision === "deny" && out.permissionDecisionReason === FORKED_REASON;
  } catch {
    return false;
  }
};
const passed = (r: { stdout: string; code: number | null }): boolean => r.code === 0 && r.stdout === "";

// The real gateway surface with a host that opens nothing: cotal_connect only needs a name and an id.
const host: GatewayHost = {
  account: () => "acct",
  open: async (_account, name) => ({ id: randomUUID(), agent: {}, config: { name } }) as unknown as GatewayConnection,
  find: async () => undefined,
  close: async () => false,
};
const http = createServer((req, res) => {
  void handleGatewayRequest(host, { req, res, auth: { token: "t", clientId: "smoke", scopes: [], extra: { account: "acct" } } });
});
const port = await new Promise<number>((resolve) => http.listen(0, "127.0.0.1", () => resolve((http.address() as { port: number }).port)));
const client = new Client({ name: "connection-owner-smoke", version: "0.0.0" });

try {
  console.log("connection-owner smoke:");
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const connected = (await client.callTool({ name: "cotal_connect", arguments: { name: "parent" } })) as { content: { text?: string }[] };
  const id = /^connection_id: (\S+)$/m.exec(connected.content.map((c) => c.text ?? "").join("\n"))?.[1] ?? "";
  check("the real gateway answered cotal_connect with a connection_id", id.length > 0, connected.content);

  const opened = await runHook(PLAIN, post("sess-a", "cotal_connect", { name: "parent" }, connected.content));
  const record = join(data, "hosted-connections", id);
  check("the opening session's PostToolUse records it as the owner", passed(opened) && existsSync(record) && readFileSync(record, "utf8") === "sess-a", opened);

  check("the opener passes", passed(await runHook(PLAIN, pre("sess-a", "cotal_send", id))));
  check("a subagent of the opener passes", passed(await runHook(PLAIN, pre("sess-a", "cotal_send", id, { agent_id: "a7bf19f2", agent_type: "general-purpose" }))));
  const fork = await runHook(PLAIN, pre("sess-b", "cotal_roster", id));
  check("another session (a fork) is refused the opener's connection_id", refused(fork), fork);
  check("another session is refused cotal_disconnect on it too", refused(await runHook(PLAIN, pre("sess-b", "cotal_disconnect", id))));
  check("another session is refused cotal_send on it, as every hosted tool", refused(await runHook(PLAIN, pre("sess-b", "cotal_send", id))));
  check("an id no session here opened passes to the gateway", passed(await runHook(PLAIN, pre("sess-b", "cotal_roster", randomUUID()))));
  check("the local server's tools are not checked", passed(await runHook(PLAIN, { ...pre("sess-b", "cotal_send", id), tool_name: "mcp__plugin_cotal_cotal__cotal_send" })));

  await runHook(PLAIN, post("sess-a", "cotal_connect", { name: "x" }, [{ type: "text", text: "Connected as x.\nconnection_id: ../escape\n" }]));
  check("an id that is not a plain token is never written", !existsSync(join(data, "escape")) && !existsSync(join(data, "..", "escape")));

  await runHook(PLAIN, post("sess-b", "cotal_disconnect", { connection_id: id }, [{ type: "text", text: `Disconnected ${id}.` }]));
  check("another session's disconnect leaves the opener's record", existsSync(record) && readFileSync(record, "utf8") === "sess-a");
  await runHook(PLAIN, post("sess-a", "cotal_disconnect", { connection_id: id }, [{ type: "text", text: `Disconnected ${id}.` }]));
  check("the opener's disconnect releases the record", !existsSync(record));
  check("after that the id passes to the gateway again", passed(await runHook(PLAIN, pre("sess-b", "cotal_roster", id))));

  const nodata = await runHook({}, post("sess-c", "cotal_connect", { name: "c" }, connected.content));
  check("without a plugin data directory nothing is recorded", passed(nodata) && !existsSync(record));
  await runHook({ ...PLAIN, COTAL_NAME: "otto" }, post("sess-d", "cotal_connect", { name: "d" }, connected.content));
  check("a launched session records nothing (its hosted calls are refused before use)", !existsSync(record));

  // Claude Code runs the bundle only for the events and tools hooks.json names.
  const hooks = (JSON.parse(readFileSync(join(here, "..", "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> }).hooks;
  const postMatchers = (hooks.PostToolUse ?? []).filter((h) => h.hooks.some((c) => c.command.includes("dist/hook.cjs"))).map((h) => new RegExp(h.matcher ?? ""));
  const runsOn = (tool: string): boolean => postMatchers.some((m) => m.test(tool));
  check(
    "hooks.json runs the hook on PostToolUse for a hosted cotal_connect and cotal_disconnect, and not for other tools",
    runsOn(`${HOSTED}cotal_connect`) && runsOn(`${HOSTED}cotal_disconnect`) && !runsOn(`${HOSTED}cotal_send`) && !runsOn("Bash"),
    hooks.PostToolUse,
  );

  console.log(`connection-owner smoke: ${pass} passed`);
} finally {
  await client.close().catch(() => {});
  http.close();
  rmSync(root, { recursive: true, force: true });
}
