/**
 * OPENCODE 2.x: A SETUP THE HOST REFUSES STARTS NOTHING (#4042).
 *
 * `setupCotal` awaits the host's hook and tool registrations. When one of them rejects, `setup`
 * rejects and returns no teardown, so nothing can ever stop an agent it had already queued to
 * start. The start must therefore be queued after the last step that can throw.
 *
 * Runs against a private broker, with an independent observer reading presence.
 *
 *   A.  session.hook("prompt") rejects -> setup rejects, the agent never joins
 *   A2. tool.transform rejects         -> setup rejects, the agent never joins
 *   B.  every registration resolves    -> the agent joins, and its teardown takes it offline (control)
 *
 * Run: pnpm smoke:opencode-setup-refused
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable } from "@cotal-ai/core";
import { killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { setupCotal } from "../src/plugin2.js";
import { fakeOpenCode2Context, type FakeOpenCode2Context } from "./_boot-plugin.js";
import { pickFreePort } from "./_free-port.js";

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SPACE = "setuprefused";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}oc-setup-refused-`));
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const nats = spawn("nats-server", ["-js", "-n", SMOKE_BROKER_TOKEN, "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, SMOKE_BROKER_TOKEN)], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, root);
const present = new Map<string, string>(); // name -> last presence event type
let observer: CotalEndpoint | undefined;

async function arm(name: string, refuse?: (ctx: FakeOpenCode2Context) => void): Promise<{ error?: string; teardown?: () => Promise<void> }> {
  for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
  Object.assign(process.env, {
    COTAL_SPACE: SPACE,
    COTAL_NAME: name,
    COTAL_ID: name.toLowerCase(),
    COTAL_SERVERS: servers,
    COTAL_OPENCODE_SERVER_URL: "http://127.0.0.1:9", // never answers; no model pin, so nothing waits on it
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: "test-secret",
  });
  delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;
  const ctx = fakeOpenCode2Context();
  refuse?.(ctx);
  try {
    const teardown = await setupCotal(ctx);
    return { teardown: teardown as () => Promise<void> };
  } catch (e) {
    ctx.end();
    return { error: (e as Error).message };
  }
}

try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  observer = new CotalEndpoint({ space: SPACE, servers, card: { name: "observer", kind: "agent", id: "observer" }, channels: [] });
  observer.on("error", () => {});
  observer.on("presence", (event: { type: string; presence: { card: { name: string } } }) => present.set(event.presence.card.name, event.type));
  await observer.start();

  console.log("A. session.hook(\"prompt\") rejects");
  const a = await arm("RefusedPrompt", (ctx) => {
    ctx.session.hook = async () => {
      throw new Error("host refused session.hook prompt");
    };
  });
  check("setup rejects with the host's error", a.error === "host refused session.hook prompt", a);

  console.log("A2. tool.transform rejects");
  const a2 = await arm("RefusedTransform", (ctx) => {
    ctx.tool.transform = async () => {
      throw new Error("host refused tool.transform");
    };
  });
  check("setup rejects with the host's error", a2.error === "host refused tool.transform", a2);

  console.log("B. every registration resolves (control)");
  const b = await arm("Accepted");
  check("setup returns a teardown", typeof b.teardown === "function", b);
  // One window covers all three arms: the refused ones had as long as the control to join.
  for (let i = 0; i < 100 && present.get("Accepted") === undefined; i++) await sleep(100);
  await sleep(3000);
  check("the accepted agent joins (the observer can see a join)", present.has("Accepted") && present.get("Accepted") !== "offline", [...present]);
  check("the agent whose prompt registration was refused never joins", !present.has("RefusedPrompt"), [...present]);
  check("the agent whose tool registration was refused never joins", !present.has("RefusedTransform"), [...present]);
  await b.teardown?.();
  for (let i = 0; i < 100 && present.get("Accepted") !== "offline"; i++) await sleep(100);
  check("the accepted agent's teardown takes it offline", present.get("Accepted") === "offline", [...present]);
} finally {
  await observer?.stop().catch(() => {});
  await killAndAwaitExit(nats);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
