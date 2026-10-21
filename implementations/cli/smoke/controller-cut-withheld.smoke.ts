/**
 * A controller-owned stack cannot be preserved in this release. On a root with a stack journal,
 * `down --preserve-state`, `backup create`, `backup restore` and `up --restore` refuse `UNSUPPORTED`
 * (exit 2) while validating, before the confirmation, the seed or any manager request, and leave the
 * root's files as they were. The remedy names plain `cotal down`. One cell set runs per stack mode.
 * A root with no stack journal is not refused this way.
 *
 * The journal is written by hand in the shape a completed `cotal up` leaves; the refusal reads only
 * the journal, so no member is started. Driven through the built binary in a sandboxed COTAL_HOME,
 * with each root recorded as a smoke sandbox and every call checked by the shared down guard. No
 * broker is started.
 *
 * Run: pnpm smoke:controller-cut-withheld
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { assertSmokeSandboxDown, createSuite, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: { root?: string; space?: string } | null;
  error?: { code: string; message: string; remedy?: string };
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-cut-withheld-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
interface Sandbox { root: string; anchor: SmokeSandboxAnchor }
const run = (sandbox: Sandbox, args: string[]) => {
  const options = { cwd: sandbox.root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(sandbox.anchor, args, options);
  const r = spawnSync(process.execPath, [BIN, ...args], options);
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

/** Every path under the root with its kind, mode and content hash, so any write shows. */
function tree(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path), rel = relative(root, path);
      if (stat.isDirectory()) { rows.push(`d ${rel} ${stat.mode}`); walk(path); }
      else if (stat.isSymbolicLink()) rows.push(`l ${rel} ${readlinkSync(path)}`);
      else rows.push(`f ${rel} ${stat.mode} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(root);
  return rows.join("\n");
}

function newRoot(label: string): Sandbox {
  const root = realpathSync(mkdtempSync(join(home, `${label}-`)));
  mkdirSync(join(root, ".cotal"), { mode: 0o700 });
  return { root, anchor: recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME }) };
}

const modeApplies = (mode: string, role: string) => role === "auth" ? mode === "user" : role === "delivery" ? mode !== "open" : true;

for (const mode of ["auth", "open", "user"]) {
  const sandbox = newRoot(`project-${mode}`);
  const { root } = sandbox;
  const space = `cw-${mode}`;
  const now = new Date().toISOString();
  const member = (role: string) => modeApplies(mode, role)
    ? { role, definition: `stack-${role}`, instanceId: randomUUID(), state: "started" }
    : { role, definition: `stack-${role}`, instanceId: null, state: "not-attempted" };
  writeFileSync(join(root, ".cotal", "stack-controller.json"), JSON.stringify({
    schemaVersion: 1, kind: "cotal-stack-controller", root, space, server: "nats://127.0.0.1:24712", mode,
    members: ["broker", "auth", "delivery", "manager"].map(member),
    operation: { id: randomUUID(), kind: "up", phase: "completed", recordedAt: now, withAgents: false },
    updatedAt: now,
  }, null, 2) + "\n", { mode: 0o600 });
  const before = tree(root);
  const refusedHere = (r: ReturnType<typeof run>) => r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "UNSUPPORTED" && r.envelope.target?.root === root && r.envelope.target?.space === space;

  const preserve = run(sandbox, ["down", "--preserve-state", "--yes", "--json"]);
  check(`${mode}: down --preserve-state refuses UNSUPPORTED, exit 2, naming this root and space`, refusedHere(preserve), shown(preserve));
  check(`${mode}: the refusal says nothing was stopped or written`, /cannot be preserved in this release; nothing was stopped or written/.test(preserve.envelope?.error?.message ?? ""), preserve.envelope?.error);
  check(`${mode}: the remedy names plain cotal down and a later release`, /plain `cotal down`/.test(preserve.envelope?.error?.remedy ?? "") && /later release/.test(preserve.envelope?.error?.remedy ?? ""), preserve.envelope?.error);

  const unconfirmed = run(sandbox, ["down", "--preserve-state"]);
  check(`${mode}: without --yes the same refusal comes before the confirmation requirement`, unconfirmed.status === 2 && /cannot be preserved in this release/.test(unconfirmed.stderr) && !/requires --yes/.test(unconfirmed.stderr), shown(unconfirmed));

  const artifact = join(home, `artifact-${mode}`);
  const backup = run(sandbox, ["backup", "create", artifact, "--json"]);
  check(`${mode}: backup create refuses UNSUPPORTED, exit 2, and names the missing cut`, refusedHere(backup) && /^backup create needs a preserved cut/.test(backup.envelope?.error?.message ?? ""), shown(backup));
  check(`${mode}: backup create wrote no artifact`, !existsSync(artifact), artifact);

  const restore = run(sandbox, ["backup", "restore", artifact, "--json"]);
  check(`${mode}: backup restore refuses UNSUPPORTED, exit 2, and names the missing cut`, refusedHere(restore) && /^backup restore needs a preserved cut/.test(restore.envelope?.error?.message ?? ""), shown(restore));

  const upRestore = run(sandbox, ["up", "--restore", artifact, "--json"]);
  check(`${mode}: up --restore refuses UNSUPPORTED, exit 2, and names the missing cut`, refusedHere(upRestore) && /^up --restore needs a preserved cut/.test(upRestore.envelope?.error?.message ?? ""), shown(upRestore));

  check(`${mode}: no maintenance state was created`, !existsSync(join(root, ".cotal", "maintenance")), root);
  const after = tree(root);
  check(`${mode}: every file under the root, the stack journal included, is unchanged`, after === before, { before, after });
}

// Control: the refusal is keyed on the stack journal. A root without one takes its own backup route.
const legacy = newRoot("project-legacy");
const legacyBackup = run(legacy, ["backup", "create", join(home, "artifact-legacy"), "--json"]);
check("control: a root with no stack journal is not refused as controller-owned", legacyBackup.envelope?.outcome !== undefined && legacyBackup.envelope.error?.code !== "UNSUPPORTED" && !/controller-owned/.test(`${legacyBackup.stdout}${legacyBackup.stderr}`), shown(legacyBackup));

finish();
process.exit(process.exitCode ?? 0);
