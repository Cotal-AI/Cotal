/**
 * Hook / management credential split (no broker, no live service).
 *
 * The hook relay must keep working with its session-owned credential, but that credential can never
 * authorize an `op`. Management frames need a separate credential, the exact Binding fence it was
 * minted for, and a live revocation check on every request. Run directly with:
 *
 *   pnpm exec tsx extensions/connector-core/smoke/control-credential-split.smoke.ts
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { MeshAgent } from "../src/agent.js";
import { startControlServer } from "../src/control.js";
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

const hook = controlEndpoint("credential-split", "hook");
const binding = { bindingId: "binding-credential-split", controllerEpoch: 7 } as const;
const endpoint = {
  ...hook,
  management: { token: randomBytes(32).toString("base64url"), binding },
};
const events: unknown[] = [];
let shutdowns = 0;
let sessions = 0;
let managementCurrent = true;
const server = startControlServer(
  stubAgent,
  endpoint,
  async (_agent, event) => {
    events.push(event);
    return { handled: true };
  },
  {
    onShutdown: () => shutdowns++,
    onSession: () => {
      sessions++;
      return "session-credential-split";
    },
    authorizeManagement: (candidate) =>
      managementCurrent && candidate.bindingId === binding.bindingId && candidate.controllerEpoch === binding.controllerEpoch,
  },
);

try {
  await listening(server);

  const hookShutdown = await sendFrame(endpoint.path, { token: endpoint.token, op: "shutdown" });
  check("hook credential on shutdown receives no management reply", hookShutdown === "");
  check("hook credential on shutdown never runs onShutdown", shutdowns === 0, { shutdowns });

  const hookSession = await sendFrame(endpoint.path, { token: endpoint.token, op: "session" });
  check("hook credential on session receives no management reply", hookSession === "");
  check("hook credential on session never runs onSession", sessions === 0, { sessions });

  for (const op of ["input", "stop", "resize"] as const) {
    const reply = await sendFrame(endpoint.path, { token: endpoint.token, op });
    check(`hook credential on ${op} is refused before the hook handler`, reply === "" && events.length === 0);
  }

  const hookReply = await sendFrame(endpoint.path, {
    token: endpoint.token,
    event: { hook_event_name: "SessionStart", ordinary: true },
  });
  check("ordinary hook event still succeeds with the hook credential", hookReply.trim() === JSON.stringify({ handled: true }));
  check("ordinary hook event reaches the hook handler intact", JSON.stringify(events.at(-1)) === JSON.stringify({ hook_event_name: "SessionStart", ordinary: true }));

  const managementFrame = {
    token: endpoint.management.token,
    bindingId: binding.bindingId,
    controllerEpoch: binding.controllerEpoch,
  };
  const sessionReply = await sendFrame(endpoint.path, { ...managementFrame, op: "session" });
  check("current management credential can query the bound session", sessionReply.includes("session-credential-split"));
  check("management session query never reaches the hook handler", events.length === 1, { events: events.length });

  const shutdownReply = await sendFrame(endpoint.path, { ...managementFrame, op: "shutdown" });
  check("current management credential can invoke shutdown on its exact binding fence", shutdownReply.trim() === JSON.stringify({ ok: true }));
  check("current management credential runs onShutdown exactly once", shutdowns === 1, { shutdowns });

  const staleEpoch = await sendFrame(endpoint.path, { ...managementFrame, controllerEpoch: binding.controllerEpoch - 1, op: "shutdown" });
  check("management credential with a stale controller epoch is refused", staleEpoch === "" && shutdowns === 1);
  const wrongBinding = await sendFrame(endpoint.path, { ...managementFrame, bindingId: "retired-binding", op: "session" });
  check("management credential for another binding is refused", wrongBinding === "" && sessions === 1);

  managementCurrent = false;
  const retiredOldPath = await sendFrame(endpoint.path, { ...managementFrame, op: "shutdown" });
  check("retired manager credential fails on the old still-listening control path", retiredOldPath === "" && shutdowns === 1);
  const retiredOldSession = await sendFrame(endpoint.path, { ...managementFrame, op: "session" });
  check("retired manager credential fails for session on the old path", retiredOldSession === "" && sessions === 1);
  const hookAfterRetire = await sendFrame(endpoint.path, { token: endpoint.token, event: { hook_event_name: "Stop" } });
  check("ordinary hooks keep working after manager authority is retired", hookAfterRetire.trim() === JSON.stringify({ handled: true }) && events.length === 2);

  const nextHook = controlEndpoint("credential-split", "next");
  const nextEndpoint = {
    ...nextHook,
    management: {
      token: randomBytes(32).toString("base64url"),
      binding: { bindingId: "binding-credential-split-next", controllerEpoch: binding.controllerEpoch + 1 },
    },
  };
  const nextEvents: unknown[] = [];
  let nextShutdowns = 0;
  const nextServer = startControlServer(
    stubAgent,
    nextEndpoint,
    async (_agent, event) => ((nextEvents.push(event)), { handled: "next" }),
    { onShutdown: () => nextShutdowns++, authorizeManagement: () => true },
  );
  try {
    await listening(nextServer);
    const retiredNewPath = await sendFrame(nextEndpoint.path, { ...managementFrame, op: "shutdown" });
    check("retired manager credential fails on the replacement control path", retiredNewPath === "" && nextShutdowns === 0);
    const newHookReply = await sendFrame(nextEndpoint.path, { token: nextEndpoint.token, event: { hook_event_name: "SessionStart" } });
    check("replacement path hooks remain independent of retired management authority", newHookReply.trim() === JSON.stringify({ handled: "next" }) && nextEvents.length === 1);
  } finally {
    nextServer.close();
  }

  for (const badToken of [undefined, null, 7, {}, "x"]) {
    const beforeEvents = events.length;
    const beforeShutdowns = shutdowns;
    const reply = await sendFrame(endpoint.path, { token: badToken, event: { hook_event_name: "Bad" } });
    check("malformed hook credentials are dropped before handle without throwing", reply === "" && events.length === beforeEvents && shutdowns === beforeShutdowns, { badToken });
  }
  for (const badToken of [undefined, null, 7, {}, "x"]) {
    const beforeEvents = events.length;
    const beforeShutdowns = shutdowns;
    const reply = await sendFrame(endpoint.path, { token: badToken, bindingId: binding.bindingId, controllerEpoch: binding.controllerEpoch, op: "shutdown" });
    check("malformed management credentials are dropped before effects without throwing", reply === "" && events.length === beforeEvents && shutdowns === beforeShutdowns, { badToken });
  }

  const oversized = await new Promise<string>((resolve) => {
    const sock = connect(endpoint.path);
    let settled = false;
    const finish = (result: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), 4_000);
    sock.on("connect", () => sock.write("x".repeat((1 << 20) + 1)));
    sock.on("close", () => finish("closed"));
    sock.on("error", () => finish("closed"));
  });
  check("MAX_FRAME_BYTES still drops an oversized unauthenticated frame", oversized === "closed");
  const afterFlood = await sendFrame(endpoint.path, { token: endpoint.token, event: { hook_event_name: "AfterFlood" } });
  check("control server still serves hooks after the oversized frame", afterFlood.trim() === JSON.stringify({ handled: true }));

  const deadlineDrop = await new Promise<string>((resolve) => {
    const sock = connect(endpoint.path);
    let settled = false;
    const finish = (result: string): void => {
      if (settled) return;
      settled = true;
      clearInterval(dribble);
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already closed */ }
      resolve(result);
    };
    let dribble: ReturnType<typeof setInterval>;
    const timer = setTimeout(() => finish("timeout"), 8_000);
    sock.on("connect", () => {
      dribble = setInterval(() => {
        if (sock.destroyed) return;
        try { sock.write("x"); } catch { /* close/error settles */ }
      }, 500);
    });
    sock.on("close", () => finish("closed"));
    sock.on("error", () => finish("closed"));
  });
  check("AUTH_DEADLINE_MS still drops a slow unauthenticated frame", deadlineDrop === "closed");

  assert.throws(
    () => startControlServer(stubAgent, controlEndpoint("credential-split", "blocked"), async () => ({}), { onShutdown: () => {} }),
    /control plane BLOCKED: management handlers require a separate management credential/,
  );
  pass++;
  console.log("  ✓ legacy single-token management setup fails BLOCKED instead of falling back");
  assert.throws(
    () => startControlServer(
      stubAgent,
      { ...controlEndpoint("credential-split", "same-secret", "same-secret"), management: { token: "same-secret", binding } },
      async () => ({}),
      { onShutdown: () => {}, authorizeManagement: () => true },
    ),
    /control plane BLOCKED: hook and management credentials resolve to the same secret/,
  );
  pass++;
  console.log("  ✓ identical hook and management secrets fail BLOCKED instead of faking a split");
  for (const badBinding of [
    { bindingId: "", controllerEpoch: 1 },
    { bindingId: "binding", controllerEpoch: 0 },
    { bindingId: "binding", controllerEpoch: Number.NaN },
  ]) {
    assert.throws(
      () => startControlServer(
        stubAgent,
        { ...controlEndpoint("credential-split", `bad-fence-${pass}`), management: { token: "management-token", binding: badBinding } },
        async () => ({}),
        { onShutdown: () => {}, authorizeManagement: () => true },
      ),
      /control plane BLOCKED: management credential carries an invalid Binding.bindingId or controllerEpoch/,
    );
    pass++;
    console.log("  ✓ invalid management Binding fence fails BLOCKED before listen");
  }
} finally {
  server.close();
}

console.log(`\nCONTROL CREDENTIAL SPLIT TESTS PASSED ✅  (${pass} checks)`);
