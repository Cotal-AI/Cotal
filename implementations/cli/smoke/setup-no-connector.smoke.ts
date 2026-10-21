/**
 * With no connector installed, setup names a next step that can run here and checks the harness it
 * was given. Its remedy used to be `cotal ext seed`, which a source checkout refuses, and
 * `--harness nosuch` got the same "no connector is installed" refusal as a real connector name.
 *
 * Driven through the built binary of this checkout in a sandboxed HOME, XDG_CONFIG_HOME and
 * COTAL_HOME with COTAL_SKIP_CONNECTOR_SEED=1, so no connector is installed. Nothing is seeded or
 * written.
 *
 * Run: pnpm smoke:setup-no-connector
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; error?: { code?: string; message?: string; remedy?: string } }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-setup-noconn-"));
const project = join(home, "project");
mkdirSync(project);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const setup = (harness: string, extra: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [BIN, "setup", "--destination", "local", "--harness", harness, "--project", project, "--space", "noconn", "--json"], { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof setup>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const unknown = setup("nosuch");
check("an unknown harness is a usage refusal, exit 1", unknown.status === 1 && unknown.envelope?.error?.code === "USAGE_INVALID", shown(unknown));
check("it names the harness and the official connectors", /no harness "nosuch"/.test(unknown.envelope?.error?.message ?? "") && /claude/.test(unknown.envelope?.error?.message ?? ""), unknown.envelope?.error);

const official = setup("claude");
check("rig: no connector is installed in the sandbox", official.status === 2 && official.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && /no connector is installed/.test(official.envelope.error.message ?? ""), shown(official));
check("from a checkout the remedy does not send the operator to a refused cotal ext seed alone", /not a released install/.test(official.envelope?.error?.remedy ?? "") && /COTAL_ALLOW_CHECKOUT_SEED=1/.test(official.envelope?.error?.remedy ?? ""), official.envelope?.error);

const optedIn = setup("claude", { COTAL_ALLOW_CHECKOUT_SEED: "1" });
check("control: where the seed would run, the remedy is cotal ext seed", optedIn.status === 2 && optedIn.envelope?.error?.remedy === "run `cotal ext seed`", optedIn.envelope?.error);

check("nothing was written to the project", !existsSync(join(project, ".cotal")));

finish();
process.exit(process.exitCode ?? 0);
