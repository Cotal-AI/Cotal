/**
 * LIVE: bare `cotal down` on a legacy `up -f` stack whose manager pidfile was moved while the
 * manager keeps renewing its lease. The broker stays up and down exits 2, LIFECYCLE_BLOCKED,
 * naming the manager. The pidfile is then put back and bare down stops the stack.
 *
 * REAL broker on a free port. Sandboxes COTAL_HOME and the project root. Needs nats-server on PATH.
 * Run: pnpm smoke:down-pidfile-liveness:live
 */
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, MANAGER_PIDFILE, parsePid } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `pidlive${process.pid}`;
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-pidlive-home-"));
const root = mkdtempSync(join(tmpdir(), `cotal-${SPACE}-`));
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(TSX, [CLI, ...args], options);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });
const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const pidPath = () => canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space: SPACE });
const readPid = (path: string) => parsePid(readFileSync(path, "utf8"));

const manifest = join(root, "mesh.yaml");
writeFileSync(manifest, `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "${SERVER}", auth: false }
channels:
  general: { description: Open coordination. }
`);

let managerPid: number | undefined;
let aside: string | undefined;
try {
  const up = cli("up", "-f", manifest, "--detach");
  ok("legacy up -f starts the stack", up.status === 0, up.stdout + up.stderr);
  const recorded = pidPath();
  managerPid = existsSync(recorded) ? readPid(recorded) : undefined;
  ok("the recorded manager is alive", alive(managerPid), { pid: managerPid, path: recorded });
  ok("the broker is listening", await portOpen(PORT));

  // The manager renews at a quarter of its 30s lease. One interval proves the lease is current.
  await sleep(8_000);
  aside = join(home, "manager.pid");
  renameSync(recorded, aside);
  ok("the manager pidfile is gone from the stack root", !existsSync(recorded));

  const refused = cli("down", "--yes");
  const text = `${refused.stdout ?? ""}${refused.stderr ?? ""}`;
  ok(
    "bare down exits 2 and refuses LIFECYCLE_BLOCKED, naming the manager",
    refused.status === 2 && text.includes("LIFECYCLE_BLOCKED") && /manager has no pidfile/.test(text),
    { status: refused.status, text },
  );
  ok("the manager is still alive", alive(managerPid));
  ok("the broker port is still up", await portOpen(PORT));

  renameSync(aside, recorded);
  aside = undefined;
  ok("the manager pidfile is back", existsSync(recorded) && readPid(recorded) === managerPid);
  const outputRefusal = cli("down", "--yes", "--json");
  const { outcome, error } = JSON.parse(outputRefusal.stdout);
  const retry = /^run `[^`]+ (down --yes)` from this root without --json or --plain/.exec(error?.remedy)?.[1];
  ok("legacy down refuses JSON without stopping anything and keeps confirmation in the retry",
    outputRefusal.status === 2 && outputRefusal.stderr === "" && outcome === "refused" && error?.code === "UNSUPPORTED"
    && retry !== undefined && alive(managerPid) && await portOpen(PORT), outputRefusal);
  const scoped = cli("down", "--space", SPACE, "--yes", "--json");
  const scopedRetry = /^run `[^`]+ (down --yes)` from this root/.exec(JSON.parse(scoped.stdout).error?.remedy)?.[1];
  ok("a confirmed scoped stop offers the same retry for the local startup registration", scoped.status === 2 && scopedRetry === retry, scoped);
  const unconfirmed = cli("down", "--space", SPACE, "--json");
  ok("a scoped stop without confirmation does not add it", unconfirmed.status === 2 && !JSON.parse(unconfirmed.stdout).error.remedy.includes("--yes"), unconfirmed);
  const other = cli("down", "--space", `${SPACE}-other`, "--yes", "--json");
  ok("a different space is never offered a confirmed local stop", other.status === 2 && !JSON.parse(other.stdout).error.remedy.includes("down --yes"), other);
  const stopped = cli(...scopedRetry!.split(" "));
  const stoppedText = `${stopped.stdout ?? ""}${stopped.stderr ?? ""}`;
  ok("the advertised retry exits 0 without interactive input", stopped.status === 0, stoppedText);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    gone = !alive(managerPid) && !(await portOpen(PORT));
    if (!gone) await sleep(250);
  }
  ok("the restored down stops the manager and the broker", gone, { manager: alive(managerPid), port: await portOpen(PORT) });
  const restarted = cli("up", "-f", manifest, "--detach");
  ok("legacy stack starts for reused pid cleanup", restarted.status === 0, restarted.stdout + restarted.stderr);
  const unrelated = [spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }), spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })];
  try {
    for (const [index, file] of [MANAGER_PIDFILE, DELIVERY_PIDFILE].entries()) {
      const path = canonicalLocalProcessPath(file, { root, space: SPACE });
      if (!existsSync(path)) continue;
      const pid = readPid(path)!;
      const token = readFileSync(`${path}.identity`, "utf8").trim().split(" ")[1]!;
      process.kill(pid, "SIGKILL");
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
      writeFileSync(path, String(unrelated[index]!.pid));
      writeFileSync(`${path}.identity`, `${unrelated[index]!.pid} ${token}`);
    }
    const cleared = cli("down", "--yes");
    const text = cleared.stdout + cleared.stderr;
    ok("down clears reused pid records and stops the later broker", cleared.status === 0 && !(await portOpen(PORT)), text);
    ok("the unrelated processes remain untouched", unrelated.every((child) => alive(child.pid)));
    ok("the stale records and pins are removed without escaped newlines", !existsSync(pidPath()) && !existsSync(`${pidPath()}.identity`) && !text.includes("\\u000a"), text);
  } finally {
    for (const child of unrelated) child.kill("SIGKILL");
  }
  console.log(`\ndown-pidfile-liveness live: ${pass} checks passed`);
  emitSentinel({ passed: pass, failed: 0 });
} finally {
  if (aside && existsSync(aside) && !existsSync(pidPath())) {
    try { renameSync(aside, pidPath()); } catch { /* the stop below still runs */ }
  }
  cli("down", "--yes");
  if (alive(managerPid)) { try { process.kill(managerPid!, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
