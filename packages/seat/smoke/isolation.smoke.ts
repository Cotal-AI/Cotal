/**
 * Isolate screen mirror faults and custodian death from another seat's I/O.
 */
import { readFileSync, rmSync } from "node:fs";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { adoptSeatSync, launchSeat } from "../src/index.js";
import { makeSeatRoot } from "@cotal-ai/smoke-kit";
import { SharedScreen } from "../src/shared-screen.js";

if (process.platform !== "linux") {
  console.log(`SEAT ISOLATION COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const state = (pid: number): string => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] ?? "unknown";
  } catch {
    try {
      process.kill(pid, 0);
      return "live";
    } catch {
      return "gone";
    }
  }
};

const root = makeSeatRoot("cotal-seat-iso-");
const program = "process.stdin.on('data',(d)=>process.stdout.write('echo:'+d)); setInterval(()=>{},1000)";

const a = launchSeat({
  root,
  name: "alpha",
  spec: { command: process.execPath, args: ["-e", program], env: { PATH: process.env.PATH ?? "" } },
  cwd: process.cwd(),
});
const b = launchSeat({
  root,
  name: "beta",
  spec: { command: process.execPath, args: ["-e", program], env: { PATH: process.env.PATH ?? "" } },
  cwd: process.cwd(),
});
const ha = adoptSeatSync(a);
const hb = adoptSeatSync(b);
check("two seats have distinct custodian pids", a.custodianPid !== b.custodianPid, { a: a.custodianPid, b: b.custodianPid });
check("two seats have distinct sockets", a.socket !== b.socket);

let buf = "";
const sess = hb.attach();
sess.onData((c) => {
  buf += c.toString("utf8");
});
hb.write("keep\n");
await wait(400);
check("beta received a write before the adversarial kill", buf.includes("echo:keep"), buf);

const sharedScreenIsolation = async (): Promise<void> => {
  const firstTerm = new Headless.Terminal({ allowProposedApi: true });
  const secondTerm = new Headless.Terminal({ allowProposedApi: true });
  const firstSerializer = new SerializeAddon();
  const secondSerializer = new SerializeAddon();
  firstTerm.loadAddon(firstSerializer);
  secondTerm.loadAddon(secondSerializer);
  const injected = new Error("fixture serialization fault");
  const faults: Array<{ error: unknown; operation: string }> = [];
  const onFault = (error: unknown, operation: string): void => { faults.push({ error, operation }); };
  let serializeCalls = 0;
  const first = new SharedScreen(firstTerm, {
    serialize: () => {
      if (++serializeCalls > 1) throw injected;
      return firstSerializer.serialize();
    },
  }, onFault);
  const second = new SharedScreen(secondTerm, secondSerializer, onFault);
  let output = "";
  const unsubscribe = sess.onData((chunk) => {
    const data = chunk.toString("utf8");
    second.write(data);
    output += data;
  });
  try {
    first.write("first mirror live");
    const before = await first.snapshot();
    const dropped = await first.snapshot();
    first.write("ignored");
    first.resize(90, 30);
    const disabled = await first.snapshot();

    const expected = "echo:screen-isolation";
    hb.write("screen-isolation\n");
    for (let attempt = 0; attempt < 100 && !output.includes(expected); attempt++) await wait(20);
    const surviving = await second.snapshot();
    check("a shared screen fault drops only that mirror and reports once",
      before.includes("first mirror live") && dropped === "" && disabled === "" && serializeCalls === 2 &&
      faults.length === 1 && faults[0]?.error === injected && faults[0]?.operation === "snapshot" &&
      output.includes(expected) && surviving.includes(expected),
      { before, dropped, disabled, serializeCalls, faults: faults.map(({ operation }) => operation), output, surviving });
  } finally {
    unsubscribe();
    firstTerm.dispose();
    secondTerm.dispose();
  }
};
await sharedScreenIsolation();

process.kill(a.custodianPid, "SIGKILL");
await wait(300);
check("alpha custodian is gone after SIGKILL", state(a.custodianPid) === "gone" || state(a.custodianPid) === "Z", state(a.custodianPid));
ha.close();

buf = "";
hb.write("still\n");
await wait(400);
check("beta still reads and writes after alpha custodian death", buf.includes("echo:still"), buf);

hb.stop({ graceful: false });
await hb.waitForExit();
hb.close();
try {
  process.kill(b.custodianPid, "SIGKILL");
} catch {
  /* gone */
}
try {
  process.kill(a.childPid, "SIGKILL");
} catch {
  /* gone */
}
rmSync(root, { recursive: true, force: true });

console.log(`\nSEAT ISOLATION ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
