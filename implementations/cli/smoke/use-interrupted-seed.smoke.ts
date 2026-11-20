/**
 * Bare `cotal use` only shows the selection, so an interrupted connector seed does not block it.
 * It used to run the seed prelude, find the crash cursor and exit 1 with "a previous connector seed
 * was interrupted", while `status`, `space` and `config` worked in the same state. Selecting a space
 * still runs the prelude, so it still refuses until `cotal ext seed --repair`.
 *
 * The crash cursor is written by hand in the shape the seed engine leaves when it is killed
 * mid-install. Driven through the built binary with a sandboxed HOME, XDG_CONFIG_HOME and
 * COTAL_HOME, and without COTAL_SKIP_CONNECTOR_SEED. No broker is started and nothing is installed.
 *
 * Run: pnpm smoke:use-interrupted-seed
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-use-seed-"));
const neutral = join(home, "neutral");
mkdirSync(neutral);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const seedDir = join(home, ".config", "cotal", "seed");
const cursor = join(seedDir, "reconcile.cursor.json");
const cursorContents = JSON.stringify({ nonce: "smoke-interrupted", package: "web", phase: "add" }) + "\n";
mkdirSync(seedDir, { recursive: true, mode: 0o700 });
writeFileSync(cursor, cursorContents, { mode: 0o600 });

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), NO_COLOR: "1", DO_NOT_TRACK: "1" };
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: neutral, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const json = run(["use", "--json"]);
let envelope: { outcome?: string; result?: { current?: string | null } } | undefined;
try { envelope = JSON.parse(json.stdout) as typeof envelope; } catch { envelope = undefined; }
check("bare use --json reads the selection, exit 0", json.status === 0 && envelope?.outcome === "ok" && envelope.result?.current === null, shown(json));
check("bare use does not mention the interrupted seed", !/interrupted/.test(json.stdout + json.stderr), shown(json));

const plain = run(["use"]);
check("bare use points an empty catalog at Cloud sign-in, exit 0", plain.status === 0 && plain.stdout.trim() === "no spaces are known here - sign in to Cotal Cloud with `cotal login`", shown(plain));
check("a read leaves the crash cursor for the repair", existsSync(cursor));

const select = run(["use", "nosuch"]);
check("control: selecting a space still runs the seed prelude and refuses on the cursor", select.status !== 0 && /a previous connector seed was interrupted/.test(select.stderr) && /cotal ext seed --repair/.test(select.stderr), shown(select));

const ext = run(["ext", "seed"]);
const refusal = ext.stderr.trim().replace(/^✗ /, "");
const text = run(["update", "--check"]);
const updateJson = run(["update", "--check", "--json"]);
const report = JSON.parse(updateJson.stdout);
check("update check reports the same seed refusal as ext, exits partial and leaves the cursor unchanged",
  ext.status === 1 && refusal.includes("a previous connector seed was interrupted") && refusal.includes("cotal ext seed --repair") &&
  text.status === 4 && /^Reconciliation\s/m.test(text.stdout) && text.stdout.replace(/\s+/g, " ").includes(refusal) &&
  updateJson.status === 4 && report.completeness === "partial" && report.error?.code === "OPERATION_PARTIAL" &&
  report.result.reconciliation.kind !== "none" && report.result.reconciliation.instruction === refusal &&
  report.warnings.some((warning: { message: string }) => warning.message === refusal) &&
  readFileSync(cursor, "utf8") === cursorContents,
  { ext: shown(ext), text: shown(text), json: shown(updateJson) });

finish();
process.exit(process.exitCode ?? 0);
