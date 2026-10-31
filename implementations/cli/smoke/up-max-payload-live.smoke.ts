/**
 * LIVE: `cotal up --max-payload <bytes>` must SERVE the limit and KEEP it across a plain later `up`.
 *
 * `serverConfig` has taken a `maxPayload` for as long as service endpoint caller grants have needed
 * one (they refuse below 2098176), but no flag passed it and `broker-policy.json` did not record it,
 * so `up` could not render it at all and a value written into `server.conf` by hand was lost the
 * next time `up` wrote the file. A hosted renderer outside `up` reads the recorded value, so the
 * record is what makes the two renders agree.
 *
 * Driven through the REAL binary as a subprocess, against a REAL broker, and judged on what the
 * broker SERVES, not on what the file says: `max_payload` is read off the `INFO` line the listener
 * sends on a raw socket. A text assertion alone would pass against a config that nats-server
 * ignored, and the failure this closes is precisely "the flag was accepted and nothing rendered it".
 *
 *  1. `up --max-payload N` renders `max_payload: N`, records it, and the listener advertises N.
 *  2. a running broker refuses a different `--max-payload`: the value is fixed at its start.
 *  3. `down`, then a PLAIN `up` with no flag renders and serves N again from the record.
 *
 * Sandboxes COTAL_HOME and a project root under a scratch base with proven-clean `.cotal` ancestry;
 * kills only its own children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-max-payload:live  (BUILD FIRST - the subprocess runs built dist.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";

const scratch = makeScratch("cotal-up-maxpayload-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
process.env.COTAL_HOME = home;

const { authDir } = await import("@cotal-ai/workspace");
const { SERVICE_CALLER_PAYLOAD_FLOOR } = await import("@cotal-ai/core");

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
// Loading tsx into node makes the child the CLI itself; the `.bin/tsx` shim would relay only SIGINT
// and SIGTERM and orphan it.
const TSX_IMPORT = import.meta.resolve("tsx");

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** The ambient environment with every `COTAL_` key stripped, then this smoke's own sandbox put
 *  back: a suite run from a mesh-joined session would otherwise point the real CLI at the caller's
 *  mesh and pass while doing it. Enforced by bin/smoke/suite-ambient-env.smoke.ts. */
const sandboxEnv = (() => {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) if (key.startsWith("COTAL_")) delete copy[key];
  return { ...copy, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
})();

const kids: ChildProcess[] = [];
async function run(args: string[]): Promise<{ status: number | null; out: string }> {
  const options = { cwd: root, env: sandboxEnv, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(sandbox, args, options);
  const cp = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  kids.push(cp);
  let out = "";
  cp.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { out += b.toString(); });
  await once(cp, "exit");
  return { status: cp.exitCode, out };
}

/** The `max_payload` the LISTENER advertises on its `INFO` greeting, or undefined when no greeting
 *  arrived. A raw socket needs no credential to read it. */
function servedMaxPayload(port: number, timeoutMs = 5_000): Promise<number | undefined> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    const done = (v: number | undefined) => { try { sock.destroy(); } catch { /* already gone */ } res(v); };
    sock.setTimeout(timeoutMs, () => done(undefined));
    sock.on("error", () => done(undefined));
    sock.on("close", () => done(undefined));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      try { done((JSON.parse(buf.slice(0, nl).replace(/^INFO\s+/, "")) as { max_payload?: number }).max_payload); }
      catch { done(undefined); }
    });
  });
}

const confText = () => readFileSync(join(authDir(root), "server.conf"), "utf8");
const recordedPayload = () => (JSON.parse(readFileSync(join(root, ".cotal", "broker-policy.json"), "utf8")) as { maxPayload?: number }).maxPayload;

try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "up max-payload fixture");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "payload";
  const asked = SERVICE_CALLER_PAYLOAD_FLOOR;

  console.log(`1) cotal up --max-payload ${asked}`);
  const first = await run(["up", "--detach", "--no-manager", "--space", space, "--server", server, "--max-payload", String(asked)]);
  ok("up --max-payload exits 0", first.status === 0, first.out.slice(-1500));
  ok("…and renders max_payload into the broker config", confText().includes(`\nmax_payload: ${asked}\n`), confText().split("\n").filter((l) => l.startsWith("max_payload")));
  ok("…and records it in the broker policy", recordedPayload() === asked, recordedPayload());
  ok("…and the listener ADVERTISES it, so the broker is serving the limit", await servedMaxPayload(port) === asked, await servedMaxPayload(port));

  console.log("\n2) a running broker refuses a different --max-payload");
  const conflict = await run(["up", "--space", space, "--server", server, "--max-payload", String(asked + 4096)]);
  ok("a different --max-payload on a running broker exits non-zero", conflict.status !== 0, { status: conflict.status, out: conflict.out.slice(-800) });
  ok("…naming that the limit is fixed at start and the `cotal down` that frees it",
    conflict.out.includes("can't change --max-payload") && conflict.out.includes("cotal down"), conflict.out.slice(-800));
  ok("…and changes neither the record nor what is served", recordedPayload() === asked && await servedMaxPayload(port) === asked);

  console.log("\n3) down, then a PLAIN up renders the recorded limit again");
  const down = await run(["down", "--yes"]);
  ok("down exits 0", down.status === 0, down.out.slice(-1500));
  const again = await run(["up", "--detach", "--no-manager", "--space", space, "--server", server]);
  ok("a plain up with no flag exits 0", again.status === 0, again.out.slice(-1500));
  ok("…and renders the recorded max_payload again", confText().includes(`\nmax_payload: ${asked}\n`), confText().split("\n").filter((l) => l.startsWith("max_payload")));
  ok("…and the restarted listener still advertises it", await servedMaxPayload(port) === asked, await servedMaxPayload(port));
  ok("…and the record is unchanged", recordedPayload() === asked, recordedPayload());

  const last = await run(["down", "--yes"]);
  ok("the final down exits 0", last.status === 0, last.out.slice(-1500));
  console.log(`\nup-max-payload live smoke: OK - ${pass} checks`);
} finally {
  for (const cp of kids) { try { cp.kill("SIGKILL"); } catch { /* already gone */ } }
}
