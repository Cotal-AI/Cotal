/** The detached process that holds one service's Windows job, started only by `startWin32Custodian`.
 *  It holds the job's only handle, so its death ends every member. It exits once the program has
 *  exited and the job is empty, or after a terminate request has emptied it. */
import { createServer } from "node:net";
import { CUSTODY_PROTOCOL, isCustodyPipe, serveCustody, type CustodyRequest, type CustodyStatus } from "./win32-custody.js";
import { win32ProcessBinding, type Win32JobLaunch } from "./win32-process.js";

const STDIN_LIMIT = 8 * 1024 * 1024;
const native = win32ProcessBinding();
// The launcher closes its end once it has the report; a late write must not end this process.
process.stdout.on("error", () => {});
const report = (value: unknown) => new Promise<void>((resolve) => process.stdout.write(JSON.stringify(value) + "\n", () => resolve()));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readLaunch() {
  let text = "";
  const timer = setTimeout(() => process.exit(1), 10_000);
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > STDIN_LIMIT) process.exit(1);
  }
  clearTimeout(timer);
  const value = JSON.parse(text) as Record<string, unknown>;
  const launch = value.launch as Record<string, unknown> | undefined;
  const key = typeof value.capability === "string" ? Buffer.from(value.capability, "base64") : Buffer.alloc(0);
  if (value.protocol !== CUSTODY_PROTOCOL || key.length !== 32 || typeof value.instanceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.instanceId) ||
      !isCustodyPipe(value.pipe) || typeof value.program !== "string" || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string") ||
      !launch || !["application", "commandLine", "cwd", "environment", "log"].every((name) => typeof launch[name] === "string") || launch.application !== value.program)
    throw new Error("invalid custody launch");
  return { key, instanceId: value.instanceId, pipe: value.pipe, program: value.program, args: value.args as string[], launch: launch as unknown as Win32JobLaunch };
}

let input: Awaited<ReturnType<typeof readLaunch>>;
try { input = await readLaunch(); }
catch (error) { await report({ error: error instanceof Error ? error.message : String(error) }); process.exit(1); }

const server = createServer();
try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.pipe, () => { server.off("error", reject); resolve(); }); }); }
catch { await report({ error: "the custody pipe is already taken; no program was launched" }); process.exit(1); }

let root: { pid: number; token: string };
try { root = native.launch(input.launch); }
catch (error) { await report({ error: error instanceof Error ? error.message : String(error) }); process.exit(1); }
const self = { pid: process.pid, token: native.creationToken(process.pid)! };

// This process holds the program's handle, so its PID is not reused while it stays listed.
const members = () => { const exited = native.rootExit() !== undefined; return native.jobProcesses().filter((pid) => pid !== root.pid || !exited); };
const status = (): CustodyStatus => ({ custodian: self, root: { ...root, exit: native.rootExit() ?? null }, members: members(), program: input.program, args: input.args });
async function handle(request: CustodyRequest): Promise<CustodyStatus> {
  if (request.op === "terminate") {
    native.terminate(request.code);
    for (const deadline = Date.now() + 10_000; Date.now() < deadline && (members().length > 0 || native.rootExit() === undefined);) await sleep(50);
  }
  return status();
}
serveCustody(server, input.key, input.instanceId, handle);
await report({ protocol: CUSTODY_PROTOCOL, custodian: self, process: root });
process.stdout.end();

const poll = setInterval(() => {
  let empty: boolean;
  try { empty = native.rootExit() !== undefined && members().length === 0; }
  catch { process.exit(1); }
  if (!empty) return;
  clearInterval(poll);
  // Closing waits for an answer in flight, such as a terminate reply, before this process exits.
  server.close(() => process.exit(0));
}, 250);
