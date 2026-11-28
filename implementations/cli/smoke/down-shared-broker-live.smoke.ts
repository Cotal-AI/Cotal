/**
 * LIVE: `cotal down` on a controller stack whose broker address another registration names
 * refuses with LIFECYCLE_BLOCKED, exit 2, and the human refusal NAMES the blocking registration
 * with a usable next step.
 *
 * The broker is not stopped under the other registration, nothing is forgotten automatically, and
 * an active shared space is never implied safe to stop. The remedy names each registration with
 * its `space show` to read it, its `space forget --plain` to take it off the address once its own
 * stack is stopped, and the down to run again.
 *
 * Driven through the REAL binary as a subprocess, against a REAL broker. The failing case mirrors
 * the issue repro exactly (broker-only controller start, second name registered at the same
 * broker address), and the positive control mirrors the maintainer's: forget the extra
 * registration explicitly, then the same down exits 0 and closes the listener.
 *
 * Sandboxes COTAL_HOME and a project root under a scratch base with proven-clean `.cotal` ancestry;
 * kills only its own children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:down-shared-broker:live  (BUILD FIRST - the subprocess runs built dist.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import net from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { recordMesh } from "@cotal-ai/workspace";

const scratch = makeScratch("cotal-down-shared-broker-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const neighbor = join(root, "neighbor");
const oldNeighbor = join(root, "old-neighbor");
mkdirSync(neighbor, { recursive: true });
mkdirSync(oldNeighbor, { recursive: true });
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
process.env.COTAL_HOME = home;

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

/** Whether the loopback listener answers a TCP connect right now. */
function serving(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    const done = (v: boolean) => { try { sock.destroy(); } catch { /* already gone */ } res(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on("error", () => done(false));
    sock.on("connect", () => done(true));
  });
}

async function waitServing(port: number, want: boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await serving(port)) === want) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

type DownEnvelope = {
  target?: { space?: string; server?: string; spaces?: string[] };
  outcome?: string;
  error?: { code?: string; message?: string; remedy?: string };
};

/** The JSON envelope a `--json` run carries on stdout, or undefined when it carries none. */
const envelope = (out: string): DownEnvelope | undefined => {
  const line = out.split("\n").find((row) => row.startsWith("{"));
  if (!line) return undefined;
  try { return JSON.parse(line) as DownEnvelope; } catch { return undefined; }
};

/** Read one simple command displayed in Next, without assuming which launcher is on PATH. */
const nextCommand = (out: string, expected: string): string[] => {
  const printed = [...out.matchAll(/`(?:pnpm )?cotal ([^`]+)`/g)].map((m) => m[1]).find((cmd) => cmd === expected);
  if (!printed) throw new Error(`missing Next command ${expected}: ${out}`);
  return printed.split(" ");
};

try {
  assertScratchHeld(root, "down shared-broker fixture");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;

  const created = await run(["space", "create", "shared-down-owner", "--plain"]);
  ok("owner space is created", created.status === 0, created.out.slice(-500));

  const started = await run(["up", "--open", "--no-manager", "--space", "shared-down-owner", "--server", server]);
  ok("broker-only controller stack starts", started.status === 0 && (await waitServing(port, true)), started.out.slice(-800));

  const added = await run(["space", "add", "shared-neighbor", "--mode", "open", "--server", server, "--root", neighbor, "--force", "--yes"]);
  ok("second name registers at the same broker address", added.status === 0, added.out.slice(-500));
  recordMesh({ space: "-old", root: oldNeighbor, server, mode: "open", origin: "manual", ts: new Date().toISOString() });

  const down = await run(["down", "--yes"]);
  ok("down refuses LIFECYCLE_BLOCKED, exit 2, and keeps the guard's message",
    down.status === 2 && down.out.includes("LIFECYCLE_BLOCKED") && down.out.includes("a shared broker is not stopped in this cut"), down.out.slice(-1200));
  ok("the human refusal names the blocking registration",
    down.out.includes("shared-neighbor"), down.out.slice(-1200));
  ok("the Next step names the down to run again", down.out.includes("Next") && /then run `(?:pnpm )?cotal down --yes --space shared-down-owner`/.test(down.out), down.out.slice(-1200));
  ok("the refusal does not forget anything and never implies the shared space is safe to stop",
    !/forgot shared-neighbor/.test(down.out) && !/safe to stop/.test(down.out), down.out.slice(-1200));
  ok("the broker listener is still serving after the refusal", await serving(port));

  const downJson = await run(["down", "--yes", "--json"]);
  const env = envelope(downJson.out);
  ok("down --json exits 2 and records the blocking registration in target.spaces",
    downJson.status === 2 && env?.error?.code === "LIFECYCLE_BLOCKED" && ["shared-neighbor", "-old"].every((name) => env.target?.spaces?.includes(name)),
    downJson.out.slice(-800));
  ok("the structured remedy names the same show and forget steps",
    (env?.error?.remedy ?? "").includes("`cotal space show shared-neighbor`") &&
      (env?.error?.remedy ?? "").includes("`cotal space forget shared-neighbor --plain`") &&
      (env?.error?.remedy ?? "").includes("`cotal space show -- -old`") &&
      (env?.error?.remedy ?? "").includes("`cotal space forget --plain -- -old`"),
    env?.error?.remedy);

  const shown = await run(nextCommand(down.out, "space show shared-neighbor"));
  ok("the named registration reads back as a manual registration", shown.status === 0, shown.out.slice(-500));
  const forgotten = await run(nextCommand(down.out, "space forget shared-neighbor --plain"));
  ok("forgetting it explicitly exits 0", forgotten.status === 0, forgotten.out.slice(-500));
  const shownOld = await run(nextCommand(down.out, "space show -- -old"));
  ok("the printed show reads the retained -old registration and reports it reachable", shownOld.status === 0 && shownOld.out.includes("-old") && shownOld.out.includes("reachable"), shownOld.out);
  const forgottenOld = await run(nextCommand(down.out, "space forget --plain -- -old"));
  ok("the printed forget removes only the retained registration", forgottenOld.status === 0 && forgottenOld.out.includes("forgot -old"), forgottenOld.out);
  ok("the broker listener is still serving after the explicit forget", await serving(port));

  const retry = await run(nextCommand(env?.error?.remedy ?? "", "down --yes --space shared-down-owner --json"));
  ok("retrying down then exits 0 and stops the stack", retry.status === 0, retry.out.slice(-800));
  ok("the loopback listener closes after the retry down", await waitServing(port, false));

  console.log(`\ndown-shared-broker live smoke: OK - ${pass} checks`);
} finally {
  for (const cp of kids) { try { cp.kill("SIGKILL"); } catch { /* already gone */ } }
}
