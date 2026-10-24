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
 * names the field and the reason, as does a role token `send -r` would refuse. An edit that is not
 * saved keeps its draft and names it, a malformed `--on` names the command to rerun, and no create
 * takes the seeded default's launch name. Removing the seeded default says so, and a launch preview
 * refuses a missing persona as the launch does. A managed preview exits 0, and both previews name
 * the persona's source in words and warn about an unknown harness. No broker is started.
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
check("its remedy names the edit and the remove that resolve it", (conflict.envelope?.error?.remedy ?? "").includes("cotal persona edit rev") && (conflict.envelope?.error?.remedy ?? "").includes("cotal persona remove rev"), conflict.envelope?.error);
const conflictPlain = cotal("persona", "create", "rev", "--plain");
check("its plain report begins with Mesh: <space> and ends with a Next", conflictPlain.status === 2 && conflictPlain.first === "Mesh: opsp" && /\nNext\n\s+change it with cotal persona edit rev/.test(conflictPlain.stderr), shown(conflictPlain));
// A persona that does not exist: show and remove name where to see the ones that do.
for (const args of [["show", "nosuch"], ["remove", "nosuch", "--yes"]]) {
  const missing = cotal("persona", ...args, "--json");
  check(`persona ${args[0]} of a missing persona is TARGET_NOT_FOUND with a remedy`, missing.status === 2 && missing.envelope?.error?.code === "TARGET_NOT_FOUND" && missing.envelope.error.remedy === "see the personas here with `cotal persona`", shown(missing));
}
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
// A role is an address `send -r` reaches, so create refuses a role token it would refuse.
const roleFlag = cotal("persona", "create", "badrole", "--prompt", "x", "--role", "bad role!", "--subscribe", "", "--json");
check("persona create --role with a role send -r refuses is USAGE_INVALID naming --role",
  roleFlag.status === 1 && roleFlag.envelope?.error?.code === "USAGE_INVALID" && (roleFlag.envelope.error.message ?? "").startsWith('--role: invalid role "bad role!"') && !existsSync(agentFilePath(root, "badrole")), shown(roleFlag));
const roleFile = join(root, "badrole.md");
writeFileSync(roleFile, "---\nname: badrole\nrole: bad role!\nsubscribe: []\n---\n");
const roleInFile = cotal("persona", "create", "badrole", "--file", roleFile, "--json");
check("persona create --file whose role send -r refuses is SCHEMA_INVALID naming the file and the role",
  roleInFile.status === 1 && roleInFile.envelope?.error?.code === "SCHEMA_INVALID" && (roleInFile.envelope.error.message ?? "").includes(`invalid persona definition ${roleFile}: invalid role "bad role!"`) && !existsSync(agentFilePath(root, "badrole")), shown(roleInFile));
const roleOk = cotal("persona", "create", "goodrole", "--prompt", "x", "--role", "reviewer", "--subscribe", "", "--json");
check("control: a valid role token is created", roleOk.status === 0 && existsSync(agentFilePath(root, "goodrole")), shown(roleOk));

// A malformed --on names the command to rerun, with --on written once.
for (const [argv, rerun] of [
  [["persona", "--on", "bad"], "cotal persona --on <instance>"],
  [["persona", "create", "h1", "--prompt", "x", "--on", "bad"], "cotal persona create h1 --on <instance>"],
] as const) {
  const pinned = cotal(...argv, "--json");
  const said = `${pinned.envelope?.error?.message ?? ""} ${pinned.envelope?.error?.remedy ?? ""}`;
  check(`${argv.slice(0, -2).join(" ")} --on bad names ${rerun} and never --on twice`,
    pinned.status === 1 && pinned.envelope?.error?.code === "USAGE_INVALID" && (pinned.envelope.error.remedy ?? "").endsWith(`rerun it as ${rerun}`) && !said.includes("--on --on"), shown(pinned));
}

// The seeded default's agents launch as default_agent, so no create takes that name.
for (const argv of [
  ["persona", "create", "default_agent", "--prompt", "x", "--subscribe", ""],
  ["personas", "new", "default_agent", "--prompt", "x", "--subscribe", ""],
  ["persona", "create", "default_agent", "--prompt", "x", "--on", "a".repeat(26)],
]) {
  const reserved = cotal(...argv);
  check(`${argv.slice(0, 3).join(" ")}${argv.includes("--on") ? " --on" : ""} refuses the reserved default_agent and writes nothing`,
    reserved.status === 1 && reserved.stderr.includes("'default_agent' is reserved") && !existsSync(agentFilePath(root, "default_agent")), shown(reserved));
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

// Removing the seeded default says what it was and how it comes back; another removal does not.
const removedOther = cotal("persona", "remove", "goodrole", "--yes", "--json");
check("removing another persona does not call it the seeded default", removedOther.status === 0 && !removedOther.stdout.includes("seededDefault"), shown(removedOther));
const removedDefault = cotal("persona", "remove", "default", "--yes", "--plain");
check("removing the seeded default says so and names what writes a fresh copy",
  removedDefault.status === 0 && removedDefault.stdout.includes("This was the seeded default persona, which a bare cotal spawn launches") && !existsSync(agentFilePath(root, "default")), shown(removedDefault));

// A launch preview refuses a missing persona as the launch does, naming where it looked: the catalog
// for a name, the file for a path, and for the default also the command that writes one.
const catalog = dirname(agentFilePath(root, "default"));
const noName = cotal("spawn", "nosuch", "--dry-run", "--json");
check("spawn --dry-run of a missing name is TARGET_NOT_FOUND, naming the catalog and --file",
  noName.status === 2 && noName.envelope?.error?.code === "TARGET_NOT_FOUND" && noName.envelope.error.message === `no persona "nosuch" in ${catalog} (mesh "opsp")`
    && noName.envelope.error.remedy === "pass a catalog name, or a persona file elsewhere with `--file <persona.md>`", shown(noName));
const noFile = cotal("spawn", "--file", "missing.md", "--dry-run", "--json");
check("spawn --dry-run of a missing --file names the file it checked",
  noFile.status === 2 && noFile.envelope?.error?.code === "TARGET_NOT_FOUND" && noFile.envelope.error.message === `no persona "missing.md": ${join(root, "missing.md")} was not found`, shown(noFile));
const noDefault = cotal("spawn", "--dry-run", "--plain");
check("spawn --dry-run with no default persona names cotal up in the space's root",
  noDefault.status === 2 && noDefault.stderr.includes(`no default persona in ${catalog} (mesh "opsp")`) && noDefault.stderr.includes(`run \`cotal up\` in ${root} to write one`) && !noDefault.stderr.includes("team deploy"), shown(noDefault));

// A managed preview shows the request and exits 0. Both previews say where the persona came from in
// words, and warn about a harness no connector here provides.
interface Preview { requested?: { source?: string }; persona?: { source?: string } }
const managed = cotal("spawn", "-d", "nosuch", "--dry-run", "--json");
const managedResult = (managed.envelope as unknown as { result?: Preview; completeness?: string } | undefined);
check("a managed spawn --dry-run exits 0, not-checked, with the name's source as argument",
  managed.status === 0 && managed.envelope?.outcome === "ok" && managedResult?.completeness === "not-checked" && managedResult.result?.requested?.source === "argument", shown(managed));
const managedHarness = cotal("spawn", "-d", "--harness", "nosuch", "--dry-run", "--plain");
check("a managed preview warns about an unknown harness and labels the default persona in words",
  managedHarness.status === 0 && managedHarness.stderr.includes('! no harness "nosuch"; known harnesses:') && managedHarness.stdout.includes("Persona source:            the default persona") && !managedHarness.stdout.includes("explicit-or-product-default"), shown(managedHarness));
writeFileSync(join(root, "pv.md"), "---\nname: pv\nrole: reviewer\nsubscribe: []\n---\n");
const direct = cotal("spawn", "--file", "pv.md", "--harness", "nosuch", "--dry-run", "--json");
const warnings = (direct.envelope as unknown as { warnings?: { code: string }[]; result?: Preview } | undefined);
check("a direct preview of an unknown --harness exits 0 with a HARNESS_UNKNOWN warning and the file's source",
  direct.status === 0 && same(warnings?.warnings?.map((w) => w.code), ["HARNESS_UNKNOWN"]) && warnings?.result?.persona?.source === "file", shown(direct));
const fromEnv = outcome(spawnSync(process.execPath, [BIN, "spawn", "--file", "pv.md", "--dry-run", "--plain"], { cwd: root, env: { ...env, COTAL_DEFAULT_AGENT: "nosuch" }, encoding: "utf8", timeout: 120_000 }));
check("a harness only COTAL_DEFAULT_AGENT chose gets the warning config gives",
  fromEnv.status === 0 && fromEnv.stderr.includes('! COTAL_DEFAULT_AGENT: no harness "nosuch"') && fromEnv.stdout.includes("a persona file (--file)"), shown(fromEnv));

finish();
process.exit(process.exitCode ?? 0);
