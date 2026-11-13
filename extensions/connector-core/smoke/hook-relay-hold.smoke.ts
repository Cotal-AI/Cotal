/**
 * The hook relay holds an event its connector is still answering, and only that event.
 *
 * A permission prompt waits on its owner for as long as it takes, so the relay must not give up on
 * it after its usual 2 s. Every other event keeps failing open at 2 s. The control server tells a
 * handler when its hook goes away before the reply, because a held prompt the harness answered
 * itself must stop waiting. Each cell drives the shipped relay in its own process against the
 * shipped control server.
 *
 * Run: pnpm smoke:hook-relay-hold
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:net";
import { startControlServer, type HookContext } from "../src/control.js";
import type { MeshAgent } from "../src/agent.js";
import { controlEndpoint } from "../src/runtime.js";

const child = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "hook-relay-child.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function relay(endpoint: { path: string; token: string }, event: Record<string, unknown>) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
  const run = spawn(process.execPath, [tsxCli, child], {
    env: { ...env, COTAL_NAME: "hold-probe", COTAL_CONTROL_SOCKET: endpoint.path, COTAL_CONTROL_TOKEN: endpoint.token, RELAY_HOLDS: "PermissionRequest" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  run.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
  const started = performance.now();
  const done = new Promise<{ reply: string[]; ms: number }>((resolve) => run.on("close", () =>
    resolve({ reply: stdout.split("\n").filter((l) => l && l !== "RELAY_READY"), ms: performance.now() - started })));
  run.stdin.end(JSON.stringify(event));
  return { run, done };
}

const endpoint = controlEndpoint("hook-relay-hold", "probe", "hook-relay-hold-token");
const gone: string[] = [];
const server: Server = startControlServer({} as MeshAgent, endpoint, async (_agent, ev, ctx?: HookContext) => {
  if (ev.hook_event_name === "Wait") {
    await new Promise<void>((resolve) => ctx?.signal.addEventListener("abort", () => resolve(), { once: true }));
    gone.push("aborted");
    return {};
  }
  await wait(3_000);
  return { answered: ev.hook_event_name };
});
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
try {
  const held = await relay(endpoint, { hook_event_name: "PermissionRequest" }).done;
  check(`a held event outlives the relay's 2 s and prints the reply that came at 3 s (${Math.round(held.ms)} ms)`,
    held.ms >= 2_900 && held.reply.join() === JSON.stringify({ answered: "PermissionRequest" }), held);
  const other = await relay(endpoint, { hook_event_name: "UserPromptSubmit" }).done;
  check(`any other event still fails open at 2 s with no reply (${Math.round(other.ms)} ms)`, other.ms < 2_900 && other.reply.length === 0, other);
  const waiting = relay(endpoint, { hook_event_name: "Wait" });
  await wait(1_500);
  waiting.run.kill("SIGTERM");
  await waiting.done;
  await wait(200);
  check("a handler's signal aborts when its hook is killed before the reply", gone.length === 1, gone);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
console.log(`\nhook-relay-hold smoke: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 && pass === 3 ? 0 : 1;
