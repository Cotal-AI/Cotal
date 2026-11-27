/**
 * The hook relay holds an event its connector is still answering, and only that event, and the
 * control server tells a handler when its hook's connection closes.
 *
 * A tool permission waits on a person for as long as they take, so the relay must not give up on it
 * after the 2 s every other event keeps. The 2 s still bound the dial and the server's proof of a
 * held event; only a request sent to a proven server waits with no deadline. While a handler runs,
 * its context's signal aborts when the hook's connection closes, and it stays as it was once the
 * reply was written. Each cell drives the shipped relay in its own process against the shipped
 * control server.
 *
 * Run: pnpm smoke:hook-relay-hold
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import type { ControlEndpoint } from "@cotal-ai/core";
import { startControlServer, type HookContext, type HookEvent } from "../src/control.js";
import type { MeshAgent } from "../src/agent.js";
import { controlEndpoint } from "../src/runtime.js";

const { check, finish } = createSuite();
const child = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "hook-relay-held-child.ts");
// The loader runs in the relay's own process, so killing that pid kills the relay itself.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];

/** Run the relay on `event` in its own process, holding `PermissionRequest`. */
function relay(endpoint: ControlEndpoint, event: Record<string, unknown>) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
  const run = spawn(process.execPath, ["--import", tsx, child], {
    env: {
      ...env, COTAL_NAME: "hold-probe", COTAL_CONTROL_SOCKET: endpoint.path, COTAL_CONTROL_KEY: endpoint.token,
      COTAL_CONTROL_VERSION: String(endpoint.version), RELAY_HOLDS: "PermissionRequest",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  run.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
  run.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
  const done = new Promise<{ reply: string[]; stderr: string; endedAt: number }>((resolve) => run.on("close", () =>
    resolve({ reply: stdout.split("\n").filter(Boolean), stderr, endedAt: performance.now() })));
  run.stdin.end(JSON.stringify(event));
  return { run, done };
}

interface Seen { at: number; signal: AbortSignal; abortedAtReply?: boolean; abortedAt?: number }
const seen = new Map<string, Seen>();
const replies = new Map<string, { delivered: boolean; handoff: boolean }>();
const key = (ev: HookEvent) => String(ev.cell);

const endpoint = controlEndpoint("hook-relay-hold", "probe", dirs);
const server: Server = startControlServer({} as MeshAgent, endpoint, async (_agent, ev, ctx: HookContext) => {
  const s: Seen = { at: performance.now(), signal: ctx?.signal };
  seen.set(key(ev), s);
  ctx?.signal?.addEventListener("abort", () => (s.abortedAt = performance.now()), { once: true });
  if (ev.mode === "until-closed") {
    await new Promise<void>((resolve) => (ctx?.signal ? ctx.signal.addEventListener("abort", () => resolve(), { once: true }) : setTimeout(resolve, 3_000)));
    return {};
  }
  await wait(3_000);
  s.abortedAtReply = ctx?.signal?.aborted;
  return { answered: ev.cell };
}, { onReply: (ev, delivered, handoff) => replies.set(key(ev), { delivered, handoff }) });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));

try {
  console.log("\nthe held path");
  {
    const r = await relay(endpoint, { hook_event_name: "PermissionRequest", cell: "held" }).done;
    const s = seen.get("held");
    const heldMs = s ? r.endedAt - s.at : -1;
    check(`a held event outlives the relay's 2 s and prints the reply that came at 3 s (${Math.round(heldMs)} ms)`,
      heldMs >= 2_900 && r.reply.join("\n") === JSON.stringify({ answered: "held" }), r);
    await wait(100);
    check("the held reply's receipt reaches the server", replies.get("held")?.delivered === true && replies.get("held")?.handoff === true, replies.get("held"));
    check("the handler's signal had not aborted while the hook waited", s?.abortedAtReply === false, s);
    await wait(200);
    check("the signal stays as it was once the reply was written and the hook closed", s?.signal?.aborted === false && s?.abortedAt === undefined, s);
  }
  {
    const r = await relay(endpoint, { hook_event_name: "UserPromptSubmit", cell: "unheld" }).done;
    const s = seen.get("unheld");
    const ms = s ? r.endedAt - s.at : Infinity;
    check(`any other event still ends at 2 s with no reply (${Math.round(ms)} ms after the server had it)`,
      ms < 2_500 && r.reply.length === 0 && /may have been handled/.test(r.stderr), r);
    await wait(1_200);
    check("its late reply is not delivered", replies.get("unheld")?.delivered === false, replies.get("unheld"));
  }
  {
    // A listener in the endpoint's private directory that accepts and never proves itself: the held
    // event has no request sent, so nothing waits on it past the bounds every event has.
    const stand = controlEndpoint("hook-relay-hold", "stand-in", dirs);
    const silent = createServer((sock) => sock.resume()); // accept, read, say nothing
    await new Promise<void>((resolve) => silent.listen(stand.path, () => resolve()));
    const started = performance.now();
    const r = await relay(stand, { hook_event_name: "PermissionRequest", cell: "unproven" }).done;
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    const ms = r.endedAt - started;
    check(`a held event to a listener that never proves itself ends with no reply (${Math.round(ms)} ms)`, ms < 3_500 && r.reply.length === 0, r);
  }

  console.log("\nthe close signal");
  {
    const w = relay(endpoint, { hook_event_name: "PermissionRequest", cell: "killed", mode: "until-closed" });
    for (let i = 0; i < 100 && !seen.has("killed"); i++) await wait(20);
    await wait(300);
    const s = seen.get("killed");
    check("the handler holds a signal that has not aborted while the hook is alive", s?.signal instanceof AbortSignal && !s.signal.aborted, s);
    const killedAt = performance.now();
    w.run.kill("SIGKILL");
    await w.done;
    for (let i = 0; i < 50 && s?.abortedAt === undefined; i++) await wait(20);
    check(`the signal aborts when the hook is killed before its reply (${s?.abortedAt === undefined ? "never" : `${Math.round(s.abortedAt - killedAt)} ms`})`,
      s?.abortedAt !== undefined && s.abortedAt - killedAt < 1_000, s);
    await wait(100);
    check("the reply written after the close is not delivered", replies.get("killed")?.delivered === false, replies.get("killed"));
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
finish();
