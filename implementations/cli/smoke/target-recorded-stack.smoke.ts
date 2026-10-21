/**
 * A project root whose own stack recorded a broker, with no space registered for it, is never given
 * the default broker address. After a failed `cotal up`, `whoami`, `status`, `ps`, `who` and
 * `endpoints` in that root used to target nats://127.0.0.1:4222 while the stack journal recorded
 * another port, so any broker on the default port would have been dialed. They now refuse as not
 * started, name the recorded broker and say how to start it.
 *
 * The journal is written by hand in the shape `cotal up` leaves when its broker never started; the
 * resolver reads only its server field. Driven through the built binary in a sandboxed COTAL_HOME.
 * No broker is started.
 *
 * Run: pnpm smoke:target-recorded-stack
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: { space?: string | null } | null;
  result: { selected?: { resolved: boolean; code?: string; message?: string } } | null;
  error?: { code: string; message: string; remedy?: string };
}

const RECORDED = "nats://127.0.0.1:24711";
const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-recorded-stack-"));
const root = realpathSync(mkdtempSync(join(home, "project-")));
mkdirSync(join(root, ".cotal"), { mode: 0o700 });
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });
const noDefault = (r: ReturnType<typeof run>) => !`${r.stdout}${r.stderr}`.includes(":4222");

const before = run(["whoami", "--json"]);
check("control: with nothing recorded, the root still resolves, so the journal is what changes it", before.status === 0 && before.envelope?.outcome === "ok", shown(before));

const now = new Date().toISOString();
const member = (role: string, definition: string, state: string) => ({ role, definition, instanceId: null, state });
writeFileSync(join(root, ".cotal", "stack-controller.json"), JSON.stringify({
  schemaVersion: 1, kind: "cotal-stack-controller", root, space: "la07", server: RECORDED, mode: "open",
  members: [member("broker", "stack-broker", "refused"), member("auth", "stack-auth", "not-attempted"), member("delivery", "stack-delivery", "not-attempted"), member("manager", "stack-manager", "not-attempted")],
  operation: { id: randomUUID(), kind: "up", phase: "refused", recordedAt: now, withAgents: false },
  updatedAt: now,
}, null, 2) + "\n", { mode: 0o600 });

for (const command of ["whoami", "ps", "who", "endpoints"]) {
  const r = run([command, "--json"]);
  check(`${command} refuses as not started, exit 2`, r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "TARGET_UNAVAILABLE", shown(r));
  check(`${command} names the recorded broker and the way to start it`, (r.envelope?.error?.message ?? "").includes("127.0.0.1:24711") && /cotal up/.test(r.envelope?.error?.remedy ?? ""), r.envelope?.error);
  check(`${command} names no default broker address`, noDefault(r), shown(r));
}

const status = run(["status", "--json"]);
check("status reads the machine and selects no space", (status.status === 0 || status.status === 4) && status.envelope?.target?.space === null, shown(status));
check("status reports the selection as not started at the recorded broker", status.envelope?.result?.selected?.resolved === false && status.envelope.result.selected.code === "not-started" && (status.envelope.result.selected.message ?? "").includes("127.0.0.1:24711"), status.envelope?.result?.selected);
check("status names no default broker address", noDefault(status), shown(status));

const components = run(["status", "--components"]);
check("status --components refuses the target and probes no default broker", /target\s+refused · not-started/.test(components.stdout) && noDefault(components), shown(components));

finish();
process.exit(process.exitCode ?? 0);
