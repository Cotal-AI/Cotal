/** `run check` identifies the current and candidate programs without implying a migration.
 * Exercises the built CLI on an owned loopback stack. Needs nats-server on PATH. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { emitSentinel, freePort } from "@cotal-ai/smoke-kit";

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
const cli = resolve("bin/dist/cotal.js");
const call = async (...args: string[]) => {
  try {
    const out = await exec(process.execPath, [cli, ...args], { cwd: project, env, timeout: 60_000 });
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
writeFileSync(join(project, "good.cotal.js"), source);
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
let up = false;
try {
  await succeed("up", "--detach", "--server", `nats://127.0.0.1:${await freePort()}`);
  up = true;
  const started = JSON.parse(await succeed("run", "start", "good.cotal.js", "--json"));
  const id = started.target.run as string;
  assert.ok(id);
  const running = await until(id, view => view.journal.some(row => row.step === "/checkpoint:approve#0" && row.state === "pending"));
  assert.equal(running.status?.state, "running");
  const current = running.programHash;
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
  await succeed("run", "answer", id, "/checkpoint:approve#0", "--value", '"yes"');
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
