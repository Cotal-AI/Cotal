/**
 * OpenCode boot-prompt regression test (no test runner) — the two halves of `cotal spawn --prompt`
 * on the OpenCode connector, measured at the seam each one owns.
 *
 * The defect: the connector built its launch spec from `opts` and never read `opts.prompt`, and the
 * plugin only ever drove a turn off the inbox — so a seat spawned with `--prompt` joined the roster,
 * loaded its persona, and then sat at zero messages until something else woke it. The text was
 * accepted at the CLI, documented as auto-submitted, and dropped in silence.
 *
 *   1. LAUNCH SPEC (no broker, no opencode): the spec carries the prompt on the env carrier the
 *      plugin reads, no prompt means no carrier at all, and a prompt with no text in it is refused
 *      at launch rather than started as a seat that ignores it.
 *   2. PLUGIN (a real mesh + a fake OpenCode HTTP server, no model and no `opencode` binary): a boot
 *      with a prompt issues EXACTLY ONE `prompt_async` carrying that text, and later readiness
 *      events (a turn end, a `/new` top-level session) do not issue a second one; a boot without a
 *      prompt issues none at all.
 *
 * Run: pnpm smoke:opencode-boot-prompt
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { opencodeConnector } from "../src/extension.js";
import { cotal } from "../src/plugin.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// ── 1. the launch spec: does the connector hand the prompt over at all? ──────────────────────────
const BOOT_TEXT = "Introduce yourself in #general, then wait.";
{
  const withPrompt = opencodeConnector.buildLaunch({ space: "bootspace", name: "boot-1", prompt: BOOT_TEXT });
  check(
    "the launch spec carries the initial prompt to the plugin",
    withPrompt.env?.COTAL_OPENCODE_PROMPT === BOOT_TEXT,
    withPrompt.env?.COTAL_OPENCODE_PROMPT,
  );
  // The prompt must NOT ride argv or the opencode config layer: argv is visible to the attached TUI
  // and to every `ps` on the box, and OPENCODE_CONFIG_CONTENT is opencode's own schema.
  check(
    "the initial prompt does not ride argv",
    !withPrompt.args.some((a) => a.includes(BOOT_TEXT)),
    withPrompt.args,
  );
  check(
    "the initial prompt does not ride the opencode config layer",
    !(withPrompt.env?.OPENCODE_CONFIG_CONTENT ?? "").includes(BOOT_TEXT),
    withPrompt.env?.OPENCODE_CONFIG_CONTENT,
  );

  const noPrompt = opencodeConnector.buildLaunch({ space: "bootspace", name: "boot-2" });
  check(
    "no initial prompt means no carrier in the launch spec",
    !("COTAL_OPENCODE_PROMPT" in (noPrompt.env ?? {})),
    noPrompt.env?.COTAL_OPENCODE_PROMPT,
  );

  // A prompt the connector cannot turn into a turn is refused at launch — never accepted and dropped.
  let refused = "";
  try {
    opencodeConnector.buildLaunch({ space: "bootspace", name: "boot-3", prompt: "   " });
  } catch (e) {
    refused = (e as Error).message;
  }
  check("a blank initial prompt is refused at launch, not silently ignored", /empty/i.test(refused), refused);
}

// ── 2. the plugin: does a boot with a prompt actually drive a turn? ──────────────────────────────
async function freePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "ocboot";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const nats = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, dir);
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;

// A fake OpenCode HTTP server: hand the plugin a session id and record every turn it drives.
let sessionSeq = 0;
let sessionID = "";
const prompts: { session: string; text: string }[] = [];
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) {
    res.writeHead(401).end();
    return;
  }
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session") {
      sessionID = `ses_boot_${++sessionSeq}`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: sessionID }));
      return;
    }
    const m = req.url?.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (req.method === "POST" && m) {
      const body = raw ? (JSON.parse(raw) as { parts?: { text?: string }[] }) : {};
      prompts.push({ session: decodeURIComponent(m[1]), text: (body.parts ?? []).map((p) => p.text ?? "").join("\n") });
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocPort = (oc.address() as { port: number }).port;

// The plugin reads its identity from COTAL_* env (it runs inside the opencode process). Scrub any
// managed-agent env inherited by this smoke itself; stale creds/links would point at the wrong broker.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
Object.assign(process.env, {
  COTAL_SPACE: space,
  COTAL_SERVERS: servers,
  COTAL_SUBSCRIBE: "general",
  COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${ocPort}`,
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "test-secret",
});

type PluginHooks = Awaited<ReturnType<typeof cotal>>;
const fire = (hooks: PluginHooks, event: unknown) => hooks.event!({ event } as never);
/** The plugin keeps ONE mesh endpoint per process behind a global guard, so a second arm has to
 *  clear it — otherwise `cotal()` hands back the first arm's hooks and the arm grades nothing. */
const clearPluginGuard = () => delete (globalThis as { __cotalOpencodeHooks?: unknown }).__cotalOpencodeHooks;
const waitForPrompts = async (n: number, ms = 8000): Promise<void> => {
  for (let i = 0; i < ms / 100 && prompts.length < n; i++) await sleep(100);
};

let armA: PluginHooks | undefined;
let armB: PluginHooks | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { general: { replay: false } } } });

  // ARM A — booted WITH a prompt. Exactly one turn, carrying that text.
  process.env.COTAL_NAME = "Booty";
  process.env.COTAL_ID = "booty";
  process.env.COTAL_OPENCODE_PROMPT = BOOT_TEXT;
  clearPluginGuard();
  armA = await cotal();
  await waitForPrompts(1);
  check("a boot prompt drives a turn without any peer traffic", prompts.length === 1, prompts);
  check("the boot turn carries the operator's prompt text", prompts[0]?.text.includes(BOOT_TEXT) === true, prompts[0]);

  // …and only one. A turn end and a `/new` top-level session are both readiness events that drive;
  // neither may re-issue the boot prompt.
  await fire(armA, { type: "session.idle", properties: { sessionID } });
  await fire(armA, {
    type: "session.created",
    properties: { info: { id: "ses_boot_new", parentID: undefined } },
  });
  await fire(armA, { type: "session.idle", properties: { sessionID: "ses_boot_new" } });
  await sleep(1500);
  check("no later readiness event re-issues the boot prompt", prompts.length === 1, prompts);

  await armA.dispose?.();
  armA = undefined;

  // ARM B — booted WITHOUT a prompt. The connector's `--prompt`-less spawn must stay silent: the
  // control that says arm A measured the prompt and not merely "the plugin prompts at boot".
  delete process.env.COTAL_OPENCODE_PROMPT;
  process.env.COTAL_NAME = "Quiety";
  process.env.COTAL_ID = "quiety";
  const before = prompts.length;
  clearPluginGuard();
  armB = await cotal();
  await sleep(3000);
  check("a boot with no prompt drives no turn at all", prompts.length === before, prompts.slice(before));

  console.log(`\nOPENCODE BOOT-PROMPT TEST PASSED ✅  (${pass} checks)`);
} finally {
  await armA?.dispose?.();
  await armB?.dispose?.();
  nats.kill("SIGKILL");
  oc.close();
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(0);
