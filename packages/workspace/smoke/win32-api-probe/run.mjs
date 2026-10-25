// Driver for the Windows API probe (probe.c, sysid.cpp). Diagnostic only, not a smoke suite: it runs
// on a Windows runner, prints every cell line, and exits 1 when a run fails or cannot start.
//
//   node packages/workspace/smoke/win32-api-probe/run.mjs <directory holding probe.exe and sysid.exe>
//
// `--hold <probe.exe> <0|1>` is the Node parent of the node-chain cells: it starts `probe custodian`
// non-detached (0) or detached (1), relays its line, and waits until the probe kills it.
import { spawn } from "node:child_process";
import { arch, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--hold") {
  const [probe, detached] = process.argv.slice(3);
  const child = spawn(probe, ["custodian"], { detached: detached === "1", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  child.stdout.pipe(process.stdout);
  setTimeout(() => process.exit(0), 90_000);
} else {
  if (process.platform !== "win32") throw new Error("the Windows API probe runs only on Windows");
  const dir = resolve(process.argv[2] ?? "");
  const probe = join(dir, "probe.exe");
  const sysid = join(dir, "sysid.exe");
  const self = fileURLToPath(import.meta.url);
  console.log(`node=${process.version} arch=${arch()} release=${release()}`);
  const runs = [
    ["probe as a non-detached Node child (inside Node's job)", probe, ["all"], false],
    ["probe as a detached Node child", probe, ["all"], true],
    ["probe with console-less helpers", probe, ["all", "--no-console"], false],
    ["probe as the non-admin restricted child", probe, ["run-restricted", probe, "all", "--as-restricted", "--no-console"], false],
    ["system ID, unpackaged", sysid, [], false],
    ["system ID as the non-admin restricted child", probe, ["run-restricted", sysid], false],
    ["custodian started non-detached by Node, Node killed", probe, ["node-chain", process.execPath, self, "0"], false],
    ["custodian started detached by Node, Node killed", probe, ["node-chain", process.execPath, self, "1"], false],
  ];
  let failed = 0;
  for (const [title, file, args, detached] of runs) {
    console.log(`\n== ${title}`);
    const { code, out } = await run(file, args, detached);
    process.stdout.write(out);
    console.log(`== exit ${code}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${failed ? `${failed} run(s) failed` : "every run passed"}`);
  process.exitCode = failed ? 1 : 0;
}

function run(file, args, detached) {
  return new Promise((done) => {
    const child = spawn(file, args, { detached, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", (error) => { clearTimeout(timer); done({ code: `spawn error: ${error.message}`, out }); });
    child.on("close", (code, signal) => { clearTimeout(timer); done({ code: code ?? signal, out }); });
  });
}
