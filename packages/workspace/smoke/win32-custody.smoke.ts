/** Windows process custody. The command line, environment block and custody handshake run on every
 *  platform over a local socket; the custodian itself runs only on a Windows runner. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRecordIdentity } from "../src/pid.js";
import { custodyRequest, custodyStatus, serveCustody, startWin32Custodian, type CustodyStatus } from "../src/win32-custody.js";
import { nativeWin32CreationToken, windowsCommandLine, windowsEnvironmentBlock } from "../src/win32-process.js";
import { probeLiveness } from "../src/pid.js";

const root = mkdtempSync(join(tmpdir(), "win32-custody-"));
let checks = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (!condition) console.error(`FAIL ${name}`, detail ?? "");
  assert.ok(condition, name);
  checks++;
  console.log(`PASS ${name}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const refused = async (promise: Promise<unknown>, text: string) => { try { await promise; return false; } catch (error) { return error instanceof Error && error.message.includes(text); } };
const throws = (fn: () => unknown, text: string) => { try { fn(); return false; } catch (error) { return error instanceof Error && error.message.includes(text); } };
// An independent statement of the handshake, so a raw peer can speak it.
const mac = (key: Buffer, id: string, label: string, ...parts: string[]) => createHmac("sha256", key).update(["cotal-win32-custody", "1", id, label, ...parts].join("\n")).digest("base64");
const instanceId = "6f1c2b9e-4a7d-4c1e-9b3a-2d5e8f0a1b2c";

try {
  check("C1 the command line quotes arguments as libuv does", windowsCommandLine("C:\\Program Files\\node.exe", ["a b", 'q"x', "end\\", "sp ace\\", "", "plain"]) ===
    '"C:\\Program Files\\node.exe" "a b" "q\\"x" end\\ "sp ace\\\\" "" plain');
  check("C2 a NUL cannot reach a command line", throws(() => windowsCommandLine("a.exe", ["x\0y"]), "NUL"));
  check("C3 the environment block is sorted without regard to case and fills what Windows needs",
    windowsEnvironmentBlock({ zeta: "1", Path: "p", Alpha: "2" }, { SystemRoot: "C:\\W", PATH: "parent" }) === "Alpha=2\0Path=p\0SystemRoot=C:\\W\0zeta=1\0");
  check("C4 an environment that names one variable twice is refused", throws(() => windowsEnvironmentBlock({ PATH: "a", Path: "b" }, {}), "more than once"));
  check("C5 malformed environment entries are refused",
    throws(() => windowsEnvironmentBlock({ "A=B": "1" }, {}), "invalid environment") && throws(() => windowsEnvironmentBlock({ A: "x\0" }, {}), "invalid environment") &&
    windowsEnvironmentBlock({ "=C:": "C:\\" }, {}) === "=C:=C:\\\0");

  // The handshake over a local socket: Unix domain here, a named pipe on Windows.
  const key = randomBytes(32);
  const path = process.platform === "win32" ? `\\\\.\\pipe\\cotal-custody-${randomBytes(16).toString("hex")}` : join(root, "custody.sock");
  const served: string[] = [];
  const server: Server = createServer();
  const status: CustodyStatus = { custodian: { pid: 41, token: "100" }, root: { pid: 42, token: "200", exit: null }, members: [42, 43], program: "C:\\p.exe", args: ["x"] };
  serveCustody(server, key, instanceId, async (request) => { served.push(request.op); return status; });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const answer = await custodyRequest(path, key, instanceId, { op: "status" });
  check("C6 a caller with the capability gets the custodian's answer", JSON.stringify(answer) === JSON.stringify(status) && served.length === 1);
  check("C7 an answer is checked against the recorded custodian",
    custodyStatus(answer, status.custodian).root.pid === 42 && throws(() => custodyStatus(answer, { pid: 41, token: "101" }), "another custody"));
  check("C8 a caller without the capability is dropped before any request runs",
    await refused(custodyRequest(path, randomBytes(32), instanceId, { op: "status" }), "did not prove") && served.length === 1);
  check("C9 a capability for another instance does not open this one",
    await refused(custodyRequest(path, key, "00000000-0000-4000-8000-000000000000", { op: "status" }), "did not prove") && served.length === 1);

  // A peer that holds the pipe name but not the capability cannot answer.
  const squatPath = process.platform === "win32" ? `\\\\.\\pipe\\cotal-custody-${randomBytes(16).toString("hex")}` : join(root, "squat.sock");
  const squatter = createServer();
  serveCustody(squatter, randomBytes(32), instanceId, async () => { throw new Error("unreachable"); });
  await new Promise<void>((resolve) => squatter.listen(squatPath, resolve));
  check("C10 a caller refuses a custodian that cannot prove the capability", await refused(custodyRequest(squatPath, key, instanceId, { op: "status" }), "did not prove"));
  squatter.close();

  // Raw peers: a replayed request proof, a malformed request and an oversized frame are all dropped.
  const raw = (frames: (serverNonce: string, client: string) => string[]) => new Promise<string>((resolve) => {
    const client = randomBytes(32).toString("base64");
    const socket = connect(path);
    let text = "", sent = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ protocol: 1, nonce: client }) + "\n"));
    socket.on("data", (chunk: string) => {
      text += chunk;
      if (!sent && text.includes("\n")) { sent = true; for (const frame of frames((JSON.parse(text) as { nonce: string }).nonce, client)) socket.write(frame); }
    });
    socket.on("close", () => resolve(text));
    socket.on("error", () => {});
  });
  const request = JSON.stringify({ op: "status" });
  const replayed = await raw((_, client) => [JSON.stringify({ request, proof: mac(key, instanceId, "request", client, randomBytes(32).toString("base64"), request) }) + "\n"]);
  check("C11 a request proof made for another connection is refused", !replayed.includes("result") && served.length === 1);
  const unknown = JSON.stringify({ op: "signal", name: "SIGTERM" });
  const malformed = await raw((nonce, client) => [JSON.stringify({ request: unknown, proof: mac(key, instanceId, "request", client, nonce, unknown) }) + "\n"]);
  check("C12 an authenticated request outside the protocol is dropped", !malformed.includes("result") && served.length === 1);
  const oversized = await raw(() => ["x".repeat(70 * 1024)]);
  check("C13 an oversized frame is dropped and the custodian keeps serving",
    !oversized.includes("result") && JSON.stringify(await custodyRequest(path, key, instanceId, { op: "status" })) === JSON.stringify(status) && served.length === 2);
  const unicode = await raw(() => [JSON.stringify({ request, proof: "\u00e9".repeat(44) }) + "\n"]);
  check("C15 a proof of non-ASCII characters is dropped and the custodian keeps serving",
    !unicode.includes("result") && JSON.stringify(await custodyRequest(path, key, instanceId, { op: "status" })) === JSON.stringify(status) && served.length === 3);
  const padded = await raw((nonce, client) => [JSON.stringify({ request, proof: mac(key, instanceId, "request", client, nonce, request), pad: "x".repeat(70 * 1024) }) + "\n"]);
  check("C16 an authenticated frame over the limit is dropped even with its newline", !padded.includes("result") && served.length === 3);
  const started = Date.now();
  const idle = await new Promise<number>((resolve) => { const socket = connect(path); socket.on("close", () => resolve(Date.now() - started)); socket.on("error", () => {}); });
  check("C14 a connection that never authenticates is closed at the deadline", idle >= 4_500 && idle < 9_000, idle);
  server.close();

  if (process.platform !== "win32") console.log("SKIP W1-W8: the custodian needs a native Windows runner");
  else {
    // A retained Windows process handle can keep its creation time readable after exit.
    const alive = (pin: { pid: number; token: string }) => nativeWin32CreationToken(pin.pid) === pin.token && probeLiveness(pin.pid) !== "dead";
    const until = async (condition: () => boolean | Promise<boolean>, ms = 10_000) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) if (await condition()) return true;
      return condition();
    };
    const program = (exitAfter?: number) => ["-e", `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); child.unref();
console.log(JSON.stringify({ argv: process.argv.slice(1), child: child.pid }));
${exitAfter === undefined ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(${exitAfter}), 500);`}`, "a b", 'q"x'];
    const launch = async (name: string, exitAfter?: number) => {
      const log = join(root, `${name}.log`);
      writeFileSync(log, "");
      const capability = randomBytes(32);
      const id = `6f1c2b9e-4a7d-4c1e-9b3a-${randomBytes(6).toString("hex")}`;
      const custody = await startWin32Custodian({ program: process.execPath, args: program(exitAfter), cwd: root, env: { PATH: process.env.PATH }, log, instanceId: id }, capability);
      let seen: { argv: string[]; child: number } | undefined;
      await until(() => { const line = readFileSync(log, "utf8").split(/\r?\n/).find((row) => row.startsWith("{")); if (line) seen = JSON.parse(line); return seen !== undefined; });
      return { custody, capability, id, seen: seen!, ask: (request: Parameters<typeof custodyRequest>[3]) => custodyRequest(custody.pipe, capability, id, request).then((value) => custodyStatus(value, custody.custodian)) };
    };

    const one = await launch("one");
    const first = await one.ask({ op: "status" });
    check("W1 the custodian pins itself and the program it launched",
      alive(one.custody.custodian) && alive(one.custody.process) && first.root.pid === one.custody.process.pid && first.root.exit === null && first.members.includes(one.seen.child) &&
      first.program === process.execPath && JSON.stringify(one.seen.argv) === JSON.stringify(["a b", 'q"x']), { first, seen: one.seen });
    check("W2 a wrong capability gets no answer from a live custodian", await refused(custodyRequest(one.custody.pipe, randomBytes(32), one.id, { op: "status" }), "did not prove") && alive(one.custody.custodian));
    const taken = await new Promise<string>((resolve) => { const other = createServer(); other.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "")); other.listen(one.custody.pipe, () => { other.close(); resolve("listening"); }); });
    check("W3 nobody else can listen on a live custodian's pipe", taken === "EADDRINUSE", taken);
    const childToken = nativeWin32CreationToken(one.seen.child)!;
    const ended = await one.ask({ op: "terminate", code: 1 });
    console.log(JSON.stringify({ terminatedRoot: { ...one.custody.process, current: nativeWin32CreationToken(one.custody.process.pid), liveness: probeLiveness(one.custody.process.pid) }, terminatedChild: { pid: one.seen.child, token: childToken, current: nativeWin32CreationToken(one.seen.child), liveness: probeLiveness(one.seen.child) } }));
    check("W4 terminate empties the job and reports the program's exit",
      ended.members.length === 0 && ended.root.exit === 1 && !alive(one.custody.process) && !alive({ pid: one.seen.child, token: childToken }), ended);
    check("W5 a custodian whose job emptied exits", await until(() => !alive(one.custody.custodian)));

    const two = await launch("two", 3);
    const twoChild = { pid: two.seen.child, token: nativeWin32CreationToken(two.seen.child)! };
    let after: CustodyStatus | undefined;
    await until(async () => (after = await two.ask({ op: "status" })).root.exit !== null);
    check("W6 a program that exits leaves its custodian holding the remaining members",
      after?.root.exit === 3 && JSON.stringify(after.members) === JSON.stringify([twoChild.pid]) && alive(two.custody.custodian) && alive(twoChild), after);
    check("W9 the exited program reads as gone while its custodian still holds its handle",
      assertRecordIdentity(two.custody.process).kind === "gone" && alive(two.custody.custodian), { identity: assertRecordIdentity(two.custody.process), current: nativeWin32CreationToken(two.custody.process.pid) });
    process.kill(two.custody.custodian.pid);
    check("W7 a custodian's death ends the members it held", await until(() => !alive(twoChild)));

    // A custodian whose pipe name is already taken launches nothing.
    const pipe = `\\\\.\\pipe\\cotal-custody-${randomBytes(16).toString("hex")}`;
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(pipe, resolve));
    const marker = join(root, "squatted.marker");
    const log = join(root, "squatted.log");
    writeFileSync(log, "");
    const entry = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "win32-custodian.js");
    const custodian = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const answer = new Promise<string>((resolve) => { let text = ""; custodian.stdout.setEncoding("utf8"); custodian.stdout.on("data", (chunk: string) => { text += chunk; }); custodian.on("exit", () => resolve(text)); });
    const args = ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`];
    custodian.stdin.end(JSON.stringify({ protocol: 1, capability: randomBytes(32).toString("base64"), instanceId, program: process.execPath, args, pipe,
      launch: { application: process.execPath, commandLine: windowsCommandLine(process.execPath, args), cwd: root, environment: windowsEnvironmentBlock({ PATH: process.env.PATH }), log } }) + "\n");
    const text = await answer;
    await sleep(1000);
    check("W8 a custodian refuses to launch when its pipe is taken", text.includes("already taken") && !existsSync(marker), text);
    holder.close();
  }
  console.log(`WINDOWS CUSTODY OK (${checks} checks; ${process.platform}/${process.arch}, ${process.version})`);
} finally {
  await sleep(200);
  rmSync(root, { recursive: true, force: true });
}
