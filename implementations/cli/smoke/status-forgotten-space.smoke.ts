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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

// A `.cotal/` with nothing in it names no records, and a bare `up` there is how a space starts.
const fresh = mkdtempSync(join(home, "fresh-"));
mkdirSync(join(fresh, ".cotal"));
const freshPlain = run(["status", "--plain"], fresh);
check("control: an empty project still names a bare up", read(freshPlain) && /cotal up` there to start one/.test(freshPlain.stdout) && !freshPlain.stdout.includes("space create <name>"), shown(freshPlain));

finish();
process.exit(process.exitCode ?? 0);
