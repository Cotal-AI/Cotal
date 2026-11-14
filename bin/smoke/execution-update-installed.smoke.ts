import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function inventory(root: string): { path: string; hash?: string; link?: string }[] {
  const rows: { path: string; hash?: string; link?: string }[] = [];
  const walk = (path: string, name: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) rows.push({ path: name, link: readlinkSync(path) });
    else if (info.isDirectory()) for (const item of readdirSync(path).sort()) walk(join(path, item), name ? `${name}/${item}` : item);
    else rows.push({ path: name, hash: createHash("sha256").update(readFileSync(path)).digest("hex") });
  };
  walk(root, "");
  return rows;
}

/** Installed-mode acceptance is driven with normal packed candidates by the existing upgrade matrix. */
export async function installedExecutionUpdate(input: { cli: string; installed: string; current: string; target: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const before = inventory(input.installed).filter(row => !["dist/cotal.js"].includes(row.path));
  const records: { args: string[]; status: number | null; stdout: string; stderr: string }[] = [];
  const run = (args: string[]) => new Promise<typeof records[number]>((resolve, reject) => {
    const child = spawn(input.cli, args, { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", status => { clearTimeout(timer); const row = { args, status, stdout, stderr }; records.push(row); resolve(row); });
  });
  assert.equal((await run(["--version"])).stdout.split("\n")[0], `cotal-ai ${input.current}`);
  let active = true, pending = false;
  const probes: Promise<typeof records[number]>[] = [];
  const timer = setInterval(() => {
    if (!active || pending) return;
    pending = true;
    probes.push(run(["--version"]).finally(() => { pending = false; }));
  }, 5);
  let updated;
  try { updated = await run(["update", "--self"]); }
  finally { active = false; clearInterval(timer); await Promise.all(probes); }
  assert.equal(updated.status, 0, updated.stderr);
  assert.ok(probes.length > 0, "at least one actual public CLI starts during update");
  for (const probe of await Promise.all(probes)) {
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok([`cotal-ai ${input.current}`, `cotal-ai ${input.target}`].includes(probe.stdout.split("\n")[0]!));
  }
  const status = await run(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const data = JSON.parse(status.stdout);
  assert.equal(data.result.machine.version, input.target);
  assert.ok(data.result.machine.install.root.includes(".cotal-generations"));
  assert.deepEqual(inventory(input.installed).filter(row => !["dist/cotal.js"].includes(row.path)), before);
  const output = process.env.COTAL_EXECUTION_ACCEPTANCE_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ records, probes: probes.length, canonicalProductUnchanged: true }, null, 2));
  console.log(`installed execution update: ${input.current} to ${input.target}, ${probes.length} overlapping starts, canonical product unchanged`);
}

if (process.argv[2] === "--installed") {
  const [cli, installed, current, target, cwd] = process.argv.slice(3);
  if (!cli || !installed || !current || !target || !cwd) throw new Error("installed execution update needs CLI, package root, current, target and cwd");
  await installedExecutionUpdate({ cli, installed, current, target, cwd, env: process.env });
}
