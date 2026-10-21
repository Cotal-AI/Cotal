/**
 * A classified failure raised after a command resolved its space is reported in that space.
 *
 * Many refusals deep in a command name no space in their target, so they printed no `Mesh:` line and
 * their JSON envelope had no `target.space`, although the operation's space was already resolved.
 * A single-space command now records that space once it resolves it, and the kernel adds it to a
 * later failure whose target has no `space` field.
 *
 * The kernel cells run the src kernel over a fixture command in a child, because a classified failure
 * ends the process. The persona cell runs the built binary: `persona create` over an existing file
 * refuses with a target-less CONFLICT on a prepared space, and no broker is started.
 *
 * Run: pnpm smoke:operation-space
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentFilePath } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: Record<string, unknown> | null;
  error?: { code: string };
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-operation-space-"));
const root = realpathSync(mkdtempSync(join(home, "project-")));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };

const outcome = (r: ReturnType<typeof spawnSync>) => {
  const stdout = String(r.stdout ?? ""), stderr = String(r.stderr ?? "");
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(stdout) as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout, stderr, envelope, first: stderr.split("\n")[0] };
};
const fixture = join(import.meta.dirname, "operation-space.fixture.ts");
const kernel = (...words: string[]) => outcome(spawnSync(process.execPath, [...process.execArgv, fixture, ...words], { cwd: root, env, encoding: "utf8", timeout: 60_000 }));
const cotal = (...words: string[]) => outcome(spawnSync(process.execPath, [BIN, ...words], { cwd: root, env, encoding: "utf8", timeout: 120_000 }));
const shown = (r: ReturnType<typeof kernel>) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 600) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const bare = kernel("scoped", "--json", "--record", "s9", "--fail", "bare");
check("a target-less refusal after the record is refused, exit 2", bare.status === 2 && bare.envelope?.error?.code === "TARGET_NOT_FOUND", shown(bare));
check("its envelope target is the recorded space", same(bare.envelope?.target, { space: "s9" }), bare.envelope?.target);
check("its report begins with Mesh: <space>", bare.first === "Mesh: s9", shown(bare));

const plain = kernel("scoped", "--plain", "--record", "s9", "--fail", "bare");
check("the plain report begins with Mesh: <space>", plain.status === 2 && plain.first === "Mesh: s9", shown(plain));

const named = kernel("scoped", "--json", "--record", "s9", "--fail", "named");
check("a target without a space keeps its fields and gains the space", same(named.envelope?.target, { space: "s9", name: "x" }), named.envelope?.target);

const own = kernel("scoped", "--json", "--record", "s9", "--fail", "own");
check("a target that names its own space is kept", same(own.envelope?.target, { space: "other" }) && own.first === "Mesh: other", shown(own));

const none = kernel("scoped", "--json", "--record", "s9", "--fail", "none");
check("a target whose space is null is kept, with no Mesh line", same(none.envelope?.target, { space: null }) && !none.stderr.includes("Mesh:"), shown(none));

const unrecorded = kernel("scoped", "--json", "--fail", "bare");
check("control: without a record the refusal has no target and no Mesh line", unrecorded.status === 2 && unrecorded.envelope?.target === null && !unrecorded.stderr.includes("Mesh:"), shown(unrecorded));

const unknown = kernel("scoped", "--json", "--record", "s9", "--fail", "plain");
check("an unclassified failure after the record is OPERATION_UNKNOWN in that space", unknown.status === 3 && unknown.envelope?.error?.code === "OPERATION_UNKNOWN" && same(unknown.envelope.target, { space: "s9" }), shown(unknown));

const prepared = cotal("space", "create", "opsp", "--root", ".");
check("fixture: the space is prepared and not started", prepared.status === 0, shown(prepared));
const persona = agentFilePath(root, "rev");
mkdirSync(dirname(persona), { recursive: true });
writeFileSync(persona, "---\nname: rev\nrole: reviewer\n---\n");
const conflict = cotal("persona", "create", "rev", "--json");
check("persona create over an existing file is a CONFLICT in the prepared space", conflict.status === 2 && conflict.envelope?.error?.code === "CONFLICT" && conflict.envelope.target?.space === "opsp", shown(conflict));
const conflictPlain = cotal("persona", "create", "rev", "--plain");
check("its plain report begins with Mesh: <space>", conflictPlain.status === 2 && conflictPlain.first === "Mesh: opsp", shown(conflictPlain));

finish();
process.exit(process.exitCode ?? 0);
