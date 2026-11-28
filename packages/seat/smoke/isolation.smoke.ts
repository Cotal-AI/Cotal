/**
 * Isolate screen mirror faults and custodian death from another seat's I/O.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { adoptSeatSync, launchSeat, linuxSharedCustodyAvailable, processStartToken, seatId, type SharedHandle } from "../src/index.js";
import { makeSeatRoot } from "@cotal-ai/smoke-kit";
import { SharedScreen } from "../src/shared-screen.js";
import { sharedCgroupAvailable } from "../src/shared-cgroup.js";
import { isSharedScope, readPrivateRecord, readSharedHost, recordedProcess } from "../src/shared-record.js";

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

async function eventually(predicate: () => boolean, timeout = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  do {
    if (predicate()) return true;
    await wait(25);
  } while (Date.now() < deadline);
  return false;
}

function removeScratch(path: string): void {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) removeScratch(join(path, name));
}

const cgRead = (path: string, name: string): string => readFileSync(join(path, name), "utf8").trim();

function writableLimit(path: string): boolean {
  try {
    accessSync(join(path, "memory.max"), constants.W_OK);
    if (existsSync(join(path, "memory.swap.max"))) accessSync(join(path, "memory.swap.max"), constants.W_OK);
    return true;
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function capFixtureMemory(unit: string, leaf: string): { target: string; description: string } | undefined {
  // On some systemd versions resource knobs on the service itself are not delegated.
  const target = writableLimit(unit) ? unit : writableLimit(leaf) ? leaf : undefined;
  if (!target) return undefined;
  const current = cgRead(target, "memory.current");
  assert(/^\d+$/.test(current));
  const cap = Number(current) + 24 * 1024 * 1024;
  assert(cap <= 256 * 1024 * 1024, `unsafe fixture memory baseline: ${current}`);
  assert.equal(cgRead(target, "memory.max"), "max");
  const swap = join(target, "memory.swap.max");
  if (existsSync(swap)) {
    writeFileSync(swap, "0");
    assert.equal(cgRead(target, "memory.swap.max"), "0");
  }
  writeFileSync(join(target, "memory.max"), String(cap));
  assert.equal(cgRead(target, "memory.max"), String(cap));
  const description = target === unit ? "private common-parent limit (seat leaves uncapped)" : "leaf-local limit (common-parent limit not writable)";
  return { target, description };
}

const runawayProgram = `
  const { existsSync, writeFileSync } = require('node:fs');
  writeFileSync('/proc/self/oom_score_adj', '1000');
  writeFileSync(process.argv[2], String(process.pid) + '\\n', { flag: 'wx', mode: 0o600 });
  const retained = [];
  let ticksAtCap = 0;
  setInterval(() => {
    if (!existsSync(process.argv[1])) return;
    for (let i = 0; i < 4 && retained.length < 96; i++) retained.push(Buffer.allocUnsafeSlow(1024 * 1024).fill(0x5a));
    for (const page of retained) for (let i = 0; i < page.length; i += 4096) page[i] ^= 1;
    if (retained.length === 96 && ++ticksAtCap === 80) process.exit(92);
  }, 25);
`;

const oomProgram = `
  const child = require('node:child_process').spawn(process.execPath,
    ['-e', ${JSON.stringify(runawayProgram)}, process.argv[1], process.argv[2]], { detached: true, stdio: 'ignore' });
  child.once('exit', (code, signal) => process.stdout.write('runaway:' + (signal ?? code) + '\\n'));
  ${program}
`;

function seatProbe(handle: SharedHandle) {
  let output = "";
  const terminal = handle.attach();
  terminal.onData(data => { output = (output + data.toString()).slice(-8192); });
  return {
    saw: (marker: string) => output.includes(marker),
    async reply(marker: string): Promise<boolean> {
      for (let n = 0; n < 10; n++) {
        assert.equal(await handle.write(`${marker}\n`), marker.length + 1);
        if (await eventually(() => output.includes(`echo:${marker}`), 350)) return true;
      }
      return false;
    },
  };
}

async function nativeRunawayOom(): Promise<void> {
  const skip = !linuxSharedCustodyAvailable() ? "systemd user manager or systemd-run unavailable" :
    !sharedCgroupAvailable() ? "unified cgroup v2 memory controller unavailable" :
      typeof (process as typeof process & { execve?: unknown }).execve !== "function" ? "Node process.execve unavailable" : undefined;
  if (skip) { console.log(`  SKIP v2 runaway OOM: ${skip}`); return; }
  const { launchManagedSharedSeat }: typeof import("../src/shared-managed.js") = await import(new URL("../dist/shared-managed.js", import.meta.url).href);
  const base = makeSeatRoot("cotal-v2-oom-");
  const lineage = join(base, `p-${seatId()}${seatId()}`), trigger = join(base, "allocate"), ready = join(base, "descendant.pid");
  const uid = process.getuid!();
  const badId = seatId(), goodId = seatId();
  const generations = () => existsSync(lineage) ? readdirSync(lineage).filter(name => /^[a-f0-9]{64}$/.test(name)).map(name => join(lineage, name)) : [];
  const launch = (id: string, args: string[]) => launchManagedSharedSeat(lineage, { root: lineage, id, name: id, cwd: base,
    spec: { command: process.execPath, args } });
  type Handle = NonNullable<Awaited<ReturnType<typeof launch>>>;
  const handles: Handle[] = [];
  const unitPath = (scope: string) => `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${scope}`;
  try {
    const bad = await launch(badId, ["-e", oomProgram, trigger, ready]);
    const roots = generations();
    if (!bad && roots.length === 1 && existsSync(join(roots[0]!, "execution.json")) && !existsSync(join(roots[0]!, "host.json"))) {
      console.log("  SKIP v2 runaway OOM: user manager did not publish a host with delegated memory cgroups");
      return;
    }
    assert(bad, "managed runaway seat did not launch");
    handles.push(bad);
    assert.equal(roots.length, 1);
    const generation = roots[0]!;
    const good = await launch(goodId, ["-e", program]);
    assert(good, "managed sibling seat did not launch");
    handles.push(good);
    const host = readSharedHost(generation);
    const unit = `/sys/fs/cgroup${unitPath(host.scope)}`, badLeaf = join(unit, `seat-${badId}`), goodLeaf = join(unit, `seat-${goodId}`);
    const badChild = bad.childIdentity, goodChild = good.childIdentity;
    assert(badChild && goodChild);
    const affected = seatProbe(bad), sibling = seatProbe(good);
    assert(await affected.reply("before-oom") && await sibling.reply("before-oom"), "both seats must answer before the OOM");
    assert(await eventually(() => existsSync(ready) && /^\d+\n$/.test(readFileSync(ready, "utf8"))), "runaway did not report its detached descendant");
    const descendant = Number(readFileSync(ready, "utf8"));
    const descendantStart = processStartToken(descendant);
    assert(descendantStart);
    const checkMember = (pid: number, start: string, leaf: string) => {
      assert.equal(recordedProcess(pid, start, host.bootId), "live");
      assert.equal(readFileSync(`/proc/${pid}/cgroup`, "utf8"), `0::${unitPath(host.scope)}/${leaf}\n`);
    };
    checkMember(host.pid, host.start, "host");
    checkMember(badChild.pid, badChild.start, `seat-${badId}`);
    checkMember(descendant, descendantStart, `seat-${badId}`);
    checkMember(goodChild.pid, goodChild.start, `seat-${goodId}`);
    assert.deepEqual(readdirSync(unit, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(),
      ["host", `seat-${badId}`, `seat-${goodId}`].sort());
    assert.equal(cgRead(unit, "cgroup.procs"), "");
    const hostLeaf = join(unit, "host");
    for (const path of [unit, hostLeaf, badLeaf, goodLeaf]) {
      assert.equal(realpathSync(path), path);
      assert.equal(statfsSync(path).type, 0x63677270);
      assert.equal(cgRead(path, "memory.max"), "max");
    }
    assert.equal(cgRead(hostLeaf, "cgroup.procs"), String(host.pid));
    assert.deepEqual(cgRead(badLeaf, "cgroup.procs").split("\n").sort(), [String(descendant), String(badChild.pid)].sort());
    assert.equal(cgRead(goodLeaf, "cgroup.procs"), String(goodChild.pid));
    assert.equal(cgRead(unit, "memory.oom.group"), "0");
    assert.equal(cgRead(badLeaf, "memory.oom.group"), "0");
    const kills = () => Number(/^oom_kill (\d+)$/m.exec(cgRead(unit, "memory.events"))?.[1]);
    const before = kills();
    assert(Number.isSafeInteger(before), "kernel did not report the unit's hierarchical OOM kill counter");
    const limit = capFixtureMemory(unit, badLeaf);
    if (!limit) { console.log("  SKIP v2 runaway OOM: no writable private memory limit"); return; }
    const parentOoms = () => Number(/^oom (\d+)$/m.exec(cgRead(unit, "memory.events.local"))?.[1]);
    const parentBefore = limit.target === unit ? parentOoms() : undefined;
    writeFileSync(trigger, "allocate\n", { flag: "wx", mode: 0o600 });
    assert(await eventually(() => recordedProcess(descendant, descendantStart, host.bootId) === "gone" && kills() > before && affected.saw("runaway:SIGKILL")),
      `runaway child OOM not proved under ${limit.description}`);
    if (parentBefore !== undefined) assert(parentOoms() > parentBefore, "common-parent cap did not cause the OOM");
    checkMember(host.pid, host.start, "host");
    checkMember(badChild.pid, badChild.start, `seat-${badId}`);
    checkMember(goodChild.pid, goodChild.start, `seat-${goodId}`);
    check(`v2 runaway child OOM preserves its seat, sibling and host (${limit.description})`,
      kills() === before + 1 && await affected.reply("after-oom") && await sibling.reply("after-oom"));
  } finally {
    for (const handle of handles) handle.close();
    for (const generation of generations()) {
      const pin = join(generation, "execution.json");
      if (!existsSync(pin)) continue;
      const { scope } = readPrivateRecord(pin) as { scope: unknown };
      assert(isSharedScope(scope));
      const group = `/sys/fs/cgroup${unitPath(scope)}`;
      spawnSync("/usr/bin/systemctl", ["--user", "--no-ask-password", "stop", "--", scope], { timeout: 8000, stdio: "ignore" });
      assert(await eventually(() => !existsSync(group)), `fixture unit still present: ${scope}`);
    }
    removeScratch(base);
    rmSync(base, { recursive: true });
  }
}

await nativeRunawayOom();

console.log(`\nSEAT ISOLATION ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
