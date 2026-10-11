// Dummy harness for the privileged native runtime proof. No plane, enrollment or model request.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManagedLifecycleHandoff, takeManagedHandoffFile } from "@cotal-ai/core";

const file = process.env.COTAL_MANAGED_HANDOFF_FILE!;
delete process.env.COTAL_MANAGED_HANDOFF_FILE;
const value = takeManagedHandoffFile(file);
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]!;
const doc = parseManagedLifecycleHandoff(value, { space: arg("--space"), owner: arg("--expect-owner"), actor: arg("--name"), lifecycleUid: arg("--expect-lifecycle-uid") });
const program = fileURLToPath(import.meta.url);
const privateGuess = join(dirname(program), "..", "manager-private", "dummy");
let readDenied = false, rootRegainDenied = false, migrationDenied = false;
try { readFileSync(privateGuess); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error; readDenied = true; }
try { process.setuid!(0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; rootRegainDenied = true; }
const membership = readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1]!;
try { writeFileSync(join("/sys/fs/cgroup", dirname(membership), "cgroup.procs"), String(process.pid)); }
catch (error) { if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; migrationDenied = true; }
const status = readFileSync("/proc/self/status", "utf8");
const field = (name: string) => new RegExp(`^${name}:\\s+(\\S+)`, "m").exec(status)?.[1];
const inherited = readdirSync("/proc/self/fd").some(fd => {
  try { return readlinkSync(`/proc/self/fd/${fd}`) === privateGuess; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
});
const grandchild = spawn("/usr/bin/setsid", [process.execPath, "-e", 'process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: "ignore" });
grandchild.on("spawn", () => {
  console.log("DELEGATED_NATIVE_OBSERVATION=" + JSON.stringify({
    uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!(),
    readDenied, rootRegainDenied, migrationDenied, inherited,
    noNewPrivs: field("NoNewPrivs"), capEff: field("CapEff"), capPrm: field("CapPrm"), capBnd: field("CapBnd"), capAmb: field("CapAmb"),
    handoffRemoved: !existsSync(file), unrelatedHostValue: process.env.UNRELATED_HOST_VALUE === undefined,
    tokenNotInArgv: !process.argv.some(arg => arg.includes(doc.actorToken)),
    cwd: process.cwd(), home: process.env.HOME, temp: process.env.TMPDIR,
    membership, descendantPid: grandchild.pid,
  }));
});
process.stdin.on("data", data => { if (data.toString().includes("exit-parent")) process.exit(0); });
setInterval(() => {}, 1000);
