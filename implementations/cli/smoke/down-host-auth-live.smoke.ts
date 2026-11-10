/** Hosting-folder shutdown reads infrastructure leases without an IdP session.
 * Runs the real CLI against isolated static and user-auth stacks, with a loopback JWKS fixture.
 * A missing delivery pidfile must still block shutdown while its real daemon renews its lease.
 * Needs nats-server on PATH. Run: pnpm smoke:down-host-auth:live (after pnpm build).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, MANAGER_PIDFILE, AUTH_PIDFILE, NATS_PIDFILE, parsePid } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { clean, cotalPty } from "./_console-pty.js";

const tree = resolve(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "cotal-down-host-auth-"));
console.log(`Sandbox retained at ${scratch}`);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let checks = 0;
const check = (message: string, condition: unknown, detail?: string) => { assert.ok(condition, detail ? `${message}\n${detail}` : message); checks++; console.log(`  ✓ ${message}`); };
const stacks: Array<{ root: string; space: string; pids: number[] }> = [];
let requests = 0;
const idp = createServer((_req, res) => {
  requests++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"keys":[]}');
});
await new Promise<void>((done) => idp.listen(0, "127.0.0.1", done));
const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;
let idpClosed = false;

async function cell(user: boolean): Promise<void> {
  const label = user ? "user" : "static";
  const root = join(scratch, label);
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(xdg, { mode: 0o700 });
  const space = `down-host-${label}`;
  const stack = { root, space, pids: [] as number[] };
  stacks.push(stack);
  const env = { ...inherited, HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" };
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
  const cli = async (...args: string[]) => {
    assertSmokeSandboxDown(sandbox, args, { cwd: root, env });
    const child = spawn(join(tree, "node_modules/.bin/tsx"), [join(tree, "bin/cotal.ts"), ...args], { cwd: root, env });
    let out = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { out += data; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    try {
      const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
      console.log(`${label}: cotal ${args[0]} exit=${code}\n${out}`);
      return { code, out };
    } finally { clearTimeout(timer); }
  };
  const server = `nats://127.0.0.1:${await pickFreePort()}`;
  const up = await cli("up", "--server", server, "--space", space, "--no-manager", ...(user ? ["--user-auth", "--idp", idpUrl] : []));
  for (const file of [DELIVERY_PIDFILE, AUTH_PIDFILE, NATS_PIDFILE]) {
    const path = canonicalLocalProcessPath(file, stack);
    if (existsSync(path)) {
      const pid = parsePid(readFileSync(path, "utf8"));
      if (pid !== undefined) stack.pids.push(pid);
    }
  }
  check(`${label}: shipped startup succeeds`, up.code === 0);
  check(`${label}: retained launcher, no controller journal or manager pidfile`, !existsSync(join(root, ".cotal/stack-controller.json")) && !existsSync(canonicalLocalProcessPath(MANAGER_PIDFILE, stack)));
  check(`${label}: recorded infrastructure processes are alive`, stack.pids.length === (user ? 3 : 2) && stack.pids.every(alive));
  let leaseRefusal: { code: number | null; out: string } | undefined;
  if (user) {
    await new Promise<void>((done, reject) => idp.close((error) => error ? reject(error) : done()));
    idpClosed = true;
    const before = requests;
    const delivery = canonicalLocalProcessPath(DELIVERY_PIDFILE, stack);
    renameSync(delivery, `${delivery}.held`);
    try {
      leaseRefusal = await cli("down", "--yes");
      check("user: lease refusal stops no recorded process", stack.pids.every(alive));
    } finally { renameSync(`${delivery}.held`, delivery); }
    check("user: local lease check does not contact the IdP", requests === before);
  }
  const refused = await cli("down");
  check(`${label}: noninteractive whole-stack stop requires --yes`, refused.code === 1 && refused.out.includes("requires --yes because there is no interactive terminal to ask in") && !refused.out.includes("Usage:"));
  check(`${label}: confirmation refusal leaves every recorded process alive`, stack.pids.every(alive));
  const preview = await cli("down", "--dry-run");
  check(`${label}: preview needs no confirmation and stops nothing`, preview.code === 4 && stack.pids.every(alive));
  if (!user) {
    const terminal = async (answer: string | undefined, flags: string[] = [], extraEnv: Record<string, string> = {}) => {
      assertSmokeSandboxDown(sandbox, ["down", ...flags], { cwd: root, env });
      const pty = cotalPty(["down", ...flags], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? join(home, "run"), TMPDIR: tmpdir(), DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1", ...extraEnv } });
      let out = "", code: number | undefined;
      pty.onData((data) => { out += data; });
      pty.onExit((event) => { code = event.exitCode; });
      try {
        if (answer !== undefined) {
          for (let end = Date.now() + 30_000; !clean(out).includes("type y to confirm") && code === undefined && Date.now() < end; await wait(50));
          check("terminal: the default-No confirmation shows its recorded components", clean(out).includes("type y to confirm") && clean(out).includes("nats-server") && clean(out).includes("delivery daemon"), clean(out));
          check("terminal: every recorded process stays alive before an answer", stack.pids.every(alive));
          pty.write(answer);
        }
        for (let end = Date.now() + 30_000; code === undefined && Date.now() < end; await wait(50));
        assert.notEqual(code, undefined, `terminal down did not exit: ${clean(out)}`);
        return { code, out: clean(out) };
      } finally {
        if (code === undefined) {
          pty.kill();
          for (let end = Date.now() + 10_000; code === undefined && Date.now() < end; await wait(50));
          assert.notEqual(code, undefined, "owned terminal process did not exit after cleanup");
        }
      }
    };
    for (const answer of ["\r", "n\r", "\x03"]) {
      const cancelled = await terminal(answer);
      check("terminal: empty, No or cancelled input stops nothing", cancelled.out.includes("Cancelled; no process was stopped.") && stack.pids.every(alive));
    }
    const noInput = await terminal(undefined, ["--no-input"]);
    check("terminal: --no-input refuses without a prompt", noInput.code === 1 && noInput.out.includes("--no-input forbids the prompt") && stack.pids.every(alive));
    const noPrompt = await terminal(undefined, [], { COTAL_NO_PROMPT: "1" });
    check("terminal: COTAL_NO_PROMPT refuses without a prompt", noPrompt.code === 1 && noPrompt.out.includes("COTAL_NO_PROMPT=1 forbids the prompt") && stack.pids.every(alive));
    const confirmed = await terminal("y\r");
    check("terminal: explicit Yes stops the whole stack", confirmed.code === 0);
  }
  const stopped = await cli("down", "--yes");
  check(`${label}: hosting-folder stop succeeds without a login`, stopped.code === 0);
  if (leaseRefusal) check("user: live delivery without a pidfile refuses for its renewed lease", leaseRefusal.code === 2 && leaseRefusal.out.includes("LIFECYCLE_BLOCKED") && leaseRefusal.out.includes("still renewing a lease"));
  for (let end = Date.now() + 10_000; stack.pids.some(alive) && Date.now() < end; await wait(100));
  check(`${label}: every recorded process exited`, stack.pids.every((pid) => !alive(pid)));
  const again = await cli("down");
  check(`${label}: repeated stop succeeds without a login`, again.code === 0);
}

try {
  await cell(false);
  await cell(true);
} finally {
  if (!idpClosed) await new Promise<void>((done) => idp.close(() => done()));
  // Only processes recorded by stacks this suite launched belong to this cleanup.
  for (const stack of stacks) {
    for (const file of [DELIVERY_PIDFILE, AUTH_PIDFILE, NATS_PIDFILE]) {
      const path = canonicalLocalProcessPath(file, stack);
      if (!existsSync(path)) continue;
      const pid = parsePid(readFileSync(path, "utf8"));
      if (pid !== undefined && !stack.pids.includes(pid)) stack.pids.push(pid);
    }
    for (const pid of stack.pids) if (alive(pid)) process.kill(pid, "SIGTERM");
    for (let end = Date.now() + 10_000; stack.pids.some(alive) && Date.now() < end; await wait(100));
    for (const pid of stack.pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    for (let end = Date.now() + 10_000; stack.pids.some(alive) && Date.now() < end; await wait(100));
    assert.ok(stack.pids.every((pid) => !alive(pid)), "all owned infrastructure processes exited");
  }
}
console.log(`down-host-auth: ${checks} checks passed`);
