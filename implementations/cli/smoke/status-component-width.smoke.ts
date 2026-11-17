/** Live component-health layout under real terminals. The owned stack has a real broker,
 * delivery daemon and Manager, but no agents. Piped rows keep their one-line shape; narrow terminal
 * rows retain the verdict and every fact without leaving the terminal to wrap the whole record.
 * Set COTAL_SMOKE_RETAIN_FIXTURES=1 to keep the private fixture after its processes stop. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, displayWidth, MANAGER_PIDFILE, verifyIdentityPin } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { COTAL, cotalPty, nodePty, screen, wait, type Pty } from "./_console-pty.js";
import { ownedBirthLive } from "./_foreground-owned-child.js";

const fixture = mkdtempSync(join(tmpdir(), "cotal-component-width-"));
const root = join(fixture, "root"), home = join(fixture, "home");
for (const path of [root, join(root, ".cotal"), home]) mkdirSync(path, { recursive: true, mode: 0o700 });
const space = "component-width";
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && !/^(COTAL_|CLAUDE_|ANTHROPIC_|OPENAI_|JCODE_)/i.test(key)) env[key] = value;
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_HOME: join(home, "machine"), COTAL_SKIP_CONNECTOR_SEED: "1", TERM: "xterm-256color", NO_COLOR: "1" });
const sandbox = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME!, xdgConfigHome: env.XDG_CONFIG_HOME! });
const { check, finish } = createSuite();
const loader = import.meta.resolve("tsx");
const sessions: { pty: Pty; exited: boolean }[] = [];

function cli(label: string, args: string[], timeout = 90_000) {
  assertSmokeSandboxDown(sandbox, args, { cwd: root, env });
  const result = spawnSync(process.execPath, ["--import", loader, COTAL, ...args], { cwd: root, env, encoding: "utf8", timeout });
  writeFileSync(join(fixture, `${label}.json`), JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
  assert.ifError(result.error);
  return result;
}

async function terminal(label: string, pty: Pty, cols: number) {
  const session = { pty, exited: false };
  sessions.push(session);
  let raw = "", code: number | undefined;
  pty.onData((data) => { raw += data; });
  pty.onExit((event) => { code = event.exitCode; session.exited = true; });
  const end = Date.now() + 60_000;
  while (!session.exited && Date.now() < end) await wait(25);
  writeFileSync(join(fixture, `${label}.raw`), raw);
  assert.ok(session.exited, `${label}: terminal child must exit within its budget`);
  const text = await screen(raw, cols, 240);
  writeFileSync(join(fixture, `${label}.txt`), text);
  return { code, text };
}

const health = (text: string) => text.split("Component Health")[1]?.trim() ?? "";
const row = (text: string, name: string) => health(text).split("\n").find((line) => new RegExp(`^\\s*${name}\\s+serving\\b`).test(line));
let started = false;
console.log(`component-width retained evidence: ${fixture}`);
try {
  const port = await freePort();
  started = true;
  const up = cli("up", ["up", "--detach", "--space", space, "--server", `nats://127.0.0.1:${port}`], 120_000);
  assert.equal(up.status, 0, "owned full stack must start before measuring layout");
  const args = ["status", "--components", "--space", space];
  const pipe = cli("pipe", args);
  assert.equal(pipe.status, 0, "healthy piped status is the serving control");
  for (const name of ["broker", "manager", "delivery"])
    assert.ok(row(pipe.stdout, name), `${name} must be serving before measuring layout`);
  check("piped manager and delivery facts remain on one line", row(pipe.stdout, "manager")!.includes("lease holder") && row(pipe.stdout, "manager")!.includes("default stop policy") && row(pipe.stdout, "delivery")!.includes("lease"));
  const pins = [join(root, ".cotal", "nats.pid"), canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space }), canonicalLocalProcessPath(DELIVERY_PIDFILE, { root, space })].map((path) => verifyIdentityPin(path));
  assert.ok(pins.every((pin) => pin.kind === "match"), "owned stack births must be pinned");
  const stableFacts = ["broker", "manager", "delivery"].flatMap((name) => row(pipe.stdout, name)!.split(" · ").slice(1))
    .filter((fact) => !fact.startsWith("stop impact ") && !fact.startsWith("lifecycle work "));
  for (const cols of [80, 120, 600]) {
    const geometry = await terminal(`geometry-${cols}`, nodePty(["-e", 'console.log(JSON.stringify({tty:process.stdout.isTTY,cols:process.stdout.columns}))'], { cwd: root, env, cols, rows: 240 }), cols);
    check(`terminal control reports ${cols} actual columns`, geometry.code === 0 && geometry.text.includes(`"tty":true,"cols":${cols}`), geometry);
    const view = await terminal(`status-${cols}`, cotalPty(args, { cwd: root, env, cols, rows: 240 }), cols);
    check(`${cols}-column status keeps the healthy exit`, view.code === pipe.status, view.code);
    for (const name of ["broker", "manager", "delivery"])
      check(`${cols}-column ${name} retains its serving verdict`, Boolean(row(view.text, name)));
    const lines = health(view.text).split("\n").filter((line) => line.trim());
    check(`${cols}-column component health fits without terminal hard wrapping`, lines.length > 3 && lines.every((line) => displayWidth(line) <= cols), lines.map((line) => ({ width: displayWidth(line), line })));
    const words = health(view.text).replace(/\s+/g, " ");
    check(`${cols}-column layout retains every stable piped fact`, stableFacts.every((fact) => words.includes(fact)), stableFacts.filter((fact) => !words.includes(fact)));
    if (cols === 600) check("a wide terminal keeps the compact manager row", row(view.text, "manager")!.includes(" · ") && row(view.text, "manager")!.includes("default stop policy"));
    for (const fact of ["lease holder", "service instance", "runtime pty", "stop impact", "default stop policy", "static reconciliation idle", "serve reachable"])
      check(`${cols}-column component health retains ${fact}`, words.includes(fact));
  }
  const down = cli("down", ["down", "--yes"], 120_000);
  assert.equal(down.status, 0, "owned stack teardown must succeed");
  started = false;
  check("the recorded owned stack births are gone", pins.every((pin) => pin.kind === "match" && !ownedBirthLive(pin.record)));
} finally {
  for (const session of sessions) if (!session.exited) session.pty.kill();
  if (started) {
    const down = cli("cleanup-down", ["down", "--yes"], 120_000);
    assert.equal(down.status, 0, "owned fixture cleanup must succeed");
  }
  if (process.env.COTAL_SMOKE_RETAIN_FIXTURES !== "1") rmSync(fixture, { recursive: true, force: true });
}
finish();
