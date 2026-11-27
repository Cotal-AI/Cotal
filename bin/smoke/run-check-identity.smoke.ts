/** `run check` identifies the current and candidate programs without implying a migration.
 * Exercises the built CLI on an owned loopback stack. Needs nats-server on PATH. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "cotal-run-check-"));
const project = join(root, "project");
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, {
  HOME: join(root, "home"), COTAL_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "xdg"), TMPDIR: join(root, "tmp"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
});
for (const path of [join(project, ".cotal"), env.HOME!, env.COTAL_HOME!, env.XDG_CONFIG_HOME!, env.TMPDIR!])
  mkdirSync(path, { recursive: true, mode: 0o700 });
const anchor = recordSmokeSandbox({ root: project, cotalHome: env.COTAL_HOME!, xdgConfigHome: env.XDG_CONFIG_HOME! });
const cli = resolve("bin/dist/cotal.js");
const call = async (...args: string[]) => {
  try {
    const options = { cwd: project, env, timeout: 60_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const out = await exec(process.execPath, [cli, ...args], options);
    return { code: 0, text: out.stdout + out.stderr };
  } catch (error) {
    const out = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (typeof out.code !== "number") throw error;
    return { code: out.code, text: (out.stdout ?? "") + (out.stderr ?? "") };
  }
};
const succeed = async (...args: string[]) => {
  const out = await call(...args);
  assert.equal(out.code, 0, out.text);
  return out.text;
};
let passed = 0, failed = 0;
const check = (name: string, condition: boolean, output: string) => {
  if (condition) { passed++; console.log(`ok: ${name}`); }
  else { failed++; console.error(`FAIL: ${name}\n${output}`); }
};
const source = 'const d = await checkpoint("approve", "Ship it?");\nlog("resolved", d.status);\n';
const quotedProgram = "reviewer's $draft.cotal.js";
writeFileSync(join(project, "good.cotal.js"), source);
writeFileSync(join(project, quotedProgram), source);
writeFileSync(join(project, "edited.cotal.js"), source.replace('"resolved"', '"resolved-edited"'));
writeFileSync(join(project, "diverged.cotal.js"), source.replace('"Ship it?"', '"Changed question?"'));
const read = async (id: string) => JSON.parse(await succeed("run", "show", id, "--json")).result.view as {
  programHash: string; status?: { state: string }; journal: Array<{ step?: string; state?: string }>;
};
const until = async (id: string, ready: (view: Awaited<ReturnType<typeof read>>) => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const view = await read(id);
    if (ready(view)) return view;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`run ${id} did not reach the expected state`);
};
const retryWords = (remedy: string): string[] => {
  const command = /(`+)(cotal run .*?)\1$/.exec(remedy)?.[2];
  assert.ok(command, remedy);
  const [binary, ...words] = execFileSync("bash", ["-c", `printf '%s\\0' ${command}`], { cwd: project, env, encoding: "utf8" }).split("\0").slice(0, -1);
  assert.equal(binary, "cotal");
  return words;
};
let up = false;
try {
  for (const verb of ["check", "migrate"]) for (const flags of [["--adopt", "h1"], ["--release", "h1"], ["--discard-approvals"]]) {
    const out = await call("run", verb, "run-missing", "good.cotal.js", ...flags);
    check(`${verb} ${flags[0]} refuses before a mesh exists`, out.code === 1 && out.text.includes(`${flags[0]} decides what a commit does`)
      && out.text.includes(`run the check without ${flags[0]}`) && !out.text.includes("no mesh"), out.text);
  }
  for (const verb of ["check", "migrate"]) for (const flag of ["--adopt", "--release"]) for (const after of [[], ["--local"], ["--"]]) {
    const out = await call("run", verb, "run-missing", "good.cotal.js", flag, ...after);
    check(`${verb} ${[flag, ...after].join(" ")} tells the user to remove the flag`, out.code === 1
      && out.text.includes(`does not take ${flag}`) && out.text.includes(`run the check without ${flag}`)
      && !out.text.includes(`write ${flag}`) && !out.text.includes("no mesh"), out.text);
  }
  const unsupportedFile = await call("run", "resume", "run-example", "--file", "good.cotal.js", "--json");
  const fileRefusal = JSON.parse(unsupportedFile.text);
  check("hosted resume --file returns a structured usage refusal without a mesh", unsupportedFile.code === 1 && fileRefusal.error.code === "USAGE_INVALID" && fileRefusal.error.remedy.startsWith("remove only --file and its value from the original command"), unsupportedFile.text);
  const other = join(project, "other-workflows");
  for (const folder of [other, join(project, "selection")]) mkdirSync(folder, { mode: 0o700 });
  await succeed("space", "create", "workflow-target", "--root", other);
  await succeed("space", "create", "workflow-selected", "--root", join(project, "selection"));
  await succeed("use", "workflow-selected");
  for (const [verb, operands, expected] of [
    ["resume", ["run-example", "--file", "good.cotal.js"], ["run-example"]],
    ["start", [quotedProgram, "--admit-read", "none", "--admit-publish", "none"], ["--file", quotedProgram]],
  ] as const) {
    const refused = await call("run", verb, ...operands, "--local", "--space", "workflow-target", "--json");
    const error = JSON.parse(refused.text).error;
    const words = retryWords(error.remedy);
    assert.deepEqual(words, ["run", verb, ...expected, "--json", "--space", "workflow-target"]);
    const retried = await call(...words);
    const receipt = JSON.parse(retried.text);
    check(`the ${verb} retry reaches the requested manager's space, not the selected space`,
      refused.code === 1 && error.code === "USAGE_INVALID" && retried.code === 2 && receipt.error.code === "TARGET_UNAVAILABLE"
        && receipt.target.space === "workflow-target", retried.text);
  }
  await succeed("use", "--clear");
  const server = `nats://127.0.0.1:${await freePort()}`;
  await succeed("up", "--detach", "--server", server);
  up = true;
  const managers = JSON.parse(await succeed("ps", "--json")).result.managers;
  const selection = ["--space", "project", "--on", managers[0].instanceId];
  const recoveryServer = `nats://127.0.0.1:${await freePort()}`;
  const recoveryTarget = ["--space", "recovery-lab", "--server", recoveryServer, "--on", managers[0].instanceId, "--json"];
  const missingResume = await call("run", "resume", ...recoveryTarget);
  const resumeError = JSON.parse(missingResume.text).error;
  assert.equal(missingResume.code, 1, missingResume.text);
  assert.equal(resumeError.code, "USAGE_INVALID", missingResume.text);
  const correction = ". Then add a run ID after `run resume` in the original command";
  const resumeRemedy = resumeError.remedy as string;
  assert.ok(resumeRemedy.endsWith(correction), resumeRemedy);
  const resumeLookup = retryWords(resumeRemedy.slice(0, -correction.length));
  assert.deepEqual(resumeLookup, ["run", "list", ...recoveryTarget]);
  const recoveryList = await call(...resumeLookup);
  const recoveryReceipt = JSON.parse(recoveryList.text);
  check("the missing hosted resume ID lookup reaches the requested broker instead of the project broker",
    recoveryList.code === 2 && recoveryReceipt.error.code === "TARGET_UNAVAILABLE"
      && recoveryReceipt.error.message.includes(recoveryServer) && recoveryReceipt.target.space === "recovery-lab", recoveryList.text);
  const unknownShow = await call("run", "show", "run-missing", "--local", "--space", "project", "--server", server, "--endpoint", "manager", "--json");
  const unknownShowError = JSON.parse(unknownShow.text).error;
  assert.equal(unknownShow.code, 2, unknownShow.text);
  assert.equal(unknownShowError.code, "TARGET_NOT_FOUND", unknownShow.text);
  const showRetry = retryWords(unknownShowError.remedy);
  assert.deepEqual(showRetry, ["run", "list", "--local", "--space", "project", "--server", server, "--endpoint", "manager", "--json"]);
  const listed = JSON.parse(await succeed(...showRetry));
  check("the local show retry lists the recorded runs on the same target", listed.target.space === "project"
    && listed.warnings.some((warning: { code: string; target?: { endpoint?: string } }) => warning.code === "ENDPOINT_HAS_NO_RUNS" && warning.target?.endpoint === "manager")
    && Array.isArray(listed.result.items) && listed.result.items.length === 0, JSON.stringify(listed));
  for (const verb of ["answer", "amend"]) for (const local of [false, true]) {
    const flags = local ? ["--space", "project", "--local", "--by", "operator"] : selection;
    const out = await call("run", verb, "run-missing", "/checkpoint:approve#0", "--value", "true", ...flags, "--json");
    const refusal = JSON.parse(out.text);
    const remedy = refusal.error.remedy as string;
    check(`${verb}${local ? " --local" : ""} for an unknown run lists the same target`, out.code === 2 && refusal.error.code === "TARGET_NOT_FOUND" && remedy.includes("--space project") && (local ? remedy.includes("--local") : remedy.includes(`--on ${managers[0].instanceId}`)) && !remedy.includes("run show"), out.text);
    const followup = /`([^`]+)`/.exec(remedy)![1]!.split(" ").slice(1);
    check(`${verb}${local ? " --local" : ""} missing-run remedy succeeds`, (await call(...followup)).code === 0, remedy);
  }
  const started = JSON.parse(await succeed("run", "start", "good.cotal.js", "--json"));
  const id = started.target.run as string;
  assert.ok(id);
  const running = await until(id, view => view.journal.some(row => row.step === "/checkpoint:approve#0" && row.state === "pending"));
  assert.equal(running.status?.state, "running");
  const current = running.programHash;
  const checkTarget = ["--space", "project", "--server", server, "--endpoint", "manager", "--local"];
  const refusedCheck = await call("run", "check", id, "--file", quotedProgram, ...checkTarget, "--json");
  assert.equal(refusedCheck.code, 1, refusedCheck.text);
  assert.match(refusedCheck.text, /run check prints no --json output/);
  const checkRetry = retryWords(refusedCheck.text.trimEnd());
  assert.deepEqual(checkRetry, ["run", "check", id, "--file", quotedProgram, ...checkTarget]);
  const checked = await call(...checkRetry);
  check("the check retry keeps the quoted program and explicit target", checked.code === 0 && /admissible/.test(checked.text) && /program unchanged/.test(checked.text), checked.text);
  for (const verb of ["answer", "amend"]) {
    const out = await call("run", verb, id, "/checkpoint:missing#0", ...selection, "--json");
    const refusal = JSON.parse(out.text);
    check(`${verb} for a missing step reads its existing run on the same target`, out.code === 2 && refusal.error.remedy.includes(`cotal run show ${id} --space project --on ${managers[0].instanceId}`), out.text);
  }
  assert.match(current, /^sha256:[0-9a-f]{64}$/);
  const unchanged = await call("run", "check", id, "good.cotal.js");
  console.log(`running unchanged: exit=${unchanged.code}\n${unchanged.text}`);
  check("running unchanged program is identified without claiming a move", unchanged.code === 0
    && /unchanged|identical/i.test(unchanged.text) && unchanged.text.includes(current)
    && !/moves to|already.*terminal/i.test(unchanged.text), unchanged.text);
  const edited = await call("run", "check", id, "edited.cotal.js");
  console.log(`running edited: exit=${edited.code}\n${edited.text}`);
  const hashes: string[] = edited.text.match(/sha256:[0-9a-f]{64}/g) ?? [];
  const candidate = hashes.find(hash => hash !== current);
  check("admissible edit prints both distinct hashes without claiming a move", edited.code === 0
    && edited.text.includes("admissible") && hashes.includes(current) && candidate !== undefined
    && !/unchanged|identical|moves to/i.test(edited.text), edited.text);
  const diverged = await call("run", "check", id, "diverged.cotal.js");
  console.log(`diverged: exit=${diverged.code}\n${diverged.text}`);
  check("changed effect inputs still refuse with the divergence", diverged.code === 1
    && diverged.text.includes("not admissible") && diverged.text.includes("divergence"), diverged.text);
  const afterCheck = await read(id);
  check("checks do not change source or running state", afterCheck.programHash === current
    && afterCheck.status?.state === "running", JSON.stringify(afterCheck));
  const value = '{\n  "text": "reviewer\'s `$draft`"\n}';
  const artifact = "reviewer's $draft";
  const answerTarget = ["--space", "project", "--server", server, "--endpoint", "manager", "--on", managers[0].instanceId];
  const refusedAnswer = await call("run", "answer", id, "approve", "--value", value, "--artifact", artifact, ...answerTarget, "--json");
  assert.equal(refusedAnswer.code, 2, refusedAnswer.text);
  const refusal = JSON.parse(refusedAnswer.text);
  assert.equal(refusal.error.code, "TARGET_NOT_FOUND");
  const answerRetry = retryWords(refusal.error.remedy);
  assert.deepEqual(answerRetry, ["run", "answer", id, "/checkpoint:approve#0", "--value", value, "--artifact", artifact, ...answerTarget, "--json"]);
  const answer = JSON.parse(await succeed(...answerRetry));
  assert.deepEqual(answer.result.answer.value, JSON.parse(value));
  check("the answer retry is accepted with the original JSON, artifact, and target", answer.outcome === "ok" && answer.result.answer.artifact === artifact, JSON.stringify(answer));
  await until(id, view => view.status?.state === "completed");
  for (const file of ["good.cotal.js", "edited.cotal.js"]) {
    const out = await call("run", "check", id, file);
    console.log(`completed ${file}: exit=${out.code}\n${out.text}`);
    check(`completed ${file} names the terminal state`, out.code === 0
      && /already completed/.test(out.text) && /terminal/.test(out.text)
      && !/moves to/.test(out.text), out.text);
    check(`completed ${file} retains program comparison`, out.text.includes(current)
      && (file === "good.cotal.js" ? /unchanged|identical/.test(out.text)
        : candidate !== undefined && out.text.includes(candidate)), out.text);
  }
  const resume = await call("run", "resume", id);
  check("terminal notice agrees with hosted resume refusal", resume.code === 2
    && resume.text.includes("already completed"), resume.text);
} finally {
  if (up) await succeed("down", "--yes");
  console.log(`owned stack stopped; retained fixture ${root}`);
}
emitSentinel({ passed, failed });
process.exitCode = failed === 0 ? 0 : 1;
