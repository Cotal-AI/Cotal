/**
 * HERMES VALIDATES OUTSIDE OUR PROCESS, SO THE BRIDGE IS WHERE THE CLOSED OBJECT HAS TO BITE.
 *
 * The descriptors go to a Python sidecar, which hands them to the gateway; tool CALLS then come back
 * over the bridge socket as raw JSON. Whatever the gateway does or does not check, the object that
 * arrives at `onTool` is the model's, untouched by anything of ours. So publishing
 * `additionalProperties: false` is only half the guarantee here — advertising a rule across a
 * process boundary is not enforcing it, and a host that advertises without enforcing looks covered
 * while the unmodelled key sails through to the tool.
 *
 * WHAT THIS FILE ASSERTS, against the real descriptors and the real bridge socket:
 *   1. tools with arguments are published                       <- the control
 *   2. every one of them is published `additionalProperties: false`
 *   3. a `tool` frame carrying identity-shaped extras is REFUSED back over the socket
 *   4. the refusal names the rejected keys and the accepted ones
 *   5. ...and the tool's `run` never executes
 *
 * (5) is what separates a refusal from a report: a strip would also produce a plausible-looking
 * result frame, having already done the thing with the wrong arguments.
 *
 * Run: pnpm smoke:hermes-tool-closed
 */
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, cotalToolSpecs, type MeshAgent } from "@cotal-ai/connector-core";
import { startBridgeServer } from "../src/bridge.js";
import { hermesToolDescriptors } from "../src/tool-schema.js";

if (process.platform === "win32") {
  console.log("✓ hermes tool-closed skipped on Windows (the Hermes connector is Unix-only)");
  process.exit(0);
}

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

process.env.COTAL_SPACE ||= "toolclosed";
process.env.COTAL_NAME ||= "hermes-1";
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";
const config = configFromEnv();

// ── 1-2. what the sidecar is handed ──
const descriptors = hermesToolDescriptors(config);
const withArgs = descriptors.filter((d) => Object.keys((d.parameters as { properties?: object }).properties ?? {}).length > 0);
check("tools with arguments are published to the sidecar, so the closure assertion grades a non-empty set",
  withArgs.length > 0, { descriptors: descriptors.length, withArgs: withArgs.length });
const open = withArgs.filter((d) => (d.parameters as { additionalProperties?: unknown }).additionalProperties !== false);
check(`every published descriptor with arguments is CLOSED (${withArgs.length} tools)`,
  open.length === 0, { open: open.map((d) => d.name) });

// ── 3-5. what the bridge does with a call ──
const TOOL = "cotal_status"; // optional args only: the extras are the ONLY reason a call can fail
const spec = cotalToolSpecs(config, "hermes").find((s) => s.name === TOOL);
if (!spec?.schema) throw new Error(`${TOOL} is no longer a schema-bearing tool — repoint this suite`);
const accepted = Object.keys(spec.schema.shape);

// The bridge subscribes to the agent and pumps the inbox at startup, so the stub answers exactly
// that much and treats anything else as the tool having run.
class InertAgent extends EventEmitter {
  reached: string[] = [];
  peekInbox() { return []; }
  drainInbox() { return []; }
  inboxCount() { return 0; }
}
const agent = new InertAgent();
const guarded = new Proxy(agent as unknown as MeshAgent, {
  get(target, prop, recv) {
    if (prop in target) return Reflect.get(target, prop, recv);
    agent.reached.push(String(prop)); // the tool ran: recorded, not thrown, so cell 5 can report it
    return () => undefined;
  },
});

const dir = mkdtempSync(join(tmpdir(), "cotal-hermes-closed-"));
const socketPath = join(dir, "bridge.sock");
const bridge = startBridgeServer(guarded, config, socketPath);

const IDENTITY_EXTRA = { owner: "u_attacker", actor: "someone-else" };
try {
  const sock = connect(socketPath);
  await once(sock, "connect");
  const replies: Record<string, unknown>[] = [];
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) replies.push(JSON.parse(line) as Record<string, unknown>);
    }
  });

  sock.write(`${JSON.stringify({ t: "tool", id: "probe", name: TOOL, args: { ...IDENTITY_EXTRA } })}\n`);
  const deadline = Date.now() + 5_000;
  let result: Record<string, unknown> | undefined;
  while (!result && Date.now() < deadline) {
    result = replies.find((r) => r.t === "tool_result" && r.id === "probe");
    if (!result) await new Promise((r) => setTimeout(r, 25));
  }
  sock.destroy();

  const error = String(result?.error ?? "");
  check("a tool frame carrying identity-shaped extras is REFUSED back over the bridge socket",
    !!result && result.ok === false, { result });
  check("the refusal names the rejected keys AND lists what the tool accepts",
    Object.keys(IDENTITY_EXTRA).every((k) => error.includes(k)) && accepted.every((k) => error.includes(k)),
    { error, accepted });
  check("...and the refusal precedes the effect: the tool never reached the mesh agent",
    agent.reached.length === 0, { reached: agent.reached });
} finally {
  await bridge.stop?.();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "HERMES-TOOL-CLOSED SMOKE OK ✅" : "HERMES-TOOL-CLOSED SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
