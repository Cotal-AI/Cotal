/**
 * A classified failure raised after a command resolved its space is reported in that space.
 *
 * Many refusals deep in a command name no space in their target, so they printed no `Mesh:` line and
 * their JSON envelope had no `target.space`, although the operation's space was already resolved.
 * A single-space command now records that space once it resolves it, and the kernel adds it to a
 * later failure whose target has no `space` field.
 *
 * The kernel cells run the src kernel over a fixture command in a child, because a classified failure
 * ends the process. The persona cells run the built binary: `persona create` over an existing file
 * refuses with a target-less CONFLICT on a prepared space, and a `--file` the agent-file rules refuse
 * names the field and the reason. An edit that is not saved keeps its draft and names it. No broker
 * is started.
 *
 * Run: pnpm smoke:operation-space
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  error?: { code: string; message?: string; remedy?: string };
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
// A complete file that names another persona: the refusal names the file's name and the create that keeps it.
const otherFile = join(root, "bernie.md");
writeFileSync(otherFile, "---\nname: bernie\nrole: reviewer\nsubscribe: []\n---\n");
const mismatch = cotal("persona", "create", "ex11", "--file", otherFile, "--json");
check("a --file naming another persona is SCHEMA_INVALID, naming the file's name and its own create",
  mismatch.status === 1 && mismatch.envelope?.error?.code === "SCHEMA_INVALID" && (mismatch.envelope.error.message ?? "").includes(`${otherFile} names 'bernie'`) && (mismatch.envelope.error.remedy ?? "").includes(`cotal persona create bernie --file ${otherFile}`), shown(mismatch));
// A file the agent-file rules refuse: the refusal names the field and the reason. A YAML error keeps
// only its position, since the parser's text can quote the document.
for (const [label, text, reason] of [
  ["no frontmatter", "no frontmatter\n", 'missing "---" frontmatter block'],
  ["the legacy channels key", "---\nname: bad\nchannels: [general]\n---\n", '"channels" was renamed'],
  ["a read channel outside allowSubscribe", "---\nname: bad\nsubscribe: [ops]\nallowSubscribe: [general]\n---\n", 'subscribe "ops" is not within allowSubscribe [general]'],
  ["a YAML error", "---\nname: bad\nrole: [secret-value\n---\n", "the frontmatter is not valid YAML at line 3"],
] as const) {
  const badFile = join(root, "bad.md");
  writeFileSync(badFile, text);
  const refused = cotal("persona", "create", "bad", "--file", badFile, "--json");
  const message = refused.envelope?.error?.message ?? "";
  check(`a --file with ${label} is SCHEMA_INVALID naming the file and the reason`,
    refused.status === 1 && refused.envelope?.error?.code === "SCHEMA_INVALID" && message.includes(`invalid persona definition ${badFile}: ${reason}`) && !message.includes("secret-value"), shown(refused));
}
// An edit that is not saved keeps its draft and names it: a draft the agent-file rules refuse says
// why, and an editor that exits non-zero keeps what it wrote. The catalog file is unchanged.
const drafts = join(home, "drafts");
mkdirSync(drafts);
const editorScript = (file: string, body: string) => { const path = join(home, file); writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return path; };
const saved = readFileSync(persona, "utf8");
for (const [label, editor, status, says] of [
  ["a draft the rules refuse", editorScript("ed-acl", 'printf -- "---\\nname: rev\\nsubscribe: [ops]\\nallowSubscribe: [general]\\n---\\nx\\n" > "$1"'), 1, 'subscribe "ops" is not within allowSubscribe [general] - not saved'],
  ["an editor that exits 3", editorScript("ed-exit", 'printf -- "---\\nname: rev\\nrole: changed\\n---\\nx\\n" > "$1"; exit 3'), 5, "editor exited with status 3 - not saved"],
] as const) {
  const edit = outcome(spawnSync(process.execPath, [BIN, "persona", "edit", "rev", "--plain"], { cwd: root, env: { ...env, EDITOR: editor, TMPDIR: drafts }, encoding: "utf8", timeout: 120_000 }));
  const kept = readdirSync(drafts).map((dir) => join(drafts, dir, "rev.md")).filter((path) => existsSync(path));
  check(`persona edit with ${label} keeps the draft, names it and leaves the catalog file unchanged`,
    edit.status === status && edit.stderr.includes(says) && kept.length === 1 && edit.stderr.includes(kept[0]!) && readFileSync(persona, "utf8") === saved, { ...shown(edit), kept });
  for (const dir of readdirSync(drafts)) rmSync(join(drafts, dir), { recursive: true });
}

finish();
process.exit(process.exitCode ?? 0);
