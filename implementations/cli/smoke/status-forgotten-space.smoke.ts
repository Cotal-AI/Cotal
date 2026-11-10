/**
 * After `cotal space forget`, `cotal status` in that space's root selects no space and dials
 * nothing. The resolver gives an unregistered project root the default broker address, and status
 * used to report that guess as the selected mesh, with `Mesh: <space>` and a probe of
 * nats://127.0.0.1:4222. Any broker could hold that address.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME. No broker is started.
 *
 * Run: pnpm smoke:status-forgotten-space
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  target: { space: string | null } | null;
  error?: { code: string; message: string; remedy?: string };
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

for (const args of [["persona"], ["team"], ["spawn", "--dry-run"], ["whoami"]]) {
  const control = run([...args, "--json"]);
  check(`control: ${args.join(" ")} names the prepared space`, control.status === 0 && control.envelope?.target?.space === "b1", shown(control));
}

const forgot = run(["space", "forget", "b1"]);
check("rig: the space is forgotten and its root's files stay", forgot.status === 0 && existsSync(join(root, ".cotal")), shown(forgot));

const json = run(["status", "--json"]);
check("status reads the machine and selects no space", read(json) && json.envelope?.target?.space === null, shown(json));
check("the selection is unresolved as an unregistered root", json.envelope?.result?.selected.resolved === false && json.envelope.result.selected.code === "unregistered-root", json.envelope?.result?.selected);
check("no default broker address is reported or probed", !json.stdout.includes("4222") && !json.stderr.includes("4222"), shown(json));

const plain = run(["status", "--plain"]);
check("the report carries no Mesh header for the forgotten space", read(plain) && !/^Mesh: /m.test(plain.stdout), shown(plain));
check("the report names no default broker address", !plain.stdout.includes("4222") && !plain.stderr.includes("4222"), shown(plain));
// A bare `up` here would start the default space, which then holds the folder, so the step back is
// to prepare a space again.
check("the report names space create for this folder, not a bare up", plain.stdout.includes(`cotal space create <name> --root ${realpathSync.native(root)}\``) && /cotal use <name>/.test(plain.stdout) && !/cotal up\b/.test(plain.stdout), shown(plain));

const components = run(["status", "--components"]);
check("status --components refuses the unregistered root and probes no default broker", /target\s+refused · unregistered-root/.test(components.stdout) && !components.stdout.includes("4222") && !components.stderr.includes("4222"), shown(components));

for (const args of [["persona"], ["team"], ["spawn", "--dry-run"], ["spawn", "--detach", "--dry-run"], ["whoami"]]) {
  const refused = run([...args, "--json"]);
  check(`${args.join(" ")} refuses without an assumed space`, refused.status === 2 && refused.envelope?.error?.code === "TARGET_NOT_FOUND" && !refused.stdout.includes('"assumed"') && !refused.stdout.includes('"main"'), shown(refused));
  const plain = run([...args, "--plain"]);
  check(`${args.join(" ")} names no Mesh and offers preparation`, plain.status === 2 && !/^Mesh: /m.test(plain.stdout + plain.stderr) && /no space is registered or prepared here/.test(plain.stdout + plain.stderr) && /space create <name>/.test(plain.stdout + plain.stderr), shown(plain));
}

// Discovery is advice, not selection or preparation. The same valid manifest remains a file until
// the operator explicitly checks and boots it.
writeFileSync(join(root, "cotal.yaml"), "apiVersion: cotal/v1\nkind: Mesh\nspace: declared\nagents: {}\nchannels: {}\n");
const checked = run(["team", "check", "cotal.yaml", "--graph"]);
check("rig: the local manifest passes the real offline check", checked.status === 0, shown(checked));
for (const args of [[], ["status", "--plain"], ["team", "--plain"]]) {
  const report = run(args);
  const text = report.stdout + report.stderr;
  check(`${args.join(" ") || "bare cotal"} notices the declaration without selecting it`, /cotal.yaml/.test(text) && /declared/.test(text) && /cotal (?:team|t) check cotal.yaml --graph/.test(text) && /cotal (?:team|t) boot cotal.yaml/.test(text) && !/^Mesh: /m.test(text), shown(report));
}
const stillUnselected = run(["status", "--json"]);
check("discovery leaves the target unresolved", stillUnselected.envelope?.target?.space === null && stillUnselected.envelope.result?.selected.resolved === false, shown(stillUnselected));

for (const source of ["space: secret-not-a-manifest\n", "apiVersion: cotal/v1\nkind: Mesh\nspace: -unsafe\n", "x".repeat(1024 * 1024 + 1)]) {
  writeFileSync(join(root, "cotal.yaml"), source);
  const report = run([]);
  check("an invalid or oversized declaration gives only the check step", report.status === 0 && /cotal team check cotal.yaml --graph/.test(report.stdout) && !/team boot|space create|secret-not-a-manifest|-unsafe/.test(report.stdout), shown(report));
}
unlinkSync(join(root, "cotal.yaml"));
if (process.platform !== "win32") {
  symlinkSync("missing-manifest", join(root, "cotal.yaml"));
  const report = run([]);
  check("a dangling manifest link is not treated as an absent file", /could not be read/.test(report.stdout) && /team check cotal.yaml/.test(report.stdout) && !/team boot/.test(report.stdout), shown(report));
  unlinkSync(join(root, "cotal.yaml"));
}
mkdirSync(join(root, "cotal.yaml"));
const directory = run([]);
check("a directory at the manifest path does not hang or infer a space", directory.status === 0 && /team check cotal.yaml/.test(directory.stdout) && !/team boot/.test(directory.stdout), shown(directory));

const preparedRoot = mkdtempSync(join(home, "declared-"));
const declared = run(["space", "create", "declared", "--root", preparedRoot], preparedRoot);
writeFileSync(join(preparedRoot, "cotal.yaml"), "apiVersion: cotal/v1\nkind: Mesh\nspace: declared\nagents: {}\nchannels: {}\n");
const preparedTeam = run(["team", "--plain"], preparedRoot);
check("a prepared team's Next names its local manifest", declared.status === 0 && /Mesh: declared/.test(preparedTeam.stdout) && /team check cotal.yaml --graph/.test(preparedTeam.stdout) && /team boot cotal.yaml/.test(preparedTeam.stdout) && !/check <file>/.test(preparedTeam.stdout), shown(preparedTeam));

// A `.cotal/` with nothing in it names no records, and a bare `up` there is how a space starts.
const fresh = mkdtempSync(join(home, "fresh-"));
mkdirSync(join(fresh, ".cotal"));
const freshPlain = run(["status", "--plain"], fresh);
check("control: an empty project still names a bare up", read(freshPlain) && freshPlain.stdout.includes(`cotal up\` in ${realpathSync.native(fresh)} to start one`) && !freshPlain.stdout.includes("space create <name>"), shown(freshPlain));
check("its selection is stated once, with the step only under Next", (freshPlain.stdout.match(/no space is registered or prepared here/g) ?? []).length === 1 && /Selected space\n\s+no space is registered or prepared here for \S+\n/.test(freshPlain.stdout), shown(freshPlain));

finish();
process.exit(process.exitCode ?? 0);
