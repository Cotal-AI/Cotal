/**
 * With no space to act on, `cotal auth mint` and `cotal doctor auth` name the next step. `auth mint`
 * refuses with TARGET_NOT_FOUND (exit 2) and says how to find local static signing authority.
 * Combining `--replace` with `--out` refuses before space lookup and gives both ways to retry.
 * `doctor auth` in a folder whose root holds no space reports a partial result (exit 4) whose
 * remedy says to run it in a space's root, in JSON and in the text report; in the root of a space
 * registered as open it is a no-op, with or without `--fix`, that says the space issues no
 * credentials. `cotal persona` with nothing selected, or with a `--server` no registration names,
 * refuses with TARGET_NOT_FOUND and says no space is selected here, since its catalog is read
 * offline. Nothing is written. In a folder a space is prepared for, the same `--server` reads that
 * folder's catalog under the prepared space's name, as `cotal up` there starts it.
 * Broker-free; the mesh registry is private to this run.
 *
 * Run: pnpm smoke:no-space-next
 */
import { strict as nodeAssert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { findCotalRoot, isCommandFailure, recordMesh, recordPreparedSpace, setCurrent, type CommandFailure } from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";
import { persona } from "../src/commands/persona.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const DOCTOR_NEXT = "run `cotal doctor auth` in a space's root folder; `cotal space` lists each space's root";

const startCwd = process.cwd();
const priorHome = process.env.COTAL_HOME;
const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-no-space-next-")));
const bare = join(base, "bare");
// Stop root discovery here even when the temp directory is below another Cotal project.
// The workstation home is not a space project.
process.env.COTAL_HOME = join(bare, ".cotal");
mkdirSync(process.env.COTAL_HOME, { recursive: true, mode: 0o700 });

/** The refusal one `persona` run in `bare` ends with. */
async function personaRefusal(values: Record<string, string | boolean | undefined>, positionals: string[]): Promise<CommandFailure> {
  process.chdir(bare);
  try { await persona({ values, positionals, raw: [] }); }
  catch (error) { if (isCommandFailure(error)) return error; throw error; }
  finally { process.chdir(startCwd); }
  throw new Error(`persona ${positionals.join(" ")} did not refuse`);
}

/** The target one `persona --json` run in `cwd` reports. */
async function personaTarget(values: Record<string, string | boolean | undefined>, cwd: string): Promise<unknown> {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.chdir(cwd);
  try {
    await persona({ values: { ...values, json: true }, positionals: [], raw: [] });
    return (JSON.parse(out.join("")) as { target?: unknown }).target;
  } finally {
    process.stdout.write = write;
    process.chdir(startCwd);
  }
}

/** One doctor run in `cwd`: what it wrote to stdout and stderr, and its exit code. */
async function diagnose(values: Record<string, string | boolean | undefined>, cwd = bare): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  const error = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => { out.push(`${a.join(" ")}\n`); };
  console.error = (...a: unknown[]) => { err.push(`${a.join(" ")}\n`); };
  process.chdir(cwd);
  try {
    process.exitCode = undefined;
    await doctor({ values, positionals: ["auth"], raw: [] });
    return { out: out.join(""), err: err.join("").replace(/\x1b\[[0-9;]*m/g, ""), code: process.exitCode as number | undefined };
  } finally {
    process.stdout.write = write;
    console.log = log;
    console.error = error;
    process.chdir(startCwd);
    process.exitCode = 0;
  }
}

try {
  assert.equal(findCotalRoot(bare), bare, "fixture: discovery stops at the private workstation home");

  // 1. auth mint with no mesh: a target refusal that names the next step, and no file written.
  {
    const wt = resolve(import.meta.dirname, "../../..");
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
      HOME: join(base, "home"), COTAL_HOME: process.env.COTAL_HOME, XDG_CONFIG_HOME: join(base, "xdg"), XDG_RUNTIME_DIR: join(base, "runtime") };
    const mint = (flags: string[]) => spawnSync(join(wt, "node_modules", ".bin", "tsx"), [join(wt, "bin", "cotal.ts"), "auth", "mint", "alice", ...flags], {
      cwd: bare, env, encoding: "utf8", timeout: 30_000,
    });
    const result = mint(["--plain"]);
    const out = `${result.stdout}${result.stderr}`.replace(/\s+/g, " ");
    assert.equal(result.status, 2, `auth mint with no mesh exits 2: ${out}`);
    assert.match(out, /Code:\s+TARGET_NOT_FOUND/, "auth mint with no mesh refuses the target");
    assert.match(out, /local static-auth space with `cotal up`.*`--space <name>`.*signing trust on this machine/, "auth mint names both ways to select local signing authority");
    assert.doesNotMatch(out, /cotal login|--server/, "auth mint does not suggest a login or bare broker address");
    assert.deepEqual(readdirSync(bare, { recursive: true }), [".cotal"], "auth mint with no mesh writes nothing");

    for (const identity of [[], ["--identity", "./example.creds"]]) {
      const refused = mint(["--replace", "--out", "./example.creds", ...identity, "--json"]);
      assert.equal(refused.status, 1, `--replace and --out refuse even with no mesh: ${refused.stdout}${refused.stderr}`);
      const envelope = JSON.parse(refused.stdout) as { outcome: string; error: { code: string; remedy: string } };
      assert.equal(envelope.outcome, "refused");
      assert.equal(envelope.error.code, "USAGE_INVALID");
      assert.equal(envelope.error.remedy, "drop --out to replace the standing credential, or drop --replace to re-mint an existing export using the same file for --out and --identity");
      assert.deepEqual(readdirSync(bare, { recursive: true }), [".cotal"], "conflicting output flags write nothing");
    }
  }

  // 1b. persona with nothing selected: its catalog is offline, so the refusal names the missing
  //     selection, not a mesh that is not running.
  {
    const failure = await personaRefusal({}, []);
    assert.equal(failure.code, "TARGET_NOT_FOUND", `persona with nothing selected: code (${failure.message})`);
    assert.equal(failure.message, "no space is selected, and this folder is not a space's project", "persona with nothing selected says so");
    assert.equal(failure.remedy, "run `cotal up` in a project, or name a prepared or registered space with `--space <name>`", "persona with nothing selected: the remedy names the next step");
  }

  // 2. doctor auth in a folder whose root holds no space: partial with a next step in JSON.
  {
    const { out, code } = await diagnose({ json: true });
    const envelope = JSON.parse(out) as { outcome: string; error?: { code: string; remedy?: string }; result: { space: string | null } };
    assert.equal(envelope.outcome, "partial", "doctor with no space: partial");
    assert.equal(envelope.error?.code, "OPERATION_PARTIAL", "doctor with no space: OPERATION_PARTIAL");
    assert.equal(envelope.error?.remedy, DOCTOR_NEXT, "doctor with no space: the JSON remedy names the next step");
    assert.equal(envelope.result.space, null, "doctor with no space: no space is assumed");
    assert.equal(code, 4, "doctor with no space: exit 4");
  }

  // 3. The same run as text: the remedy follows the partial line on stderr.
  {
    const { err, code } = await diagnose({});
    // A terminal may wrap the line, so compare with whitespace collapsed.
    assert.ok(err.replace(/\s+/g, " ").includes(`↳ ${DOCTOR_NEXT}`), `doctor with no space: the text report names the next step: ${err}`);
    assert.equal(code, 4, "doctor text with no space: exit 4");
    assert.deepEqual(readdirSync(bare, { recursive: true }), [".cotal"], "doctor with no space writes nothing");
  }

  // 4. persona with a --server that no registration names: outside a project there is no catalog,
  //    and the folder is not made into one.
  for (const [values, positionals] of [[{ server: "nats://127.0.0.1:1", json: true }, []], [{ server: "nats://127.0.0.1:1", prompt: "x", subscribe: "" }, ["create", "zz"]]] as const) {
    const failure = await personaRefusal(values, [...positionals]);
    const what = `persona ${positionals.join(" ")} --server <unregistered>`.replace("  ", " ");
    assert.equal(failure.code, "TARGET_NOT_FOUND", `${what}: code (${failure.message})`);
    assert.equal(failure.message, "no space registered here is at nats://127.0.0.1:1, and this folder is not a space's project", `${what}: the refusal names the address`);
    assert.deepEqual(readdirSync(bare, { recursive: true }), [".cotal"], `${what} writes nothing here`);
  }

  // 4b. persona with a --server that no registration names, in a folder a space is prepared for: the
  //     folder's catalog under the prepared space's name, where it used to read as `main`.
  {
    const prepared = join(base, "prepared");
    mkdirSync(join(prepared, ".cotal", "agents"), { recursive: true });
    recordPreparedSpace({ space: "b2", root: prepared, ts: new Date().toISOString() });
    assert.deepEqual(await personaTarget({ server: "nats://127.0.0.1:1" }, prepared), { root: prepared, space: "b2" }, "persona --server <unregistered> in a prepared folder names its prepared space");
  }

  // 5. doctor auth in the root of a space registered as open, with or without --fix: it issues no
  //    credentials, so there is nothing to check or repair, and the report says so rather than
  //    sending the user to a space's root.
  {
    const openRoot = join(base, "open");
    mkdirSync(join(openRoot, ".cotal"), { recursive: true });
    recordMesh({ space: "offen", server: "nats://127.0.0.1:2", root: openRoot, mode: "open", ts: new Date().toISOString(), origin: "manual" });
    const { out, code } = await diagnose({ json: true }, openRoot);
    const envelope = JSON.parse(out) as { outcome: string; result: { space: string | null; credentialScope: string } };
    assert.equal(envelope.outcome, "no-op", "doctor in an open space's root: no-op");
    assert.equal(envelope.result.space, "offen", "doctor in an open space's root: names the space");
    assert.equal(envelope.result.credentialScope, "open-space", "doctor in an open space's root: an open-space scope");
    assert.ok(code === undefined || code === 0, `doctor in an open space's root: exit 0 (${code})`);
    const text = await diagnose({}, openRoot);
    assert.ok(text.out.replace(/\s+/g, " ").includes("This space is open: it authenticates no one and issues no credentials, so there are none to check."), `doctor text in an open space's root says why: ${text.out}`);
    assert.ok(!`${text.out}${text.err}`.includes("in a space's root folder"), "doctor in an open space's root does not send the user to a space's root");
    for (const values of [{ fix: true, json: true }, { space: "offen", fix: true, json: true }]) {
      const what = `doctor ${values.space === undefined ? "" : "--space offen "}--fix in an open space's root`;
      const fixed = await diagnose(values, openRoot);
      const fixedEnvelope = JSON.parse(fixed.out) as { outcome: string; result: { space: string | null; credentialScope: string; repair: { requested: boolean; attempted: boolean } } };
      assert.equal(fixedEnvelope.outcome, "no-op", `${what}: no-op`);
      assert.equal(fixedEnvelope.result.space, "offen", `${what}: names the space`);
      assert.equal(fixedEnvelope.result.credentialScope, "open-space", `${what}: an open-space scope`);
      assert.deepEqual([fixedEnvelope.result.repair.requested, fixedEnvelope.result.repair.attempted], [true, false], `${what}: repair requested, not attempted`);
      assert.ok(fixed.code === undefined || fixed.code === 0, `${what}: exit 0 (${fixed.code})`);
    }

    // 5b. The same bare run while another folder's static space is the selection (#7375): the root's
    //     own space is still the scope, where the selection used to send the user to a space's root.
    const staticRoot = join(base, "static");
    mkdirSync(join(staticRoot, ".cotal"), { recursive: true });
    recordMesh({ space: "fest", server: "nats://127.0.0.1:3", root: staticRoot, mode: "auth", ts: new Date().toISOString(), origin: "manual" });
    setCurrent("fest");
    const selected = await diagnose({ json: true }, openRoot);
    const selectedEnvelope = JSON.parse(selected.out) as { outcome: string; result: { space: string | null; credentialScope: string } };
    assert.deepEqual([selectedEnvelope.outcome, selectedEnvelope.result.space, selectedEnvelope.result.credentialScope], ["no-op", "offen", "open-space"],
      "doctor in an open space's root with another space selected: the root's open space, a no-op");
    assert.ok(selected.code === undefined || selected.code === 0, `doctor in an open space's root with another space selected: exit 0 (${selected.code})`);
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(base, { recursive: true, force: true });
}

console.log("no-space-next smoke: OK - auth mint with no mesh and persona with no selection refuse TARGET_NOT_FOUND with their next step, doctor auth with no space is partial (exit 4) with a remedy in JSON and text, and persona --server with no registration refuses; nothing is written");
emitSentinel({ passed: cells(), failed: 0 });
