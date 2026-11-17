/**
 * `cotal status` does not wait behind a command that is changing the installation. Loading a
 * connector's provider queues behind that command for as long as it runs, so status reports the
 * command, leaves the application rows unread, says the report is partial and returns. With nobody
 * changing the installation it reads the rows as before.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME. This process holds the closure lock,
 * as a `cotal setup` that prepares connectors does. No broker is started.
 *
 * Run: pnpm smoke:status-installation-changing
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-status-changing-"));
const root = mkdtempSync(join(home, "project-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, ".cotal"), { recursive: true, mode: 0o700 });
process.env.COTAL_HOME = join(home, ".cotal");
const { acquireLock } = await import("@cotal-ai/workspace");

interface Envelope { completeness?: string; warnings: { code: string; message: string; target: { pid?: number } | null }[]; result: { machine: { integrations: unknown[] } } | null }
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
/** Runs the binary without blocking this process, which may be the one holding the lock. */
async function run(args: string[]) {
  const t0 = Date.now();
  const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(stdout) as Envelope; } catch { envelope = undefined; }
  return { status, stdout, stderr, envelope, ms: Date.now() - t0 };
}
const shown = (r: Awaited<ReturnType<typeof run>>) => ({ status: r.status, ms: r.ms, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });
const changing = (r: Awaited<ReturnType<typeof run>>) => r.envelope?.warnings.filter((w) => w.code === "INSTALLATION_CHANGING") ?? [];

const free = await run(["status", "--json"]);
check("control: with nobody changing the installation, status names no such command", (free.status === 0 || free.status === 4) && free.envelope !== undefined && changing(free).length === 0, shown(free));

const lock = acquireLock(join(home, ".cotal", ".update-closure.lock"), { label: "fixture closure writer" });
try {
  const json = await run(["status", "--json"]);
  check("status returns while another command holds the installation, without waiting for it", json.status === 4 && json.ms < 30_000, shown(json));
  check("its warning names that command by pid and says the application rows were not read",
    changing(json).length === 1 && changing(json)[0]!.target?.pid === process.pid && changing(json)[0]!.message === `another cotal command (pid ${process.pid}) is changing this installation, so the application rows were not read`, json.envelope?.warnings);
  check("the report is partial and carries no application rows", json.envelope?.completeness === "partial" && json.envelope.result?.machine.integrations.length === 0, { completeness: json.envelope?.completeness, integrations: json.envelope?.result?.machine.integrations });
  const plain = await run(["status", "--plain"]);
  check("the text report says so on stderr and names the next step",
    plain.status === 4 && plain.stderr.includes(`another cotal command (pid ${process.pid}) is changing this installation`) && plain.stdout.includes("run `cotal status` again when that command finishes") && !plain.stderr.includes("waiting for another cotal command"), shown(plain));
} finally {
  lock.release();
}

const after = await run(["status", "--json"]);
check("once that command is done, status reads as before", (after.status === 0 || after.status === 4) && changing(after).length === 0, shown(after));

finish();
process.exit(process.exitCode ?? 0);
