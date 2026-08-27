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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
let spawnComplete!: typeof import("../src/commands/spawn.js").spawnComplete;
let sendComplete!: typeof import("../src/commands/send.js").sendComplete;
let personaRootFor!: typeof import("../src/commands/mint.js").personaRootFor;
let mint!: typeof import("../src/commands/mint.js").mint;
let createSpaceAuth!: typeof import("@cotal-ai/core").createSpaceAuth;
let saveSpaceAuth!: typeof import("@cotal-ai/workspace").saveSpaceAuth;
let authDir!: typeof import("@cotal-ai/workspace").authDir;
try {
  ({ recordMesh, setCurrent, resolveMeshTarget } = await import("@cotal-ai/workspace"));
  ({ agentFilePath, loadAgentFile } = await import("@cotal-ai/core"));
  ({ listPersonas } = await import("../src/lib/personas.js"));
  ({ personas, personasComplete } = await import("../src/commands/personas.js"));
  ({ spawnComplete } = await import("../src/commands/spawn.js"));
  ({ sendComplete } = await import("../src/commands/send.js"));
  ({ personaRootFor, mint } = await import("../src/commands/mint.js"));
  ({ createSpaceAuth } = await import("@cotal-ai/core"));
  ({ saveSpaceAuth, authDir } = await import("@cotal-ai/workspace"));
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

const sorted = (r: { items: { value: string }[] }) => r.items.map((i) => i.value).sort();
const names = (root: string) => listPersonas(root).map((p) => p.name).sort();

/** Run `cotal personas list` for real and return everything it printed.
 *
 *  The command's answer IS its stdout, so that is what gets observed. Calling `listPersonas` with
 *  a root the suite resolved itself would grade the suite's own arithmetic instead of the
 *  command's, and would pass against the unfixed tree — measured, not hypothesised. */
async function captureList(values: { space?: string; server?: string }): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await personas({ values, positionals: ["list"], raw: [] });
  } finally {
    console.log = realLog;
  }
  // Strip ANSI: the listing bolds names, so a flush-left name test would match nothing and every
  // "the cwd's personas are absent" check would pass for the wrong reason.
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run `cotal mint` for real and return everything it wrote. Same disposition as captureCmd. */
async function captureMint(positionals: string[], values: Record<string, unknown>): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log, realErr = console.error, realExit = process.exit;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  process.exit = ((code?: number) => { throw new Error(`__exit__${code ?? 0}`); }) as typeof process.exit;
  try {
    await mint({ values: values as never, positionals, raw: [] });
  } catch (e) {
    if (!/^__exit__/.test((e as Error).message)) lines.push(`THREW: ${(e as Error).message}`);
  } finally {
    console.log = realLog; console.error = realErr; process.exit = realExit;
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
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
let MESH!: string, CWD!: string, ALPHA!: string, BETA!: string;
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

  // 3. COMPLETERS. argv EXCLUDES the command name (same convention as spawn-from-anywhere's
  // `spawnComplete([""])`); the trailing "" is the word being completed.
  check("completion: spawn --role offers the MESH's declared roles", sorted(spawnComplete(["--role", ""])).join(",") === "mesh-builder,mesh-reviewer", sorted(spawnComplete(["--role", ""])));
  check("completion: spawn --subscribe offers the MESH's declared channels", sorted(spawnComplete(["--subscribe", ""])).join(",") === "mesh-alpha,mesh-beta", sorted(spawnComplete(["--subscribe", ""])));
  check("completion: send ask <role> offers the MESH's declared roles", sorted(sendComplete(["ask", ""])).join(",") === "mesh-builder,mesh-reviewer", sorted(sendComplete(["ask", ""])));
  check("completion: send msg <channel> offers the MESH's declared channels", sorted(sendComplete(["msg", ""])).join(",") === "mesh-alpha,mesh-beta", sorted(sendComplete(["msg", ""])));
  check("completion: personas show offers the MESH's persona names", sorted(personasComplete(["show", ""])).join(",") === "mesh-default,mesh-lead", sorted(personasComplete(["show", ""])));
  check("completion: personas show --space alpha offers ALPHA's names", sorted(personasComplete(["--space", "alpha", "show", ""])).join(",") === "alpha-only", sorted(personasComplete(["--space", "alpha", "show", ""])));

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

  // show — prints the resolved path as its first line, so the path itself is the observation.
  const shownPath = (await captureCmd(["show", "mesh-lead"], {})).split("\n").find((l) => l.trim())?.trim();
  check("show: opens the card under the MESH root", shownPath === join(MESH, ".cotal", "agents", "mesh-lead.md"), shownPath);
  // …and refuses a name that exists ONLY in the cwd, rather than silently opening the cwd's copy.
  const shownCwdOnly = await captureCmd(["show", "cwd-one"], {});
  check("show: a cwd-only persona is NOT found (it is not in the mesh's catalog)", /no persona "cwd-one"/.test(shownCwdOnly), shownCwdOnly.slice(0, 120));

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
  // Witnessed instead by pointing EDITOR at a no-op and checking which path it was handed.
  const edited = await captureCmd(["edit", "mesh-default"], {}, { EDITOR: "true" });
  check("edit: re-validates the card under the MESH root", /✓ saved "mesh-default"/.test(edited), edited.slice(0, 120));

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
  // DRIVE THE REAL `mint()`, not its seam. An earlier version of this cell called `personaRootFor`
  // directly and SURVIVED reverting mint.ts:152 to `cotalRoot()` — because that mutation removes
  // the CALL to personaRootFor rather than changing the function, so a cell invoking the seam still
  // got the right answer while the shipped path read the wrong card. That is pr-review's
  // unwitnessed-wrapper finding reproduced inside the cell written to close it. Driving `mint()`
  // is what makes the mutation observable.
  //
  // mint refuses before the card read without on-disk space auth, so the cwd root gets real trust
  // material; everything stays offline (no --provision, so no broker is contacted).
  saveSpaceAuth(authDir(CWD), await createSpaceAuth("meshspace"));
  const credsPath = join(scratch, "minted.creds");
  await captureMint(["minted"], { profile: "agent", out: credsPath });
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



  // FAIL CLOSED. A completer must never throw into the operator's interactive shell, and must not
  // guess a root when none resolves. With `--space` naming a mesh that is not registered there is
  // no target, so the honest answer is no items.
  check("completion fails CLOSED on an unresolvable target (no throw, no items)", personasComplete(["--space", "no-such-mesh", "show", ""]).items.length === 0);

  console.log(`\npersona-root smoke: ${pass} checks passed`);
} finally {
  process.chdir(prevCwd);
  rmSync(scratch, { recursive: true, force: true });
}
