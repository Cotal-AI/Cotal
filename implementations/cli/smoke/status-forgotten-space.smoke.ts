/**
 * After `cotal space forget`, the folder's `.cotal/` names no space. `cotal status` there selects
 * no space and dials nothing, the same way `persona`, `team` and `spawn --dry-run` refuse there.
 * An empty `.cotal/` also names no space to these reads and previews.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME. No broker is started.
 *
 * Run: pnpm smoke:status-forgotten-space
 */
import { spawnSync } from "node:child_process";
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
  target: { space?: string | null } | null;
  outcome: string;
  error?: { code: string };
  result: { selected: { resolved: boolean; code?: string; server?: string | null } } | null;
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-status-forgotten-"));
const root = mkdtempSync(join(home, "project-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[], cwd = root) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });
const read = (r: ReturnType<typeof run>) => r.status === 0 || r.status === 4;

const created = run(["space", "create", "b1", "--root", root]);
check("rig: the space is prepared in this root", created.status === 0, shown(created));
const prepared = run(["status", "--json"]);
check("control: a prepared space is reported as not started, with nothing selected", read(prepared) && prepared.envelope?.result?.selected.resolved === false && prepared.envelope.result.selected.code === "not-started", shown(prepared));

const forgot = run(["space", "forget", "b1"]);
check("rig: the space is forgotten and its root's files stay", forgot.status === 0 && existsSync(join(root, ".cotal")), shown(forgot));

const json = run(["status", "--json"]);
check("status reads the machine and selects no space", read(json) && json.envelope?.target?.space === null, shown(json));
check("the selection is unresolved because the folder names no space", json.envelope?.result?.selected.resolved === false && json.envelope.result.selected.code === "no-meshes", json.envelope?.result?.selected);
check("no default broker address is reported or probed", !json.stdout.includes("4222") && !json.stderr.includes("4222"), shown(json));

const plain = run(["status", "--plain"]);
check("the report carries no Mesh header for the forgotten space", read(plain) && !/^Mesh: /m.test(plain.stdout), shown(plain));
check("the report names no default broker address", !plain.stdout.includes("4222") && !plain.stderr.includes("4222"), shown(plain));
check("the report names space create for this folder, not a bare up", plain.stdout.includes(`cotal space create <name> --root ${realpathSync.native(root)}\``) && /cotal use <name>/.test(plain.stdout) && !/cotal up\b/.test(plain.stdout), shown(plain));

const components = run(["status", "--components"]);
check("status --components refuses the folder that names no space and probes no default broker", /target\s+refused · no-meshes/.test(components.stdout) && !components.stdout.includes("4222") && !components.stderr.includes("4222"), shown(components));

// An empty control directory does not create an implicit space for reads or launch previews.
const fresh = mkdtempSync(join(home, "fresh-"));
mkdirSync(join(fresh, ".cotal"));
const freshPlain = run(["status", "--plain"], fresh);
check("an empty project names space preparation without an assumed space", read(freshPlain) && freshPlain.stdout.includes("space create <name>") && !/^Mesh: /m.test(freshPlain.stdout), shown(freshPlain));
for (const args of [["persona"], ["team"], ["whoami"], ["spawn", "--dry-run"]]) {
  const result = run([...args, "--json"], fresh);
  check(`${args[0]} refuses an empty project without assuming main`, result.status === 2 && result.envelope?.outcome === "refused" && result.envelope.error?.code === "TARGET_NOT_FOUND" && result.envelope.target?.space == null, shown(result));
}
check("its selection is stated once, with the step only under Next", (freshPlain.stdout.match(/no space is registered or prepared here/g) ?? []).length === 1 && /Selected space\n\s+no space is registered or prepared here for \S+\n/.test(freshPlain.stdout), shown(freshPlain));

const freshManifest = join(fresh, "cotal.yaml");
writeFileSync(freshManifest, "kind: Mesh\nspace: fresh-declared\nagents: []\n");
const freshChild = join(fresh, "child");
mkdirSync(freshChild);
const freshEntry = run([], freshChild);
check("entry help finds a manifest above an empty project's child", freshEntry.status === 0 && freshEntry.stdout.includes(freshManifest) && freshEntry.stdout.includes("fresh-declared"), shown(freshEntry));
const freshPersona = run(["persona", "--json"], freshChild);
check("an empty project's child names its manifest without assuming main", freshPersona.status === 2 && freshPersona.envelope?.target == null && freshPersona.stdout.includes(freshManifest) && freshPersona.stdout.includes("fresh-declared"), shown(freshPersona));

// Entry help discovers the same project-root manifest from a child directory as the command readers.
const manifestPath = join(root, "cotal.yaml");
writeFileSync(manifestPath, "kind: Mesh\nspace: revived\nagents: []\n");
const child = join(root, "child");
mkdirSync(child);
for (const [label, cwd] of [["root", root], ["child", child]] as const) {
  const entry = run([], cwd);
  check(`entry help from the ${label} names the forgotten project's manifest and actions`, entry.status === 0 && entry.stdout.includes(manifestPath) && entry.stdout.includes("revived") && entry.stdout.includes("team check") && entry.stdout.includes("team boot") && entry.stdout.includes("up -f"), shown(entry));
}

finish();
process.exit(process.exitCode ?? 0);
