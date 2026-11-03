/** OpenCode 2.x setup owns one completed session, never a refused attempt (#3329).
 *  Drives the shipped plugin bundle, a controlled host context, and a private broker observed by an
 *  independent endpoint. No model or OpenCode process is used. Run: pnpm smoke:opencode-setup-guard. */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable } from "@cotal-ai/core";
import { killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { fakeOpenCode2Context, type FakeOpenCode2Context } from "./_boot-plugin.js";
import { pickFreePort } from "./_free-port.js";

// The OpenCode host supplies require to the bundled Node dependencies.
(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url);
const bundleUrl = new URL("../dist/plugin/index.js", import.meta.url).href;
const { default: plugin } = await import(bundleUrl) as typeof import("../src/plugin.entry.js");
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const until = async (predicate: () => boolean): Promise<boolean> => {
  for (let i = 0; i < 100 && !predicate(); i++) await sleep(50);
  return predicate();
};
let passed = 0, failed = 0;
function check(name: string, condition: boolean): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
const EXPECTED = 17;
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}oc-setup-guard-`));
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "setupguard";
const broker = spawn("nats-server", ["-js", "-n", SMOKE_BROKER_TOKEN, "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, SMOKE_BROKER_TOKEN)], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
const contexts: FakeOpenCode2Context[] = [];
const cleanups: Array<() => Promise<void>> = [];
const present = new Map<string, string>();
let observer: CotalEndpoint | undefined;
const context = () => { const ctx = fakeOpenCode2Context(); contexts.push(ctx); return ctx; };
function launch(name: string): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
  Object.assign(process.env, {
    COTAL_HOME: join(root, "home"), COTAL_NAME: name, COTAL_ID: name.toLowerCase(), COTAL_SPACE: space,
    COTAL_SERVERS: servers, COTAL_EVENTS: "0", COTAL_OPENCODE_SERVER_URL: "http://127.0.0.1:9",
    OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "test-secret",
  });
}
// Isolate independent fixture arms only. No reset between the retry calls within an arm.
const fresh = () => { delete (globalThis as { __cotalOpencodeSetup?: unknown }).__cotalOpencodeSetup; };

try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  observer = new CotalEndpoint({ space, servers, card: { name: "observer", kind: "agent", id: "observer" }, channels: [] });
  observer.on("error", () => {});
  observer.on("presence", (event: { type: string; presence: { card: { name: string } } }) => present.set(event.presence.card.name, event.type));
  await observer.start();

  launch("Validation"); fresh();
  delete process.env.COTAL_OPENCODE_SERVER_URL;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  for (let call = 1; call <= 2; call++) {
    let error = "";
    try { await plugin.setup(context()); } catch (e) { error = (e as Error).message; }
    check(`missing credentials reject setup call ${call}`, error === "opencode connector: missing COTAL_OPENCODE_SERVER_URL/OPENCODE_SERVER_PASSWORD");
  }

  launch("BadFlag"); fresh(); process.env.COTAL_EVENTS = "yes,no";
  for (let call = 1; call <= 2; call++) {
    let error = "";
    try { await plugin.setup(context()); } catch (e) { error = (e as Error).message; }
    check(`invalid events flag rejects setup call ${call}`, /COTAL_EVENTS must be/.test(error));
  }

  launch("Refused"); fresh();
  const refused = context();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const refusal = new Error("host refused setup registration");
  refused.session.hook = async () => { entered = true; await gate; throw refusal; };
  const first = plugin.setup(refused);
  const second = plugin.setup(refused);
  const outcomes = Promise.allSettled([first, second]);
  let secondSettled = false;
  void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
  if (!(await until(() => entered))) throw new Error("the host registration was not reached");
  await sleep(25);
  check("concurrent setup waits for the in-flight registration", !secondSettled);
  release();
  const result = await outcomes;
  check("both concurrent callers receive the same refusal", result.every(r => r.status === "rejected" && r.reason === refusal));

  const retryContext = context();
  const retry = await plugin.setup(retryContext);
  if (typeof retry === "function") cleanups.push(retry);
  check("a retry after a host refusal returns a teardown", typeof retry === "function");
  check("the retry joins the real broker", typeof retry === "function" && await until(() => present.get("Refused") !== undefined && present.get("Refused") !== "offline"));
  retryContext.end();
  await retry?.();

  // Positive control: a fresh accepting setup joins even on the unchanged implementation.
  launch("Accepted"); fresh();
  const accepted = context();
  let allow!: () => void;
  const acceptingGate = new Promise<void>(resolve => { allow = resolve; });
  accepted.session.hook = async (name, fn) => { await acceptingGate; accepted.sessionHooks.set(name, fn); };
  const accepting = plugin.setup(accepted), concurrent = plugin.setup(accepted);
  allow();
  const [stop, sameStop] = await Promise.all([accepting, concurrent]);
  if (typeof stop === "function") cleanups.push(stop);
  check("accepting setup returns a teardown (control)", typeof stop === "function");
  check("concurrent successful callers share their teardown", typeof stop === "function" && stop === sameStop);
  check("the accepting session joins (control)", await until(() => present.get("Accepted") !== undefined && present.get("Accepted") !== "offline"));
  const later = context();
  check("a completed setup makes later location boots inert", await plugin.setup(later) === undefined && later.sessionHooks.size === 0);
  accepted.end(); await stop?.();
  check("teardown takes the accepting session offline", await until(() => present.get("Accepted") === "offline"));

  launch("Replacement");
  const replacementContext = context();
  const replacement = await plugin.setup(replacementContext);
  if (typeof replacement === "function") cleanups.push(replacement);
  check("setup can own a new session after teardown", typeof replacement === "function");
  check("the replacement joins", typeof replacement === "function" && await until(() => present.get("Replacement") !== undefined && present.get("Replacement") !== "offline"));
  await stop?.();
  const extra = context();
  check("an old teardown cannot clear the replacement's ownership", typeof replacement === "function" && await plugin.setup(extra) === undefined && extra.sessionHooks.size === 0);
  replacementContext.end(); await replacement?.();
  check("replacement teardown takes only its session offline", typeof replacement === "function" && await until(() => present.get("Replacement") === "offline"));

  if (passed + failed !== EXPECTED) throw new Error(`ran ${passed + failed} cells, expected ${EXPECTED}`);
} catch (error) { failed++; console.error(error); }
finally {
  for (const ctx of contexts) ctx.end();
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { failed++; console.error(error); }
  }
  try { await observer?.stop(); }
  finally { await killAndAwaitExit(broker); releaseBroker(); rmSync(root, { recursive: true, force: true }); }
}
console.log(`setup-guard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
