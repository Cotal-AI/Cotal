/**
 * The persona catalog answers for the RESOLVED MESH, never for the cwd.
 *
 * `cotal personas` and `cotal spawn` must name the same set. They did not: `personasDir(root =
 * cotalRoot())` and its four siblings defaulted to the directory the cwd walks up to, so every
 * caller that forgot a root silently described a different project than the one the command acts
 * on. `spawn.ts` was the only caller passing the resolved mesh's root. From one cwd, with a mesh
 * selected elsewhere, `personas` listed a set `spawn` could not launch a single member of — and
 * neither surface said anything was wrong.
 *
 * Three properties, each measured rather than asserted:
 *   1. CATALOG AGREEMENT — what `personas list` prints equals what `spawn` will launch.
 *   2. `--space` IS REAL — naming a mesh moves the catalog, so two spaces give two answers from
 *      one cwd. (Before the fix `--space` reached only the live `--running` overlay, so the named
 *      mesh's running-marks were painted onto the cwd's names: two meshes in one table.)
 *   3. COMPLETERS AGREE — `spawn --role`/`--subscribe` and `send msg`/`ask` complete from the
 *      target mesh's personas, not the cwd's.
 *
 * (3) is not redundant with a typecheck. The signature change makes a forgotten root a compile
 * error, but passing `cotalRoot()` at those sites silences the compiler and keeps the bug: that
 * mutant typechecks with ZERO errors. Only an answer-level check catches it, so this file checks
 * answers.
 *
 * Hermetic: COTAL_HOME and the fixtures are sandboxed, meshes are registered straight into the
 * registry, and NO BROKER is needed — catalog and completion resolution are offline by contract,
 * which is itself part of the claim. Run: pnpm smoke:persona-root
 */
import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandFailure } from "@cotal-ai/workspace";
import { makeScratch } from "../../../bin/smoke/_scratch.js";

// Isolate the machine-home AND the temp root before importing anything that resolves a root.
// `findCotalRoot` walks to `/` with no boundary, so a `.cotal` above the temp base captures every
// fixture: the "cwd project" then resolves somewhere else and the whole suite grades a state it
// failed to create. Measured on this machine: TMPDIR was $HOME/.cotal/jcode/…, i.e. already
// captured, so os.tmpdir() cannot be trusted here.
const scratch = makeScratch();
const cleanScratch = (e: unknown): never => {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`fixture setup failed (scratch removed): ${(e as Error).message}`, { cause: e });
};
let home!: string;
try {
  home = mkdtempSync(join(scratch, "home-"));
} catch (e) { cleanScratch(e); }
process.env.COTAL_HOME = home;

// Typed against the modules they come from — `any` would buy tidiness by giving up the
// compile-time checking this suite exists to exercise.
let recordMesh!: typeof import("@cotal-ai/workspace").recordMesh;
let setCurrent!: typeof import("@cotal-ai/workspace").setCurrent;
let resolveMeshTarget!: typeof import("@cotal-ai/workspace").resolveMeshTarget;
let agentFilePath!: typeof import("@cotal-ai/core").agentFilePath;
let loadAgentFile!: typeof import("@cotal-ai/core").loadAgentFile;
let listPersonas!: typeof import("../src/lib/personas.js").listPersonas;
let personas!: typeof import("../src/commands/personas.js").personas;
let personasComplete!: typeof import("../src/commands/personas.js").personasComplete;
let persona!: typeof import("../src/commands/persona.js").persona;
let spawnComplete!: typeof import("../src/commands/spawn.js").spawnComplete;
let sendComplete!: typeof import("../src/commands/send.js").sendComplete;
let mint!: typeof import("../src/commands/mint.js").mint;
let createSpaceAuth!: typeof import("@cotal-ai/core").createSpaceAuth;
let saveSpaceAuth!: typeof import("@cotal-ai/workspace").saveSpaceAuth;
let authDir!: typeof import("@cotal-ai/workspace").authDir;
let agentSecretFilePaths!: typeof import("@cotal-ai/workspace").agentSecretFilePaths;
let isCommandFailure!: typeof import("@cotal-ai/workspace").isCommandFailure;
let commandFailureReport!: typeof import("@cotal-ai/workspace").commandFailureReport;
let renderReport!: typeof import("@cotal-ai/workspace").renderReport;
try {
  ({ recordMesh, setCurrent, resolveMeshTarget } = await import("@cotal-ai/workspace"));
  ({ agentFilePath, loadAgentFile } = await import("@cotal-ai/core"));
  ({ listPersonas } = await import("../src/lib/personas.js"));
  ({ personas, personasComplete } = await import("../src/commands/personas.js"));
  ({ persona } = await import("../src/commands/persona.js"));
  ({ spawnComplete } = await import("../src/commands/spawn.js"));
  ({ sendComplete } = await import("../src/commands/send.js"));
  ({ mint } = await import("../src/commands/mint.js"));
  ({ createSpaceAuth } = await import("@cotal-ai/core"));
  ({ saveSpaceAuth, authDir, agentSecretFilePaths, isCommandFailure, commandFailureReport, renderReport } = await import("@cotal-ai/workspace"));
} catch (e) { cleanScratch(e); }

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** A project root with a persona catalog; each persona declares a role and a channel. */
function project(label: string, personas: { name: string; role: string; channel: string }[]): string {
  const root = mkdtempSync(join(scratch, `${label}-`));
  const dir = join(root, ".cotal", "agents");
  mkdirSync(dir, { recursive: true });
  for (const p of personas)
    writeFileSync(
      join(dir, `${p.name}.md`),
      `---\nname: ${p.name}\nrole: ${p.role}\nsubscribe: [${p.channel}]\n---\n\nI am ${p.name}.\n`,
    );
  return root;
}

function checkCreateInputGuidance(run: (args: string[], input?: Buffer) => SpawnSyncReturns<string>, root: string): void {
  for (const [flag, extra] of [["--from", ["--subscribe", ""]], ["--file", []]] as const) {
    const source = join(root, "missing-input.md");
    const args = ["persona", "create", "input-check", flag, source, ...extra, "--plain"];
    const missing = run(args);
    const destination = agentFilePath(root, "input-check");
    check(`persona create ${flag} names a missing file and offers stdin without writing a persona`,
      missing.status === 2 && missing.stderr.includes("TARGET_NOT_FOUND") && missing.stderr.includes(source) &&
      missing.stderr.includes(`with ${flag} -`) && !existsSync(destination), missing.stderr);
    const directory = join(".cotal", "agents");
    const wrongKind = run(["persona", "create", "input-check", flag, directory, ...extra, "--plain"]);
    const fileKind = flag === "--file" ? "complete persona file" : "persona body file";
    check(`persona create ${flag} names a directory and asks for a file without writing a persona`,
      wrongKind.status === 2 && wrongKind.stderr.includes("TARGET_NOT_FOUND") && !wrongKind.stderr.includes("PERMISSION_DENIED") &&
      wrongKind.stderr.includes(`is a directory: ${directory}`) &&
      wrongKind.stderr.includes(`pass the path to a ${fileKind} with ${flag}`) && !existsSync(destination), wrongKind.stderr);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      writeFileSync(source, "not readable", { mode: 0o000 });
      try {
        const denied = run(args);
        check(`persona create ${flag} distinguishes an access denial from an absent file`,
          denied.status === 2 && denied.stderr.includes("PERMISSION_DENIED") && !existsSync(destination), denied.stderr);
      } finally { unlinkSync(source); }
    }
  }
  const body = "private retry definition";
  for (const [on, source] of [["short", "--prompt"], ["", "--file"], ["local.Uexample", "--from"], ["short", "--from"]] as const) {
    const piped = source !== "--prompt";
    const refused = run(["persona", "create", "retry-input", source, piped ? "-" : body, "--subscribe", "",
      "--space", "meshspace", `--on=${on}`, "--plain"], piped ? Buffer.from(body) : undefined);
    check(`persona create ${source} with --on=${on} preserves the original command in its guidance`,
      refused.status === 1 && refused.stderr.includes("USAGE_INVALID") &&
      refused.stderr.includes("cotal ps --space meshspace --plain") && !refused.stderr.includes("`cotal ps`") &&
      refused.stderr.includes("replace only the --on value in the original command") &&
      refused.stderr.includes("pipe the original input into the command again") === piped &&
      !refused.stderr.includes("cotal persona create retry-input --on") && !refused.stderr.includes(body) &&
      !existsSync(agentFilePath(root, "retry-input")), refused.stderr);
  }
}

const sorted = (r: { items: { value: string }[] }) => r.items.map((i) => i.value).sort();
const names = (root: string) => listPersonas(root).map((p) => p.name).sort();

/** Run `cotal personas list` for real and return everything it printed.
 *
 *  The command's answer IS its stdout, so that is what gets observed. Calling `listPersonas` with
 *  a root the suite resolved itself would grade the suite's own arithmetic instead of the
 *  command's, and would pass against the unfixed tree — measured, not hypothesised. */
async function captureList(values: { space?: string; server?: string }): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log, exitCode = process.exitCode;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await personas({ values, positionals: ["list"], raw: [] });
  } finally {
    console.log = realLog;
    process.exitCode = exitCode;
  }
  // Strip ANSI: the listing bolds names, so a flush-left name test would match nothing and every
  // "the cwd's personas are absent" check would pass for the wrong reason.
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run `cotal auth mint` for real and return everything it wrote. Same disposition as captureCmd. A
 *  classified refusal is thrown for the CLI kernel to print, so it is captured as the kernel's plain
 *  report under a `FAILURE <outcome> <code>` line. */
async function captureMint(positionals: string[], values: Record<string, unknown>): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log, realErr = console.error, realExit = process.exit;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  process.exit = ((code?: number) => { throw new Error(`__exit__${code ?? 0}`); }) as typeof process.exit;
  try {
    await mint({ values: values as never, positionals, raw: [] });
  } catch (e) {
    if (isCommandFailure(e)) lines.push(`FAILURE ${e.outcome} ${e.code}`, renderReport(commandFailureReport(e), "plain"));
    else if (!/^__exit__/.test((e as Error).message)) lines.push(`THREW: ${(e as Error).message}`);
  } finally {
    console.log = realLog; console.error = realErr; process.exit = realExit;
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run `cotal persona --json` for real: the envelope it wrote, or the refusal it threw for the CLI
 *  kernel to print. The exit code a partial result sets is put back, so it does not end the suite. */
async function personaJson(values: { space?: string }): Promise<{ envelope?: { outcome?: string; warnings?: { code: string; target?: { name?: string } }[] }; failure?: CommandFailure }> {
  const out: string[] = [];
  const realWrite = process.stdout.write, exitCode = process.exitCode;
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")), true)) as typeof process.stdout.write;
  try {
    await persona({ values: { ...values, json: true }, positionals: [], raw: [] });
    return { envelope: JSON.parse(out.join("")) };
  } catch (error) {
    if (isCommandFailure(error)) return { failure: error };
    throw error;
  } finally {
    process.stdout.write = realWrite;
    process.exitCode = exitCode;
  }
}

/** Persona names out of a captured listing: printed flush-left, descriptions indented under them. */
function personaNamesFrom(out: string): string[] {
  return [...new Set(
    out.split("\n").filter((l) => /^[A-Za-z0-9_-]+(\s|$)/.test(l)).map((l) => l.split(/\s/)[0]),
  )].sort();
}

/** Run any `cotal personas` subcommand for real and return everything it wrote.
 *
 *  Drives the exported `personas()` entry point — the same function the CLI dispatches to — rather
 *  than the private helpers behind it, because a cell that calls an extracted seam witnesses the
 *  seam and not the shipped call path. Captures stdout AND stderr (refusals print to stderr) and
 *  traps `process.exit`, which several of these subcommands call on the refusal paths. */
async function captureCmd(
  positionals: string[],
  values: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const realExit = process.exit;
  const restoreEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { restoreEnv[k] = process.env[k]; process.env[k] = v; }
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  // A refusal path calls process.exit; let it unwind this call instead of killing the suite.
  process.exit = ((code?: number) => { throw new Error(`__exit__${code ?? 0}`); }) as typeof process.exit;
  try {
    await personas({ values: values as never, positionals, raw: [] });
  } catch (e) {
    if (!/^__exit__/.test((e as Error).message)) throw e;
  } finally {
    console.log = realLog;
    console.error = realErr;
    process.exit = realExit;
    for (const [k, v] of Object.entries(restoreEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

// MESH and CWD are disjoint in every dimension — persona names, roles, and channels — so a wrong
// answer NAMES itself rather than merely failing an expectation. A suite whose two sides overlap
// cannot tell "read the right root" from "read either root".
let MESH!: string, CWD!: string, ALPHA!: string, BETA!: string, EMPTY!: string;
try {
  MESH = project("mesh", [
    { name: "mesh-default", role: "mesh-reviewer", channel: "mesh-alpha" },
    { name: "mesh-lead", role: "mesh-builder", channel: "mesh-beta" },
  ]);
  CWD = project("cwd", [
    { name: "cwd-one", role: "cwd-writer", channel: "cwd-chan" },
    { name: "cwd-two", role: "cwd-editor", channel: "cwd-other" },
  ]);
  ALPHA = project("alpha", [{ name: "alpha-only", role: "alpha-role", channel: "alpha-chan" }]);
  BETA = project("beta", [{ name: "beta-only", role: "beta-role", channel: "beta-chan" }]);
  EMPTY = project("empty", []);
} catch (e) { cleanScratch(e); }

const entry = (space: string, root: string, server: string) =>
  ({ space, server, root, mode: "open" as const, ts: "2026-08-27T00:00:00.000Z" });

const prevCwd = process.cwd();
try {
  recordMesh(entry("meshspace", MESH, "nats://127.0.0.1:4222"));
  setCurrent("meshspace");
  process.chdir(CWD); // stand in the OTHER project — the entire point of the suite

  // The premise. If these two ever coincide the suite proves nothing, so assert the split exists
  // before grading anything that depends on it.
  const target = resolveMeshTarget(process.cwd());
  check("premise: the resolved mesh root differs from the cwd", target.root === MESH && MESH !== CWD, { mesh: target.root, cwd: CWD });
  check("premise: the cwd is itself a real project with its own catalog", existsSync(join(CWD, ".cotal", "agents", "cwd-one.md")));

  // 1. CATALOG AGREEMENT.
  //
  // Read `personas list` by CAPTURING WHAT IT PRINTS, not by calling listPersonas(target.root)
  // and comparing. That distinction decides whether this suite is a detector at all: the first
  // version of this file did the latter, and every catalog cell PASSED against the unfixed tree,
  // because the cell was re-implementing the fix instead of measuring the command. A cell that
  // cannot fail is not evidence. `personas()` writes to stdout, so stdout is the observation.
  const listedOut = await captureList({});
  const listed = personaNamesFrom(listedOut);
  // `spawn` resolves its catalog as listPersonas(target.root) — that IS spawn's implementation,
  // so calling it here is calling the product, not a replica of it.
  const launchable = names(target.root);
  check("catalog: personas list prints the MESH's personas", listed.join(",") === "mesh-default,mesh-lead", listed);
  check("catalog: personas and spawn name the SAME set", listed.join(",") === launchable.join(","), { listed, launchable });
  check("catalog: the cwd's own personas are NOT listed", !listed.some((n) => n.startsWith("cwd-")), listed);

  // 2. `--space` MOVES THE CATALOG. Two meshes, one cwd, changing only the flag — and again read
  // off what the command PRINTS. Neither answer may be the cwd's; that is the failure mode, named
  // explicitly so it cannot be confused with "not what we expected".
  recordMesh(entry("alpha", ALPHA, "nats://127.0.0.1:4301"));
  recordMesh(entry("beta", BETA, "nats://127.0.0.1:4302"));
  const alphaListed = personaNamesFrom(await captureList({ space: "alpha" }));
  const betaListed = personaNamesFrom(await captureList({ space: "beta" }));
  check("--space alpha: personas list prints alpha's catalog", alphaListed.join(",") === "alpha-only", alphaListed);
  check("--space beta: personas list prints beta's catalog", betaListed.join(",") === "beta-only", betaListed);
  check("--space: two spaces give two DIFFERENT answers from one cwd", alphaListed.join(",") !== betaListed.join(","));
  check("--space: neither answer is the cwd's catalog", !alphaListed.concat(betaListed).some((n) => n.startsWith("cwd-")), { alphaListed, betaListed });

  // A catalog folder this account cannot read is refused with a next step that names no chmod when
  // the folder withholding it is above the catalog or owned by another account: a chmod there would
  // change a folder the operator may not own. Root reads through any mode, so only an ordinary user.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const refusal = () => captureList({ space: "alpha" }).then(() => undefined, (error: unknown) => (isCommandFailure(error) ? error : undefined));
    const dotCotal = join(realpathSync(ALPHA), ".cotal"), agents = join(dotCotal, "agents");
    const mode = statSync(dotCotal).mode & 0o7777;
    chmodSync(dotCotal, 0o000);
    let above: Awaited<ReturnType<typeof refusal>>;
    try { above = await refusal(); } finally { chmodSync(dotCotal, mode); }
    check("unreadable catalog: a folder above it that this account cannot enter is named, with no chmod",
      above?.code === "PERMISSION_DENIED" && above.message === `cannot read persona catalog: ${agents}` &&
        above.remedy === `this account cannot enter ${dotCotal}, which holds the catalog; get access to that folder from its owner, then run the command again`, above && { message: above.message, remedy: above.remedy });
    // A folder another account owns and this account cannot list, such as /root, when the host has one.
    const foreign = ["/root", "/var/root"].find((dir) => {
      try { if (statSync(dir).uid === process.getuid!()) return false; readdirSync(dir); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "EACCES"; }
    });
    if (foreign) {
      renameSync(agents, `${agents}.real`);
      symlinkSync(foreign, agents);
      let owned: Awaited<ReturnType<typeof refusal>>;
      try { owned = await refusal(); } finally { unlinkSync(agents); renameSync(`${agents}.real`, agents); }
      check(`unreadable catalog: a folder another account owns (${foreign}) says to ask its owner, with no chmod`,
        owned?.code === "PERMISSION_DENIED" && owned.message === `cannot read persona catalog: ${agents}` &&
          owned.remedy === "another account owns this folder; ask its owner to let this account read it", owned && { message: owned.message, remedy: owned.remedy });
    } else console.log("  - no folder another account owns and this account cannot list; that cell did not run");

    // A catalog folder at mode 0600 lists its file names but opens none of them. Empty or not, it is
    // refused as an unreadable one is, with the chmod, rather than listing valid personas as
    // unparseable, and the run leaves its mode as it was.
    recordMesh(entry("empty", EMPTY, "nats://127.0.0.1:4303"));
    for (const [label, root, space] of [["populated", ALPHA, "alpha"], ["empty", EMPTY, "empty"]] as const) {
      const dir = join(realpathSync(root), ".cotal", "agents"), was = statSync(dir).mode & 0o7777;
      const message = `cannot read persona catalog: ${dir}`, remedy = `make it readable by you with \`chmod u+rx ${dir}\``;
      const thrown = (complete: () => unknown) => { try { complete(); return undefined; } catch (error) { return (error as Error).message; } };
      chmodSync(dir, 0o600);
      let listed: Awaited<ReturnType<typeof refusal>>, json: Awaited<ReturnType<typeof personaJson>>, names: string | undefined, roles: string | undefined, left: number;
      try {
        listed = await captureList({ space }).then(() => undefined, (error: unknown) => (isCommandFailure(error) ? error : undefined));
        json = await personaJson({ space });
        names = thrown(() => personasComplete(["--space", space, "show", ""]));
        roles = thrown(() => spawnComplete(["--space", space, "--role", ""]));
        left = statSync(dir).mode & 0o777;
      } finally { chmodSync(dir, was); }
      check(`search-denied ${label} catalog: personas list refuses it with the chmod`,
        listed?.code === "PERMISSION_DENIED" && listed.message === message && listed.remedy === remedy, listed && { message: listed.message, remedy: listed.remedy });
      check(`search-denied ${label} catalog: persona --json refuses it with the chmod, not as unparseable personas`,
        json.failure?.code === "PERMISSION_DENIED" && json.failure.message === message && json.failure.remedy === remedy, json.failure ? { message: json.failure.message, remedy: json.failure.remedy } : json.envelope);
      check(`search-denied ${label} catalog: name and role completion fail and name the catalog`,
        names === `cannot read the persona catalog ${dir}: permission denied` && roles === names, { names, roles });
      check(`search-denied ${label} catalog: its mode is left as it was`, left === 0o600, left.toString(8));
    }
  }

  // A file that does not parse, in a catalog that can be read, is still listed by name as unparseable
  // beside the personas that do parse.
  const broken = join(realpathSync(ALPHA), ".cotal", "agents", "broken.md");
  writeFileSync(broken, "not a persona\n");
  let malformedList: string, malformed: Awaited<ReturnType<typeof personaJson>>;
  try { malformedList = await captureList({ space: "alpha" }); malformed = await personaJson({ space: "alpha" }); } finally { unlinkSync(broken); }
  check("malformed file: personas list names it unparseable and still lists the persona that parses",
    /^broken +⨯ unparseable agent file .*broken\.md: missing "---" frontmatter block$/m.test(malformedList) && /^alpha-only /m.test(malformedList), malformedList);
  check("malformed file: persona --json is partial with one SCHEMA_INVALID warning naming it",
    malformed.envelope?.outcome === "partial" && malformed.envelope.warnings?.map((w) => `${w.code} ${w.target?.name}`).join() === "SCHEMA_INVALID broken", malformed.envelope ?? malformed.failure?.message);

  // 3. COMPLETERS. argv EXCLUDES the command name (same convention as spawn-from-anywhere's
  // `spawnComplete([""])`); the trailing "" is the word being completed.
  check("completion: spawn --role offers the MESH's declared roles", sorted(spawnComplete(["--role", ""])).join(",") === "mesh-builder,mesh-reviewer", sorted(spawnComplete(["--role", ""])));
  check("completion: spawn --subscribe offers the MESH's declared channels", sorted(spawnComplete(["--subscribe", ""])).join(",") === "mesh-alpha,mesh-beta", sorted(spawnComplete(["--subscribe", ""])));
  // `send ask <role>` and `send msg <channel>` became the `--role` and `--channel` destination flags.
  check("completion: send --role offers the MESH's declared roles", sorted(sendComplete(["--role", ""])).join(",") === "mesh-builder,mesh-reviewer", sorted(sendComplete(["--role", ""])));
  check("completion: send --channel offers the MESH's declared channels", sorted(sendComplete(["--channel", ""])).join(",") === "mesh-alpha,mesh-beta", sorted(sendComplete(["--channel", ""])));
  check("completion: personas show offers the MESH's persona names", sorted(personasComplete(["show", ""])).join(",") === "mesh-default,mesh-lead", sorted(personasComplete(["show", ""])));
  check("completion: personas show --space alpha offers ALPHA's names", sorted(personasComplete(["--space", "alpha", "show", ""])).join(",") === "alpha-only", sorted(personasComplete(["--space", "alpha", "show", ""])));
  if (process.platform !== "win32") {
    const path = join(MESH, ".cotal", "agents", "outbound-back\\slash.md");
    writeFileSync(path, "---\nname: backslash\n---\nFixture.\n");
    try {
      const names = sorted(spawnComplete([""]));
      check("completion: spawn omits the backslash selector and retains ordinary names", names.join(",") === "mesh-default,mesh-lead", names);
    } finally {
      rmSync(path, { force: true });
    }
  }

  // POSITIVE CONTROL for every "the cwd's names are absent" claim above. Those are all zeroes, and
  // a zero fuses two claims: "the instrument looked" and "there was nothing". This proves the
  // first — the SAME readers, pointed at the cwd root, do return the cwd's names. Without it, a
  // reader that returned nothing at all would satisfy every absence check in this file.
  check("control: the same reader DOES return the cwd's names when given the cwd root", names(CWD).join(",") === "cwd-one,cwd-two", names(CWD));
  // And the listing PARSER can see cwd names when they are genuinely printed — otherwise a parser
  // that matched nothing would also satisfy "the cwd's personas are NOT listed".
  check("control: the listing parser CAN see cwd names when they are present", personaNamesFrom("cwd-one  role\n  desc\ncwd-two  role").join(",") === "cwd-one,cwd-two");

  // 4. THE MUTATING/READING SUBCOMMANDS — show, edit, new, rm.
  //
  // These were fixed in the same commit as `list` and were NOT witnessed by it. Measured: reverting
  // all four to the cwd root left this suite, persona-templates and spawn-from-anywhere GREEN,
  // while reverting `list` alone turned this suite RED — so the harness could kill and simply was
  // not looking here. Each cell below therefore drives the REAL `personas()` entry point and dies
  // on its OWN site, because four cells that only collectively redden would let one exclusion carry
  // four names.
  //
  // `rm` is the one that matters most: resolving the wrong root deletes a file from a directory the
  // operator never named, and nothing in the repo reddened.

  // show — the card it writes is the observation: the MESH root's file, which no cwd card matches.
  // Piped, it writes only the file, so stdout is read here as well as console.log.
  const shown: string[] = [];
  const realWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { shown.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; }) as typeof process.stdout.write;
  try { await captureCmd(["show", "mesh-lead"], {}); } finally { process.stdout.write = realWrite; }
  check("show: opens the card under the MESH root", shown.join("") === readFileSync(join(MESH, ".cotal", "agents", "mesh-lead.md"), "utf8"), shown.join("").slice(0, 160));
  // …and refuses a name that exists ONLY in the cwd, rather than silently opening the cwd's copy.
  // The refusal is the one `persona show` gives, and it names the path it looked for under MESH.
  const shownCwdOnly = await captureCmd(["show", "cwd-one"], {}).then(() => undefined, (error: Error) => error);
  check("show: a cwd-only persona is NOT found (it is not in the mesh's catalog)", shownCwdOnly?.message === `no persona at ${join(MESH, ".cotal", "agents", "cwd-one.md")}`, shownCwdOnly?.message);

  // new — the file must appear under the MESH root and NOT under the cwd.
  await captureCmd(["new", "fresh-one"], { prompt: "made by the smoke", subscribe: "mesh-alpha" });
  check("new: writes the card into the MESH's catalog", existsSync(join(MESH, ".cotal", "agents", "fresh-one.md")));
  check("new: does NOT write into the cwd's catalog", !existsSync(join(CWD, ".cotal", "agents", "fresh-one.md")));

  // rm — must delete from the MESH root. The cwd holds a same-named decoy that must SURVIVE, which
  // is what makes this a discrimination rather than "a file went away".
  //
  // ANTI-VACUITY CONTROL FIRST. "the mesh's file is gone" also passes when the file was never
  // there, and "the cwd's file survives" also passes when nothing ever deleted anything — so both
  // rm cells are satisfiable by a fixture that did nothing at all. Measured: with the `new` step
  // and its two cells removed, both rm cells still reported ✓. Asserting BOTH files exist before
  // the delete is what makes the two assertions afterwards mean something.
  writeFileSync(join(CWD, ".cotal", "agents", "fresh-one.md"), `---\nname: fresh-one\nsubscribe: []\n---\n\ndecoy\n`);
  check("control: BOTH copies exist before rm (else the two cells below pass vacuously)",
    existsSync(join(MESH, ".cotal", "agents", "fresh-one.md")) && existsSync(join(CWD, ".cotal", "agents", "fresh-one.md")));
  await captureCmd(["rm", "fresh-one"], { force: true });
  check("rm: deletes from the MESH's catalog", !existsSync(join(MESH, ".cotal", "agents", "fresh-one.md")));
  check("rm: leaves the cwd's same-named card untouched", existsSync(join(CWD, ".cotal", "agents", "fresh-one.md")));

  // edit — shares `show`'s resolution and is not driven here (it hands the terminal to $EDITOR).
  // Witnessed instead by pointing EDITOR at a no-op: the card it found and validated is reported
  // unchanged, so nothing is saved.
  const edited = await captureCmd(["edit", "mesh-default"], {}, { EDITOR: "true" });
  check("edit: re-validates the card under the MESH root", /"mesh-default" is unchanged, so nothing was saved/.test(edited), edited.slice(0, 120));

  // 5. `cotal mint --profile agent` READS ITS ACLs FROM THE SAME ROOT.
  //
  // The credential surface, and the one that was fixed with no detector: reverting mint's root left
  // every committed suite in the repo green, because none of them mentions mint at all. An
  // undetected regression here does not print a wrong list, it issues a credential carrying grants
  // the operator did not authorise.
  //
  // Both roots hold a card of the SAME NAME with DIFFERENT ACLs, so this DISCRIMINATES rather than
  // observes: a witness that only checks "a card was read" passes when the wrong card was read.
  // The cwd's copy is the wider one, which is the direction that matters — reading it would issue
  // grants the operator had already narrowed away.
  writeFileSync(join(MESH, ".cotal", "agents", "minted.md"), `---\nname: minted\nsubscribe: [mesh-alpha]\n---\n\nmesh copy\n`);
  writeFileSync(join(CWD, ".cotal", "agents", "minted.md"), `---\nname: minted\nsubscribe: [cwd-one, cwd-two]\n---\n\ncwd copy\n`);
  // Control first: the two copies really do differ, or "mint read the mesh's" proves nothing.
  const meshCard = loadAgentFile(agentFilePath(MESH, "minted"));
  const cwdCard = loadAgentFile(agentFilePath(CWD, "minted"));
  check("control: the two `minted` cards carry DIFFERENT ACLs (else the mint cell cannot discriminate)",
    (meshCard.subscribe ?? []).join(",") !== (cwdCard.subscribe ?? []).join(","),
    { mesh: meshCard.subscribe, cwd: cwdCard.subscribe });
  // DRIVE THE REAL `mint()`, not a resolver seam. Trust belongs under the selected mesh root. A cwd
  // with different trust must be refused before any credential is written.
  // Static mint is issued only for a static-auth space, so the selected mesh is recorded in auth mode.
  recordMesh({ ...entry("meshspace", MESH, "nats://127.0.0.1:4222"), mode: "auth" });
  const meshAuth = await createSpaceAuth("meshspace");
  const cwdAuth = await createSpaceAuth("meshspace");
  saveSpaceAuth(authDir(MESH), meshAuth);
  saveSpaceAuth(authDir(CWD), cwdAuth);
  const credsPath = join(scratch, "minted.creds");
  const mixed = await captureMint(["minted"], { profile: "agent", out: credsPath });
  check("mint: a cwd trust root that differs from the selected mesh authority is REFUSED",
    /^FAILURE refused CONFLICT$/m.test(mixed) && /disagree about the signing authority/.test(mixed), mixed);
  check("mint: the refusal names BOTH roots", mixed.includes(MESH) && mixed.includes(CWD), mixed);
  check("mint: the mixed-root refusal writes no credential", !existsSync(credsPath));

  // Remove only the conflicting trust from the cwd. The cwd and selected mesh roots still differ,
  // proving success now sources ACLs, signing and storage from the target root rather than requiring
  // the operator to stand there.
  rmSync(join(CWD, ".cotal", "auth"), { recursive: true, force: true });
  const mintedOut = await captureMint(["minted"], { profile: "agent", out: credsPath });
  check("mint: without conflicting cwd trust, the target root supplies the coherent authority",
    /Private credential written/.test(mintedOut) && !/^FAILURE /m.test(mintedOut) && existsSync(credsPath), mintedOut);
  // The ACLs are not echoed on stdout - they are baked into the minted credential, which is the
  // artifact that actually carries them to the broker. Read the file mint wrote.
  const credsText = existsSync(credsPath) ? readFileSync(credsPath, "utf8") : "";
  // The grants live in the JWT's base64 payload, not in the surrounding armour, so DECODE it -
  // a substring search over the raw file finds neither channel and would pass for the wrong reason.
  const jwt = /-----BEGIN NATS USER JWT-----\s*([A-Za-z0-9_.-]+)/.exec(credsText)?.[1] ?? "";
  const claims = jwt ? Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8") : "";
  check("control: mint wrote a credential whose claims decode (else the ACL check is vacuous)",
    credsText.length > 0 && /"sub"/.test(claims), claims.slice(0, 120));
  check("mint: the credential carries the MESH card's channel, not the cwd card's",
    claims.includes("mesh-alpha") && !claims.includes("cwd-one"), claims.slice(0, 400));

  // Default storage is authority too. Run without --out from the divergent cwd and require the
  // canonical target-root file, with no same-named credential materialized under cwd. A label is one
  // owner token, so it carries no '-'.
  const stored = await captureMint(["minted_stored"], { profile: "agent", "allow-subscribe": "mesh-alpha" });
  const meshStored = agentSecretFilePaths(MESH, meshAuth.space, "minted_stored").creds;
  const cwdStored = agentSecretFilePaths(CWD, meshAuth.space, "minted_stored").creds;
  check("mint: default credential storage uses the selected mesh root", existsSync(meshStored), { stored, meshStored });
  check("mint: default credential storage does NOT use the cwd root", !existsSync(cwdStored), cwdStored);



  // Exercise the built CLI parser and the three local command paths, not just a split helper.
  const binary = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
  const cases: [string, string | undefined, string[]][] = [
    ["absent", undefined, []], ["empty", "", []], ["space", "   ", []],
    ["comma", ",", []], ["trimmed", " review , , ops ", ["review", "ops"]],
    ["literal", "none", ["none"]],
  ];
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, DO_NOT_TRACK: "1" };
  for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];
  childEnv.COTAL_HOME = home;
  childEnv.COTAL_SKIP_CONNECTOR_SEED = "1";
  const native = (args: string[], cwd = MESH, env = childEnv, input?: Buffer) => spawnSync(process.execPath, [binary, ...args], {
    cwd, env, input, encoding: "utf8", timeout: 30_000,
  });
  const offlineRoot = join(scratch, "offline-project");
  const prepared = native(["space", "create", "offline-audit", "--root", offlineRoot, "--plain"], CWD);
  check("a separate project is prepared without starting a broker", prepared.status === 0, prepared.stdout + prepared.stderr);
  const help = [native(["persona", "--help"]), native(["persona", "create", "--help"])];
  const emptyExample = /persona create <name> --prompt "<text>" (--subscribe=) +save a persona from a prompt, reading no channels/;
  const makeEmpty = ["persona", "create", "empty-read-set", "--prompt", "Review the patch."];
  const missingValue = native([...makeEmpty, "--subscribe", "--json"], offlineRoot);
  const error = JSON.parse(missingValue.stdout).error;
  const attached = emptyExample.exec(help[1]!.stdout)?.[1];
  check("persona help and missing-value guidance show an attached empty subscription",
    help.every((entry) => entry.status === 0 && emptyExample.test(entry.stdout)) && missingValue.status === 1 &&
    error?.code === "USAGE_INVALID" && error.message === "--subscribe needs a value" && error.remedy?.includes("--subscribe= for none"),
    [...help.map((entry) => entry.stdout + entry.stderr), missingValue.stdout + missingValue.stderr]);
  const emptyCreated = native([...makeEmpty, attached!, "--json"], offlineRoot);
  const emptyShown = native(["persona", "show", "empty-read-set", "--json"], offlineRoot);
  check("the printed attached option saves a persona with no subscriptions",
    emptyCreated.status === 0 && emptyShown.status === 0 && JSON.stringify(JSON.parse(emptyShown.stdout).result.definition.subscribe) === "[]",
    emptyCreated.stdout + emptyCreated.stderr + emptyShown.stdout + emptyShown.stderr);
  const args = ["persona", "--space", "offline-audit", "--plain"];
  const offline = native(args, CWD);
  const plannedServer = native([...args, "--server", "nats://127.0.0.1:1"], CWD);
  check("a planned server still lists the named prepared project's local catalog",
    offline.status === 0 && plannedServer.status === 0 && /offline-audit .* local persona files/.test(plannedServer.stdout) &&
    /\bdefault\b/.test(plannedServer.stdout), plannedServer.stdout + plannedServer.stderr);
  if (process.platform !== "win32") {
    const link = agentFilePath(realpathSync(offlineRoot), "shared");
    symlinkSync("../../shared.md", link);
    try {
      const legacy = native(["personas", "list", "--space", "offline-audit"], CWD);
      check("legacy list keeps readable personas and explains how to fix a missing link target",
        legacy.status === 4 && /^default\s+default$/m.test(legacy.stdout) &&
        /^shared\s+⨯ missing link target /m.test(legacy.stdout) &&
        legacy.stdout.includes(`${link} is a link to ../../shared.md. Restore the target or replace the link with a regular persona file.`) &&
        !legacy.stdout.includes("unparseable"), legacy.stdout + legacy.stderr);
    } finally { unlinkSync(link); }
  }
  const invalidName = agentFilePath(realpathSync(offlineRoot), "name-rule");
  writeFileSync(invalidName, '---\nname: " leading"\n---\nReview the fixture.\n');
  const invalidNameList = native(["personas", "list", "--space", "offline-audit"], CWD);
  unlinkSync(invalidName);
  check("legacy listing names the selected catalog file and the display-name rule",
    invalidNameList.status === 4 && /^default\s/m.test(invalidNameList.stdout) &&
    invalidNameList.stdout.split("\n").some(line => /^name-rule +⨯ unparseable /.test(line) &&
      line.endsWith(`agent file ${invalidName}: invalid name " leading": must be non-empty with no surrounding whitespace`)),
    invalidNameList.stdout + invalidNameList.stderr);
  const only = "offline-only";
  writeFileSync(agentFilePath(offlineRoot, only), `---\nname: ${only}\n---\nOnly in the other catalog.\n`);
  const listReceipt = native(args, CWD);
  const show = listReceipt.stdout.match(/(?:cotal|pnpm cotal) (p show <name> --space offline-audit)/)?.[1];
  const showReceipt = show ? native([...show.replace("<name>", only).split(" "), "--plain"], CWD) : undefined;
  check("persona list's show command reads the explicitly selected catalog",
    listReceipt.status === 0 && showReceipt?.status === 0 && showReceipt.stdout.includes("Only in the other catalog."), listReceipt.stdout + listReceipt.stderr);
  const showWords = ["p", "show", only, "--space", "offline-audit", "--json"];
  const unknownShow = native([...showWords, "--wibble"], CWD);
  const fixedShow = native(showWords, CWD);
  const unknownError = JSON.parse(unknownShow.stdout || "{}").error;
  check("persona show tells you to drop an unknown option and keep the supplied name",
    unknownShow.status === 1 && unknownShow.stderr === "" && unknownError?.code === "USAGE_INVALID"
    && unknownError.message === "Unknown option '--wibble'" && unknownError.remedy === "drop the unknown option"
    && fixedShow.status === 0 && fixedShow.stderr === "" && JSON.parse(fixedShow.stdout).outcome === "ok",
    { unknownShow: unknownShow.stdout, fixedShow: fixedShow.stdout });
  const dashName = "-review";
  const dashRefused = native(["persona", "create", dashName, "--prompt", "Review the patch.", "--subscribe=", "--json"], offlineRoot);
  const dashError = JSON.parse(dashRefused.stdout || "{}").error;
  const printed = typeof dashError?.remedy === "string" ? /`(?:pnpm cotal|cotal) persona ([^`]+)`/.exec(dashError.remedy)?.[1] : undefined;
  const printedWords = printed === undefined ? [] : [...printed.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
  check("a persona name that starts with - keeps its flags and is not reprinted",
    dashRefused.status === 1 && dashRefused.stderr === "" && dashError?.remedy?.includes("starts with a letter, digit or _")
    && printedWords[0] === "create" && printedWords.includes("--prompt") && printedWords.includes("Review the patch.")
    && printedWords.at(-1) === "<name>" && !printedWords.includes(dashName),
    dashRefused.stdout + dashRefused.stderr);
  const literal = native(["persona", "show", "review", "--json", "--", "--json"], offlineRoot);
  const literalError = JSON.parse(literal.stdout || "{}").error;
  check("a declared flag after -- stays a positional",
    literal.status === 1 && literalError?.code === "USAGE_INVALID"
    && literalError.message === "usage: cotal persona [show|create|edit|remove <name>]",
    literal.stdout + literal.stderr);
  const create = plannedServer.stdout.match(/(?:cotal|pnpm cotal) (p create <name> --file <persona.md> --space offline-audit --server nats:\/\/127\.0\.0\.1:1)/)?.[1];
  const sourcePath = join(scratch, "catalog-input.md");
  const source = "---\nname: catalog-created\n---\nCreated in the other catalog.\n";
  writeFileSync(sourcePath, source);
  const created = create ? native(create.split(" ").map(word => word === "<name>" ? "catalog-created" : word === "<persona.md>" ? sourcePath : word), CWD) : undefined;
  check("persona list's create command keeps both selectors and writes only to the selected catalog",
    created?.status === 0 && readFileSync(agentFilePath(offlineRoot, "catalog-created"), "utf8") === source &&
    !existsSync(agentFilePath(CWD, "catalog-created")), plannedServer.stdout + (created?.stderr ?? ""));
  check("persona list's process command retains both explicit selectors",
    ["cotal", "pnpm cotal"].some(cli => plannedServer.stdout.includes(`${cli} ps --space offline-audit --server nats://127.0.0.1:1`)), plannedServer.stdout);
  writeFileSync(agentFilePath(CWD, "catalog-created"), source);
  const removal = native(["persona", "remove", "catalog-created", "--space", "offline-audit", "--server", "nats://127.0.0.1:1", "--yes", "--plain"], CWD);
  const browse = removal.stdout.match(/(?:pnpm cotal|cotal) (p --space offline-audit --server nats:\/\/127\.0\.0\.1:1)\s+Browse the local catalog/)?.[1];
  const browsed = browse ? native(browse.split(" "), CWD) : undefined;
  check("persona removal's browse command lists the changed catalog and leaves the origin copy intact",
    removal.status === 0 && browsed?.status === 0 && browsed.stdout.includes("Mesh: offline-audit") &&
    browsed.stdout.includes(only) && !browsed.stdout.includes("catalog-created") &&
    readFileSync(agentFilePath(CWD, "catalog-created"), "utf8") === source && !existsSync(agentFilePath(offlineRoot, "catalog-created")),
    removal.stdout + removal.stderr + (browsed?.stdout ?? "") + (browsed?.stderr ?? ""));
  checkCreateInputGuidance((args, input) => native(args, MESH, childEnv, input), MESH);
  if (process.platform !== "win32") {
    const server = "nats://[::1]:43002";
    recordMesh(entry("beta", BETA, server));
    for (const { name, selectors } of [
      { name: "same", selectors: ["--space", "beta"] },
      { name: "same", selectors: ["--server", server] },
      { name: "-same", selectors: ["--space", "beta", "--server", server] },
    ]) {
      const selected = agentFilePath(MESH, name);
      const explicit = agentFilePath(BETA, name);
      const localCard = `---\nname: ${name}\nsubscribe: []\n---\n\nLocal\n`;
      const auditCard = localCard.replace("Local", "Audit");
      writeFileSync(selected, localCard);
      writeFileSync(explicit, auditCard);
      const refused = native(["personas", "rm", ...selectors, "--", name], CWD, { ...childEnv, NO_COLOR: "1" });
      const retry = refused.stderr.split("\n").find(line => line.startsWith("cotal personas rm "));
      check(`personas rm ${selectors.join(" ")} refuses before changing either copy and prints a retry`,
        refused.status === 1 && retry !== undefined &&
        readFileSync(selected, "utf8") === localCard && readFileSync(explicit, "utf8") === auditCard, refused.stderr);
      const removed = spawnSync("sh", ["-c", `cotal() { "$CLI_NODE" "$CLI_BIN" "$@"; }; ${retry}`], {
        cwd: CWD, env: { ...childEnv, CLI_NODE: process.execPath, CLI_BIN: binary }, encoding: "utf8", timeout: 30_000,
      });
      check(`personas rm ${selectors.join(" ")} retry removes only the explicitly targeted card`,
        removed.status === 0 && !existsSync(explicit) && existsSync(selected) && readFileSync(selected, "utf8") === localCard,
        { retry, status: removed.status, stderr: removed.stderr });
      if (selectors.includes(server)) check("the retry quotes the IPv6 server selector", retry!.includes(`--server '${server}'`), retry);
    }
  }
  if (process.platform !== "win32") {
    const slow = spawnSync("sh", ["-c",
      `(printf 'First line.\\n'; sleep 3; printf 'Second line.\\n') | "$@"`,
      "sh", process.execPath, binary, "persona", "create", "slow-stdin", "--space", "meshspace",
      "--from", "-", "--subscribe", "", "--plain",
    ], { cwd: MESH, env: childEnv, encoding: "utf8", timeout: 30_000 });
    check("persona create waits for EOF on a paused pipe", slow.status === 0, slow.stdout + slow.stderr);
    check("persona create saves both chunks of piped input",
      loadAgentFile(agentFilePath(MESH, "slow-stdin")).persona === "First line.\nSecond line.");
  }
  for (const [label, raw, expected] of cases) {
    for (const verb of ["persona", "personas"] as const) {
      const name = `list-${verb}-${label}`;
      const args = [verb, verb === "persona" ? "create" : "new", name, "--prompt", "list fixture"];
      if (raw !== undefined) args.push("--subscribe", raw);
      const result = native(args);
      const path = agentFilePath(MESH, name);
      if (raw === undefined) {
        check(`${verb}: absent subscribe is refused by the real CLI`, result.status === 1 && !existsSync(path));
      } else {
        check(`${verb}: ${label} list reaches the saved definition`, result.status === 0 && existsSync(path));
        check(`${verb}: ${label} list preserves tokens`, JSON.stringify(loadAgentFile(path).subscribe) === JSON.stringify(expected));
      }
    }
    const name = `list_mint_${label}`;
    writeFileSync(agentFilePath(MESH, name), `---\nname: ${name}\nsubscribe: []\nallowSubscribe: [default-read]\nallowPublish: [default-post]\n---\n\nlist fixture\n`);
    const args = ["auth", "mint", name, "--profile", "agent", "--json"];
    if (raw !== undefined) args.push("--allow-subscribe", raw, "--allow-publish", raw);
    const result = native(args);
    check(`mint: ${label} list succeeds through the real CLI`, result.status === 0);
    const grants = JSON.parse(result.stdout).result.grants as { read: string[]; post: string[] };
    check(`mint: ${label} read list keeps absence distinct from empty`, JSON.stringify(grants.read) === JSON.stringify(raw === undefined ? ["default-read"] : expected));
    check(`mint: ${label} post list keeps absence distinct from empty`, JSON.stringify(grants.post) === JSON.stringify(raw === undefined ? ["default-post"] : expected));
  }

  const encodedSource = join(scratch, "encoded.md");
  const encodedFile = agentFilePath(MESH, "encoded");
  writeFileSync(encodedSource, Buffer.from("---\nname: encoded\n---\nReview café changes.\n", "latin1"));
  const encodedArgs = ["persona", "create", "encoded", "--file", encodedSource, "--plain"];
  const invalidEncoding = native(encodedArgs);
  check("persona create refuses invalid UTF-8 with a resave remedy and writes nothing",
    invalidEncoding.status === 1 && invalidEncoding.stderr.includes("SCHEMA_INVALID") &&
    invalidEncoding.stderr.includes(`${encodedSource}: it is not valid UTF-8`) &&
    invalidEncoding.stderr.includes(`save ${encodedSource} as UTF-8`) && !existsSync(encodedFile), invalidEncoding.stderr);
  writeFileSync(encodedFile, readFileSync(encodedSource));
  try {
    const modern = native(["persona", "--json"]);
    const inventory = JSON.parse(modern.stdout);
    check("persona inventory marks invalid UTF-8 as partial and invalid",
      modern.status === 4 && inventory.completeness === "partial" &&
      inventory.result.items.some((item: { name: string; valid: boolean }) => item.name === "encoded" && !item.valid) &&
      modern.stdout.includes("it is not valid UTF-8"), modern.stdout);
    const legacy = native(["personas", "list", "--verbose"]);
    check("legacy persona inventory reports invalid UTF-8 without printing replacement text",
      legacy.status === 4 && (legacy.stdout + legacy.stderr).includes("it is not valid UTF-8") &&
      !legacy.stdout.includes("Review caf� changes."), legacy.stdout + legacy.stderr);
  } finally { rmSync(encodedFile); }
  const utf8 = Buffer.from("---\r\nname: encoded\r\n---\r\nReview café and the literal � symbol.\r\n");
  writeFileSync(encodedSource, utf8);
  const validEncoding = native(encodedArgs);
  check("persona create accepts valid UTF-8 and keeps the original bytes",
    validEncoding.status === 0 && readFileSync(encodedFile).equals(utf8), validEncoding.stdout + validEncoding.stderr);

  const bodySource = join(scratch, "body.txt");
  const bodyText = "Review café and the literal � symbol.";
  const latinBody = Buffer.from("Review café changes.\n", "latin1");
  const utf8Body = Buffer.from(`${bodyText}\n`);
  for (const [command, verb, name, from] of [
    ["persona", "create", "body-file", bodySource], ["persona", "create", "body-stdin", "-"],
    ["personas", "new", "legacy-body-file", bodySource], ["personas", "new", "legacy-body-stdin", "-"],
  ] as const) {
    const output = command === "persona" ? ["--plain"] : [];
    const create = (bytes: Buffer) => {
      if (from !== "-") writeFileSync(from, bytes);
      return native([command, verb, name, "--from", from, "--subscribe", "", ...output], MESH, childEnv, from === "-" ? bytes : undefined);
    };
    const path = agentFilePath(MESH, name);
    const refused = create(latinBody);
    const source = from === "-" ? "standard input" : from;
    check(`${name}: invalid UTF-8 is refused with conversion guidance and no write`,
      refused.status === 1 && refused.stderr.includes("SCHEMA_INVALID") &&
      refused.stderr.includes(`${source} is not valid UTF-8`) &&
      refused.stderr.includes("convert the input to UTF-8 and retry") && !existsSync(path), refused.stdout + refused.stderr);
    const created = create(utf8Body);
    const shown = native([command, "show", name, ...output]);
    check(`${name}: valid UTF-8 keeps accented text and a literal replacement character`,
      created.status === 0 && shown.status === 0 && shown.stdout.includes(bodyText), created.stderr + shown.stdout + shown.stderr);
  }

  {
    const name = "a b", path = agentFilePath(MESH, name);
    const source = "---\nname: spacedfile\nagent: claude\n---\nFixture body.\n";
    writeFileSync(path, source);
    const listed = native(["persona", "--json"]);
    const shown = native(["persona", "show", name, "--json"]);
    const preview = native(["spawn", "--dry-run", "--json", "--", name]);
    check("persona list, show and spawn preview agree on a spaced catalog name",
      listed.status === 0 && JSON.parse(listed.stdout).result.items.some((item: { name: string }) => item.name === name) &&
      shown.status === 0 && JSON.parse(shown.stdout).result.source === source &&
      preview.status === 0 && JSON.parse(preview.stdout).result.persona.path === path, shown.stdout + shown.stderr);
    const plain = native(["persona", "show", name, "--plain"]);
    check("persona show quotes a spaced name in its follow-up commands", plain.status === 0 &&
      plain.stdout.includes("cotal spawn 'a b'") && plain.stdout.includes("cotal p show 'a b' --json") &&
      !plain.stdout.includes("cotal p edit"), plain.stdout + plain.stderr);
    const create = native(["persona", "create", name, "--prompt", "Do not write.", "--subscribe", "", "--json"]);
    check("persona create still refuses spaced names", create.status === 1 &&
      JSON.parse(create.stdout).error?.code === "USAGE_INVALID" && readFileSync(path, "utf8") === source, create.stdout + create.stderr);
    unlinkSync(path);
  }

  for (const name of ["qa+plus", "révision", "qa trailing "]) {
    const path = agentFilePath(MESH, name);
    const source = "---\nname: reviewer\nagent: claude\n---\nFixture body.\n";
    writeFileSync(path, source);
    const listed = native(["persona", "--json"]);
    const shown = native(["persona", "show", "--json", "--", name]);
    const preview = native(["spawn", "--dry-run", "--json", "--", name]);
    check(`persona list, show and spawn preview agree on ${JSON.stringify(name)}`,
      listed.status === 0 && JSON.parse(listed.stdout).result.items.some((item: { name: string }) => item.name === name) &&
      shown.status === 0 && JSON.parse(shown.stdout).result.source === source &&
      preview.status === 0 && JSON.parse(preview.stdout).result.persona.path === path, shown.stdout + preview.stdout);
    unlinkSync(path);
  }

  if (process.platform !== "win32") {
    const original = agentFilePath(ALPHA, "mismatch");
    const decoy = agentFilePath(MESH, "mismatch");
    const source = "---\nname: displayed\n---\nOriginal instructions.\n";
    const added = "Edited instructions.\n";
    const temp = join(scratch, "draft folder's space");
    const editor = join(scratch, "remove-source-editor");
    mkdirSync(temp);
    writeFileSync(original, source);
    writeFileSync(decoy, source);
    writeFileSync(editor, `#!/bin/sh\nmv "$SOURCE" "$SOURCE.moved"\nprintf '%s\\n' 'Edited instructions.' >> "$1"\n`, { mode: 0o700 });
    const refused = native(["persona", "edit", "mismatch", "--space", "alpha", "--json"], scratch,
      { ...childEnv, TMPDIR: temp, VISUAL: editor, SOURCE: original });
    const receipt = JSON.parse(refused.stdout);
    const draft = receipt.error?.remedy.match(/kept in (.*?);/)?.[1];
    const retry = receipt.error?.remedy.match(/restore it with `([^`]+)`/)?.[1];
    check("a removed persona preserves the edited draft and prints a recovery command",
      refused.status === 2 && receipt.error?.code === "CONFLICT" && !existsSync(original) &&
      draft && readFileSync(draft, "utf8") === source + added && retry, refused.stdout);
    const restore = () => spawnSync("sh", ["-c", retry], { cwd: scratch, env: childEnv, encoding: "utf8", timeout: 30_000 });
    writeFileSync(original, "Concurrent replacement\n");
    restore();
    check("draft recovery leaves a concurrent replacement untouched", readFileSync(original, "utf8") === "Concurrent replacement\n");
    unlinkSync(original);
    const restored = restore();
    const shown = native(["persona", "show", "mismatch", "--space", "alpha", "--json"], scratch);
    check("the printed command restores the exact draft to the original catalog without changing the display name",
      restored.status === 0 && shown.status === 0 && JSON.parse(shown.stdout).result.definition.name === "displayed" &&
      readFileSync(original, "utf8") === source + added && readFileSync(decoy, "utf8") === source, restored.stderr + shown.stdout);
    unlinkSync(original);
    unlinkSync(decoy);
  }

  const spacedSource = "sample card.md";
  for (const format of ["plain", "json"]) {
    const name = `sample-${format}`;
    const importBytes = Buffer.from(`---\nname: ${name}\nsubscribe: []\n---\nReview a sample.\n`);
    writeFileSync(join(scratch, spacedSource), importBytes);
    const mismatch = native(["persona", "create", "other", "--file", spacedSource, "--space", "alpha", `--${format}`], scratch);
    const failure = format === "json" ? JSON.parse(mismatch.stdout).error : undefined;
    const schemaInvalid = format === "json" ? failure?.code === "SCHEMA_INVALID" : mismatch.stderr.includes("SCHEMA_INVALID");
    const remedy = format === "json" ? failure?.remedy : mismatch.stderr;
    const retry = remedy?.match(/create it under its own name with `([^`]+)`/)?.[1];
    const launchers = format === "json" ? ["cotal"] : ["cotal", "pnpm cotal"];
    check(`a mismatched import quotes the filename and keeps --space and --${format}`,
      mismatch.status === 1 && schemaInvalid &&
        launchers.some(cli => retry === `${cli} persona create ${name} --file 'sample card.md' --space alpha --${format}`) &&
        !existsSync(agentFilePath(ALPHA, "other")), mismatch.stdout + mismatch.stderr);
    if (process.platform !== "win32") {
      const copied = spawnSync("sh", ["-c", `cotal() { "$NODE" "$CLI" "$@"; }; pnpm() { "$@"; }; ${retry}`], {
        cwd: scratch, env: { ...childEnv, NODE: process.execPath, CLI: binary }, encoding: "utf8", timeout: 30_000,
      });
      const imported = agentFilePath(ALPHA, name);
      check(`the --${format} retry imports the original bytes into alpha`,
        copied.status === 0 && existsSync(imported) && readFileSync(imported).equals(importBytes), copied.stdout + copied.stderr);
      if (format === "json") {
        const receipt = JSON.parse(copied.stdout);
        check("the printed JSON retry returns a persona-written document for alpha",
          receipt.outcome === "ok" && receipt.target?.space === "alpha" && receipt.result?.kind === "persona-written" &&
            receipt.result?.name === name, copied.stdout + copied.stderr);
      }
    }
  }

  {
    // The file's own name already occupies the catalog, so the own-name retry the
    // mismatch refusal would print is a command the catalog refuses. The refusal must
    // omit it and point at a separate copy instead, leaving the original intact.
    const occupied = "---\nname: occupied_retry\nagent: claude\n---\nFixture.\n";
    const occupiedPath = agentFilePath(ALPHA, "occupied_retry");
    writeFileSync(occupiedPath, occupied);
    const clash = native(["persona", "create", "fresh_retry", "--file", occupiedPath, "--space", "alpha", "--plain"], scratch);
    check("a mismatched import with an occupied own name omits the conflicting create retry",
      clash.status === 1 && clash.stderr.includes("SCHEMA_INVALID") &&
      !clash.stderr.includes("cotal persona create occupied_retry") &&
      clash.stderr.includes("change its name to 'fresh_retry' in a separate copy of the input file and retry with that copy") &&
      readFileSync(occupiedPath, "utf8") === occupied, clash.stderr);
    const copy = join(scratch, "fresh_retry.md");
    writeFileSync(copy, occupied.replace("name: occupied_retry", "name: fresh_retry"));
    const copied = native(["persona", "create", "fresh_retry", "--file", copy, "--space", "alpha", "--plain"], scratch);
    check("the advised separate copy imports under the requested name and leaves the original intact",
      copied.status === 0 && readFileSync(agentFilePath(ALPHA, "fresh_retry"), "utf8") === readFileSync(copy, "utf8") &&
      readFileSync(occupiedPath, "utf8") === occupied, copied.stdout + copied.stderr);
    // A twin that differs only in case refuses the suggested create too, so it is omitted as well.
    const twinPath = join(ALPHA, ".cotal", "agents", "CaseTwin.md");
    writeFileSync(twinPath, "---\nname: casetwin\n---\nFixture.\n");
    const twinClash = native(["persona", "create", "fresh_twin", "--file", twinPath, "--space", "alpha", "--plain"], scratch);
    check("a mismatched import with a case-only twin omits the conflicting create retry",
      twinClash.status === 1 && twinClash.stderr.includes("SCHEMA_INVALID") &&
      !twinClash.stderr.includes("cotal persona create casetwin"), twinClash.stderr);
    // Piped input has no file to copy, so the occupied remedy keeps only the corrected pipe.
    const pipedOccupied = Buffer.from("---\nname: occupied_retry\n---\nInstructions from standard input.\n");
    const stdinClash = native(["persona", "create", "fresh_stdin", "--file", "-", "--space", "alpha", "--json"], scratch, childEnv, pipedOccupied);
    const stdinFailure = JSON.parse(stdinClash.stdout).error;
    check("the stdin mismatch remedy drops the occupied retry and keeps the corrected pipe",
      stdinClash.status === 1 && stdinFailure?.code === "SCHEMA_INVALID" &&
      !stdinFailure?.remedy.includes("pipe the original definition into") &&
      stdinFailure?.remedy === "set its name to 'fresh_stdin' and pipe the corrected definition into the original command", stdinClash.stdout);
  }

  const decoyFile = agentFilePath(ALPHA, "encoded");
  const decoy = "---\nname: encoded\n---\nAlpha instructions.\n";
  writeFileSync(decoyFile, decoy);
  for (const selector of [["--space", "alpha"], ["--server", "nats://127.0.0.1:4301"]]) {
    const conflict = native(["persona", "create", "encoded", "--prompt", "Do not change.", "--subscribe", "", ...selector, "--plain"], scratch);
    const remedy = conflict.stderr.match(/change it with `([^`]+)`, or remove it with `([^`]+)` first/);
    check(`persona create conflict keeps ${selector[0]} in both recovery commands`,
      conflict.status === 2 && conflict.stderr.includes("CONFLICT") &&
      remedy?.[1] === `cotal persona edit encoded ${selector.join(" ")}` &&
      remedy?.[2] === `cotal persona remove encoded ${selector.join(" ")}`, conflict.stderr);
    const edit = native([...remedy![1]!.split(" ").slice(1), "--json"], scratch, { ...childEnv, VISUAL: "true" });
    const receipt = JSON.parse(edit.stdout);
    check(`the suggested edit with ${selector[0]} opens alpha, not the selected catalog`,
      edit.status === 0 && receipt.target?.space === "alpha" && receipt.outcome === "no-op" &&
      readFileSync(decoyFile, "utf8") === decoy && readFileSync(encodedFile).equals(utf8), edit.stdout + edit.stderr);
  }

  function checkTargetedRetries() {
    if (process.platform === "win32") return;
    const alphaFile = agentFilePath(ALPHA, "Reviewer");
    const otherFile = agentFilePath(MESH, "Reviewer");
    const alphaCard = "---\nname: Reviewer\n---\nAlpha instructions.\n";
    const otherCard = alphaCard.replace("Alpha", "Other");
    const invalid = "---\nname: Reviewer\nsubscribe: [\n---\nInvalid draft.\n";
    const editor = join(scratch, "invalid-editor");
    const uppercase = join(ALPHA, ".cotal", "agents", "Other.MD");
    writeFileSync(uppercase, alphaCard);
    if (!existsSync(agentFilePath(ALPHA, "other"))) {
      const blocked = native(["persona", "create", "other", "--prompt", "Never saved.", "--subscribe=", "--space", "alpha", "--json"], scratch);
      const failure = JSON.parse(blocked.stdout).error;
      check("an uppercase extension still collides but is not an editable catalog stem", blocked.status === 2 && failure?.code === "CONFLICT" && failure.message.includes("Other.MD") && failure.remedy === "choose another persona name" && readFileSync(uppercase, "utf8") === alphaCard, blocked.stdout);
    }
    writeFileSync(alphaFile, alphaCard);
    writeFileSync(otherFile, otherCard);
    writeFileSync(editor, `#!/bin/sh\ncat > "$1" <<'EOF'\n${invalid}EOF\n`, { mode: 0o700 });
    for (const selector of [["--space", "alpha"], ["--server", "nats://127.0.0.1:4301"]]) {
      const conflict = native(["persona", "create", "reviewer", "--prompt", "Never saved.", "--subscribe=", ...selector, "--json"], scratch);
      const failure = JSON.parse(conflict.stdout).error;
      const edit = failure?.remedy.match(/`([^`]+)`/)?.[1];
      check(`case-only conflict keeps ${selector[0]} in the suggested edit`,
        conflict.status === 2 && failure?.code === "CONFLICT" && failure.message.includes("only in case") &&
        edit === `cotal persona edit Reviewer ${selector.join(" ")}`, conflict.stdout);
      const args = [...edit.split(" ").slice(1), "--json"];
      const refused = native(args, scratch, { ...childEnv, VISUAL: editor, TMPDIR: scratch });
      const receipt = JSON.parse(refused.stdout);
      const draft = receipt.error?.remedy.match(/kept in (.*?); correct it/)?.[1];
      const retry = receipt.error?.remedy.match(/`([^`]+)`/)?.[1];
      check(`invalid draft keeps ${selector[0]} and JSON in the retry and leaves both catalogs intact`,
        refused.status === 1 && receipt.target?.space === "alpha" && receipt.error?.code === "SCHEMA_INVALID" &&
        retry === `${edit} --json` && draft && readFileSync(draft, "utf8") === invalid &&
        readFileSync(alphaFile, "utf8") === alphaCard && readFileSync(otherFile, "utf8") === otherCard, refused.stdout);
      const retried = native(retry.split(" ").slice(1), scratch, { ...childEnv, VISUAL: "true" });
      const retriedReceipt = JSON.parse(retried.stdout);
      check(`the printed retry with ${selector[0]} opens alpha`,
        retried.status === 0 && retriedReceipt.target?.space === "alpha" && retriedReceipt.outcome === "no-op", retried.stdout + retried.stderr);
    }
  }
  checkTargetedRetries();

  const piped = Buffer.from("---\nname: piped-card\n---\nInstructions from standard input.\n");
  const stdinMismatch = native(["persona", "create", "other-stdin", "--file", "-", "--space", "alpha", "--json"], scratch, childEnv, piped);
  const stdinFailure = JSON.parse(stdinMismatch.stdout).error;
  const stdinRetry = stdinFailure?.remedy.match(/pipe the original definition into `([^`]+)` again/)?.[1];
  check("the stdin name-mismatch remedy says to pipe the original bytes into the same catalog",
    stdinMismatch.status === 1 && stdinFailure?.code === "SCHEMA_INVALID" &&
    stdinRetry === "cotal persona create piped-card --file - --space alpha --json" && !existsSync(agentFilePath(ALPHA, "other-stdin")), stdinMismatch.stdout);
  const pipedRetry = native(stdinRetry.split(" ").slice(1), scratch, childEnv, piped);
  check("the corrected command saves the original stdin definition to alpha",
    pipedRetry.status === 0 && JSON.parse(pipedRetry.stdout).result?.kind === "persona-written" &&
      readFileSync(agentFilePath(ALPHA, "piped-card")).equals(piped), pipedRetry.stdout + pipedRetry.stderr);

  for (const [field, value, expected] of [
    ["model", "42", '"model" must be a string; got number'],
    ["subscribe", "true", '"subscribe" must be an array of strings; got boolean'],
    ["tags", "[42, false]", '"tags" must be an array of strings; item 0 got number'],
  ]) {
    const name = `typed-${field}`, path = agentFilePath(MESH, name);
    writeFileSync(path, `---\nname: ${name}\n${field}: ${value}\n---\nReview the project.\n`);
    for (const args of [
      ["persona", "show", name, "--json"],
      ["persona", "create", `${name}-copy`, "--file", path, "--json"],
      ["spawn", name, "--foreground", "--dry-run", "--json"],
    ]) {
      const result = native(args);
      const diagnostic = expected.replaceAll('"', '\\"');
      check(`${args[0]} ${args[1]} refuses wrong YAML ${field} type`, result.status !== 0 && result.stdout.includes("SCHEMA_INVALID") && result.stdout.includes(path) && result.stdout.includes(diagnostic), result.stdout + result.stderr);
    }
    unlinkSync(path);
  }
  const validPath = agentFilePath(MESH, "typed-valid");
  writeFileSync(validPath, '---\nname: typed-valid\nmodel: "42"\nsubscribe: ["true"]\nallowPublish: ["true"]\ntags: ["42", "false"]\n---\nReview the project.\n');
  const validShow = native(["persona", "show", "typed-valid", "--json"]);
  const validDefinition = JSON.parse(validShow.stdout).result?.definition;
  check("persona show preserves quoted scalar-like strings and string lists", validShow.status === 0 && validDefinition?.model === "42" && validDefinition?.subscribe?.[0] === "true" && validDefinition?.tags?.join() === "42,false", validShow.stdout + validShow.stderr);
  const createPath = join(MESH, "valid-create.md");
  writeFileSync(createPath, readFileSync(validPath, "utf8").replace("name: typed-valid", "name: typed-created"));
  const validCreate = native(["persona", "create", "typed-created", "--file", createPath, "--json"]);
  check("persona create accepts correctly typed file", validCreate.status === 0, validCreate.stdout + validCreate.stderr);
  const validSpawn = native(["spawn", "typed-valid", "--foreground", "--dry-run", "--json"]);
  check("spawn dry-run accepts correctly typed file", validSpawn.status === 0 && validSpawn.stdout.includes('"42"'), validSpawn.stdout + validSpawn.stderr);

  function checkBrokenCatalog() {
    if (process.platform === "win32") return;
    const dir = join(realpathSync(ALPHA), ".cotal", "agents");
    const moved = `${dir}.saved`;
    renameSync(dir, moved);
    try {
      const absent = native(["persona", "--space", "alpha", "--json"]);
      check("an absent catalog is a complete empty listing", absent.status === 0 &&
        JSON.parse(absent.stdout).completeness === "complete" && JSON.parse(absent.stdout).result?.items.length === 0, absent.stdout);
      symlinkSync("missing-catalog", dir);
      const modern = native(["persona", "--space", "alpha", "--json"]);
      const legacy = native(["personas", "list", "--space", "alpha"]);
      const { error, outcome } = JSON.parse(modern.stdout);
      check("persona refuses a dangling catalog link and gives its target and remedy", modern.status === 2 && outcome === "refused" &&
        error?.code === "CONFLICT" && error.message.includes(dir) && error.message.includes("missing-catalog") &&
        error.remedy === "restore the link's target or move the broken link aside", modern.stdout + modern.stderr);
      check("legacy listing refuses the same link without suggesting creation", legacy.status === 2 && !legacy.stdout.includes("create one") &&
        legacy.stderr.includes(dir) && legacy.stderr.includes("missing-catalog") && legacy.stderr.includes(error.remedy), legacy.stdout + legacy.stderr);
      unlinkSync(dir);
      symlinkSync(moved, dir);
      const linked = native(["persona", "--space", "alpha", "--json"]);
      check("a working catalog link still lists its target", linked.status === 0 &&
        JSON.parse(linked.stdout).result?.items.some((item: { name: string }) => item.name === "alpha-only"), linked.stdout);
    } finally {
      rmSync(dir, { force: true });
      renameSync(moved, dir);
    }
  }
  checkBrokenCatalog();

  for (const field of ["subscribe", "allowSubscribe", "allowPublish", "quiet", "muted"]) {
    const path = agentFilePath(MESH, "invalid-channel");
    writeFileSync(path, `---\nname: invalid-channel\n${field}: ["#general"]\n---\nReview the project.\n`);
    const shown = native(["persona", "show", "invalid-channel", "--json"]);
    const { error } = JSON.parse(shown.stdout);
    check(`invalid channel diagnostic names ${field} and the file`, shown.status === 1 && error?.code === "SCHEMA_INVALID" &&
      error.message.includes(`${path}: "${field}": invalid channel`) && error.message.includes("NATS-safe token"), shown.stdout);
    unlinkSync(path);
  }

  function checkHyphenCreate() {
    const body = ["persona", "create", "--prompt", "Review changes.", "--subscribe", ""];
    const bytes = Buffer.from("---\r\nname: -created\r\n---\r\nReview changes.\r\n");
    for (const args of [body, ["persona", "create", "--file", "-"]]) {
      const refused = native([...args, "--space", "alpha", "--json", "--", "-created"], MESH, childEnv, bytes);
      const { error } = JSON.parse(refused.stdout);
      check("persona create refuses an invalid default name before writing", refused.status === 1 && error?.code === "USAGE_INVALID" &&
        error.message.includes('cannot start with "-"') && error.remedy.includes("such as reviewer") &&
        !existsSync(agentFilePath(ALPHA, "-created")), refused.stdout);
    }
    const path = agentFilePath(ALPHA, "created");
    for (const selector of [["--space", "alpha"], ["--server", "nats://127.0.0.1:4301"]]) {
      const created = native([...body, ...selector, "--plain", "created"], MESH);
      const next = [...created.stdout.matchAll(/^\s+(cotal .+?) {2,}\S.*$/gm)].map(match => match[1]!);
      check(`the create receipt preserves ${selector[0]}`, created.status === 0 &&
        JSON.stringify(next) === JSON.stringify([`cotal spawn created ${selector.join(" ")}`, `cotal p show created ${selector.join(" ")}`]), created.stdout + created.stderr);
      const shown = native(next[1]!.split(" ").slice(1), MESH);
      check("the printed show command reads the saved definition", shown.status === 0 &&
        shown.stdout.includes("Review changes.") && shown.stdout.includes(path), shown.stdout + shown.stderr);
      const spawn = native(["spawn", "--dry-run", "--json", ...next[0]!.split(" ").slice(2)], MESH);
      const result = JSON.parse(spawn.stdout).result;
      check("the printed spawn arguments select the saved persona and its valid default name", spawn.status === 0 &&
        result?.persona?.path === path && result.requestedName === "created", spawn.stdout + spawn.stderr);
      unlinkSync(path);
    }
  }
  checkHyphenCreate();

  {
    const path = agentFilePath(MESH, "-reviewer");
    writeFileSync(path, "---\nname: reviewer\nagent: claude\n---\nReview the project.\n");
    const listed = native(["persona", "--json"]);
    check("persona lists a hyphen-leading catalog name", listed.status === 0 &&
      JSON.parse(listed.stdout).result?.items.some((item: { name: string }) => item.name === "-reviewer"), listed.stdout);
    const shown = native(["persona", "show", "--plain", "--", "-reviewer"]);
    const next = [...shown.stdout.matchAll(/^\s+(cotal .+?) {2,}\S.*$/gm)].map(match => match[1]);
    check("persona show prints copyable follow-ups for a hyphen-leading catalog name", shown.status === 0 &&
      JSON.stringify(next) === JSON.stringify(["cotal p edit -- -reviewer", "cotal spawn -- -reviewer", "cotal p show --json -- -reviewer"]), shown.stdout + shown.stderr);
    if (process.platform !== "win32") {
      const edit = native(next[0]!.split(" ").slice(1), MESH, { ...childEnv, VISUAL: "true" });
      check("the printed edit command opens the local definition", edit.status === 0, edit.stdout + edit.stderr);
    }
    const spawn = native(["spawn", "--dry-run", "--json", ...next[1]!.split(" ").slice(2)]);
    check("the printed spawn arguments select the correct file", spawn.status === 0 &&
      JSON.parse(spawn.stdout).result?.persona?.path === path, spawn.stdout + spawn.stderr);
    const json = native(next[2]!.split(" ").slice(1));
    check("the printed JSON command returns the correct persona", json.status === 0 &&
      JSON.parse(json.stdout).result?.definition?.name === "reviewer", json.stdout + json.stderr);
    const plain = native(["persona", "remove", "--plain", "--no-input", "--", "-reviewer"]);
    check("persona remove keeps plain output before the end of options in its confirmation", plain.status === 1 && plain.stderr.includes("`cotal persona remove --yes --plain -- -reviewer`") && existsSync(path), plain.stderr);
    const refused = native(["persona", "remove", "--json", "--", "-reviewer"]);
    const remove: string | undefined = JSON.parse(refused.stdout).error?.remedy?.match(/`([^`]+)`/)?.[1];
    check("persona remove prints a JSON confirmation for a hyphen-leading catalog name",
      refused.status === 1 && remove === "cotal persona remove --yes --json -- -reviewer" && existsSync(path), refused.stdout);
    const removed = remove ? native(remove.split(" ").slice(1)) : undefined;
    check("the printed remove command removes the existing definition with a JSON receipt",
      removed?.status === 0 && !existsSync(path) && JSON.parse(removed.stdout).result?.action === "removed", removed && removed.stdout + removed.stderr);
  }
  {
    const path = agentFilePath(MESH, "nul-endpoints");
    const card = "---\nname: nul-endpoints\nagent: claude\nendpoints:\n---\nReview the project.\n";
    writeFileSync(path, card);
    for (const args of [["persona", "show", "nul-endpoints"], ["spawn", "nul-endpoints", "--dry-run"]]) {
      const refused = native([...args, "--json"]);
      const { error } = JSON.parse(refused.stdout);
      check(`${args[0]} refuses a blank endpoints declaration and explains how to fix it`, refused.status === 1 &&
        error?.code === "SCHEMA_INVALID" && error.message.includes(path) && error.message.includes('"endpoints" must be a list, not null') &&
        error.message.includes("Remove the key or supply a list"), refused.stdout + refused.stderr);
    }
    writeFileSync(path, card.replace("endpoints:", "endpoints: []"));
    const shown = native(["persona", "show", "nul-endpoints", "--json"]);
    check("persona show retains an explicit empty endpoints list", shown.status === 0 &&
      JSON.stringify(JSON.parse(shown.stdout).result?.definition?.endpoints) === "[]", shown.stdout + shown.stderr);
    unlinkSync(path);
  }

  {
    const path = agentFilePath(MESH, "broken-fence");
    for (const [source, diagnostic] of [
      ["---\nname: broken-fence\n---oops\nBody.\n", 'missing closing "---" frontmatter fence on its own line'],
      ["---\n---\nBody.\n", '"name" is required'],
    ]) {
      writeFileSync(path, source);
      for (const args of [["persona", "show", "broken-fence"], ["spawn", "broken-fence", "--foreground", "--dry-run"]]) {
        const refused = native([...args, "--json"]);
        const { error } = JSON.parse(refused.stdout);
        check(`${args[0]} reports ${diagnostic}`, refused.status === 1 && error?.code === "SCHEMA_INVALID" &&
          error.message.includes(path) && error.message.endsWith(diagnostic), refused.stdout + refused.stderr);
      }
    }
    writeFileSync(path, "---\r\nname: broken-fence\r\n--- \t\r\nBody.\r\n");
    const repaired = native(["persona", "show", "broken-fence", "--json"]);
    const definition = JSON.parse(repaired.stdout).result?.definition;
    check("persona show accepts spaces and tabs on a closing fence without changing the body",
      repaired.status === 0 && definition?.persona === "Body.", repaired.stdout);
    unlinkSync(path);
  }
  for (const pin of ["", " \t"]) {
    const path = agentFilePath(MESH, "blank-agent");
    writeFileSync(path, `---\nname: blank-agent\nagent: ${JSON.stringify(pin)}\n---\nBody.\n`);
    const show = native(["persona", "show", "blank-agent", "--plain"]);
    check(`persona show treats ${JSON.stringify(pin)} as no application pin`,
      show.status === 0 && show.stdout.includes("Application: user default"), show.stdout + show.stderr);
    for (const [want, flags] of [["claude", []], ["jcode", ["--harness", "jcode"]]] as const) {
      const spawn = native(["spawn", "blank-agent", "--foreground", "--dry-run", "--json", ...flags],
        MESH, { ...childEnv, COTAL_DEFAULT_AGENT: "claude" });
      check(`spawn preview of ${JSON.stringify(pin)} uses ${flags.length ? "the explicit harness" : "the default"}`,
        spawn.status === 0 && JSON.parse(spawn.stdout).result?.harness === want, spawn.stdout + spawn.stderr);
    }
    unlinkSync(path);
  }

  // FAIL CLOSED. A completer must never throw into the operator's interactive shell, and must not
  // guess a root when none resolves. With `--space` naming a mesh that is not registered there is
  // no target, so the honest answer is no items.
  check("completion fails CLOSED on an unresolvable target (no throw, no items)", personasComplete(["--space", "no-such-mesh", "show", ""]).items.length === 0);

  console.log(`\npersona-root smoke: ${pass} checks passed`);
} finally {
  process.chdir(prevCwd);
  rmSync(scratch, { recursive: true, force: true });
}
