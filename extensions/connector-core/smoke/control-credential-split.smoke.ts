/** Hook / management credential split. No broker or live service. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import type { MeshAgent } from "../src/agent.js";
import { startControlServer, type ControlEndpoint } from "../src/control.js";
import { controlEndpoint } from "../src/runtime.js";

const stubAgent = {} as MeshAgent;
let pass = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  assert.ok(condition, `${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const listening = (server: ReturnType<typeof startControlServer>): Promise<void> =>
  new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
function sendFrame(path: string, frame: unknown, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(path);
    let reply = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already closed */ }
      resolve(reply);
    };
    const timer = setTimeout(finish, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(frame) + "\n"));
    sock.on("data", (chunk) => (reply += chunk));
    sock.on("end", finish);
    sock.on("close", finish);
    sock.on("error", finish);
  });
}

const fence = { resourceId: "resource-credential-split", bindingId: "binding-credential-split", controllerEpoch: 7 } as const;
const minted = controlEndpoint("credential-split", "hook", undefined, fence);
assert.ok(minted.management);
const endpoint: ControlEndpoint = {
  path: minted.path,
  token: minted.token,
  managementVerifier: { tokenDigest: minted.management.verifier.tokenDigest, fence },
};
const managementFrame = {
  token: minted.management.token,
  resourceId: fence.resourceId,
  bindingId: fence.bindingId,
  controllerEpoch: fence.controllerEpoch,
};
const events: unknown[] = [];
let shutdowns = 0;
let sessions = 0;
let managementCurrent = true;
const server = startControlServer(stubAgent, endpoint, async (_agent, event) => {
  events.push(event);
  return { handled: true };
}, {
  onShutdown: () => shutdowns++,
  onSession: () => ((sessions++), "session-credential-split"),
  authorizeManagement: (candidate) => managementCurrent && JSON.stringify(candidate) === JSON.stringify(fence),
});
try {
  await listening(server);
  check("child endpoint retains only a management digest, never the manager bearer", !("token" in endpoint.managementVerifier!) && endpoint.managementVerifier!.tokenDigest !== minted.management.token);

  check("hook credential on shutdown receives no management reply", await sendFrame(endpoint.path, { token: endpoint.token, op: "shutdown" }) === "");
  check("hook credential on shutdown never runs onShutdown", shutdowns === 0);
  check("hook credential on session receives no management reply", await sendFrame(endpoint.path, { token: endpoint.token, op: "session" }) === "");
  check("hook credential on session never runs onSession", sessions === 0);
  for (const op of ["input", "stop", "resize"])
    check(`hook credential on ${op} is refused before the hook handler`, await sendFrame(endpoint.path, { token: endpoint.token, op }) === "" && events.length === 0);

  const hookReply = await sendFrame(endpoint.path, { token: endpoint.token, event: { hook_event_name: "SessionStart", ordinary: true } });
  check("ordinary hook event still succeeds with the hook credential", hookReply.trim() === JSON.stringify({ handled: true }));
  check("ordinary hook event reaches the hook handler intact", events.length === 1);

  check("current management credential can query the bound session", (await sendFrame(endpoint.path, { ...managementFrame, op: "session" })).includes("session-credential-split"));
  check("management session query never reaches the hook handler", events.length === 1);
  check("current management credential can invoke shutdown on its exact binding fence", (await sendFrame(endpoint.path, { ...managementFrame, op: "shutdown" })).trim() === JSON.stringify({ ok: true }));
  check("current management credential runs onShutdown exactly once", shutdowns === 1);
  check("stale controller epoch is refused", await sendFrame(endpoint.path, { ...managementFrame, controllerEpoch: fence.controllerEpoch - 1, op: "shutdown" }) === "" && shutdowns === 1);
  check("wrong resource id is refused", await sendFrame(endpoint.path, { ...managementFrame, resourceId: "other-resource", op: "session" }) === "" && sessions === 1);
  check("wrong binding id is refused", await sendFrame(endpoint.path, { ...managementFrame, bindingId: "retired-binding", op: "session" }) === "" && sessions === 1);

  managementCurrent = false;
  check("retired manager credential fails on the old still-listening path", await sendFrame(endpoint.path, { ...managementFrame, op: "shutdown" }) === "" && shutdowns === 1);
  check("retired manager credential fails for session on the old path", await sendFrame(endpoint.path, { ...managementFrame, op: "session" }) === "" && sessions === 1);
  check("ordinary hooks keep working after manager retirement", (await sendFrame(endpoint.path, { token: endpoint.token, event: { hook_event_name: "Stop" } })).trim() === JSON.stringify({ handled: true }) && events.length === 2);

  const nextFence = { resourceId: "resource-next", bindingId: "binding-next", controllerEpoch: 8 } as const;
  const nextMinted = controlEndpoint("credential-split", "next", undefined, nextFence);
  assert.ok(nextMinted.management);
  const nextEndpoint: ControlEndpoint = {
    path: nextMinted.path,
    token: nextMinted.token,
    managementVerifier: { tokenDigest: nextMinted.management.verifier.tokenDigest, fence: nextFence },
  };
  let nextShutdowns = 0;
  const nextServer = startControlServer(stubAgent, nextEndpoint, async () => ({ handled: "next" }), {
    onShutdown: () => nextShutdowns++, authorizeManagement: () => true,
  });
  try {
    await listening(nextServer);
    check("retired manager credential fails on the replacement control path", await sendFrame(nextEndpoint.path, { ...managementFrame, op: "shutdown" }) === "" && nextShutdowns === 0);
    check("replacement path hooks remain independent", (await sendFrame(nextEndpoint.path, { token: nextEndpoint.token, event: { hook_event_name: "Start" } })).trim() === JSON.stringify({ handled: "next" }));
  } finally { nextServer.close(); }

  for (const badToken of [undefined, null, 7, {}, "x"]) {
    const before = [events.length, shutdowns];
    const hookBad = await sendFrame(endpoint.path, { token: badToken, event: { hook_event_name: "Bad" } });
    check("malformed hook credentials are dropped before effects without throwing", hookBad === "" && events.length === before[0] && shutdowns === before[1]);
    const managementBad = await sendFrame(endpoint.path, { token: badToken, ...managementFrame, op: "shutdown" });
    check("malformed management credentials are dropped before effects without throwing", managementBad === "" && events.length === before[0] && shutdowns === before[1]);
  }

  const oversized = await new Promise<string>((resolve) => {
    const sock = connect(endpoint.path); let done = false;
    const finish = (result: string): void => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(result); };
    const timer = setTimeout(() => finish("timeout"), 4_000);
    sock.on("connect", () => sock.write("x".repeat((1 << 20) + 1)));
    sock.on("close", () => finish("closed")); sock.on("error", () => finish("closed"));
  });
  check("MAX_FRAME_BYTES still drops an oversized unauthenticated frame", oversized === "closed");
  check("server still serves hooks after oversized frame", (await sendFrame(endpoint.path, { token: endpoint.token, event: { hook_event_name: "AfterFlood" } })).trim() === JSON.stringify({ handled: true }));

  const deadlineDrop = await new Promise<string>((resolve) => {
    const sock = connect(endpoint.path); let done = false; let dribble: ReturnType<typeof setInterval>;
    const finish = (result: string): void => { if (done) return; done = true; clearInterval(dribble); clearTimeout(timer); sock.destroy(); resolve(result); };
    const timer = setTimeout(() => finish("timeout"), 8_000);
    sock.on("connect", () => { dribble = setInterval(() => { if (!sock.destroyed) sock.write("x"); }, 500); });
    sock.on("close", () => finish("closed")); sock.on("error", () => finish("closed"));
  });
  check("AUTH_DEADLINE_MS still drops a slow unauthenticated frame", deadlineDrop === "closed");

  assert.throws(() => startControlServer(stubAgent, controlEndpoint("credential-split", "blocked"), async () => ({}), { onShutdown: () => {} }), /control plane BLOCKED: management handlers require/);
  check("legacy single-token management setup fails BLOCKED", true);
  const sameDigest = createHash("sha256").update("same-secret").digest("base64url");
  assert.throws(() => startControlServer(stubAgent, { ...controlEndpoint("credential-split", "same", "same-secret"), managementVerifier: { tokenDigest: sameDigest, fence } }, async () => ({}), { onShutdown: () => {}, authorizeManagement: () => true }), /hook and management credentials resolve to the same secret/);
  check("identical hook and management secrets fail BLOCKED", true);
  for (const badFence of [{ ...fence, resourceId: "" }, { ...fence, bindingId: "" }, { ...fence, controllerEpoch: 0 }]) {
    assert.throws(() => startControlServer(stubAgent, { ...controlEndpoint("credential-split", `bad-${pass}`), managementVerifier: { tokenDigest: sameDigest, fence: badFence } }, async () => ({}), { onShutdown: () => {}, authorizeManagement: () => true }), /invalid Binding.bindingId or controllerEpoch/);
    check("invalid management fence fails BLOCKED before listen", true);
  }
} finally { server.close(); }
console.log(`\nCONTROL CREDENTIAL SPLIT TESTS PASSED ✅  (${pass} checks)`);
