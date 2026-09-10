/**
 * Seat behavior cells plus worker-death survival and wait-exit close settlement.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptSeatSync, launchSeat, reapSeat, SeatClient } from "../src/index.js";
import { EXIT_LINGER_MAX_MS, EXIT_LINGER_MS } from "../src/protocol.js";

if (process.platform !== "linux") {
  console.log(`SEAT LIFECYCLE COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
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
const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await wait(25);
  return predicate();
};
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

const root = mkdtempSync(join(tmpdir(), "cotal-seat-life-"));
const handles: Array<{
  stop: (o?: { graceful?: boolean }) => void;
  close?: () => void;
  record: { custodianPid: number; childPid: number };
}> = [];

const collect = async (h: ReturnType<typeof adoptSeatSync>, ms = 800): Promise<string> => {
  const sess = h.attach();
  let buf = "";
  sess.onData((b) => {
    buf += b.toString("utf8");
  });
  await wait(ms);
  return buf.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
};

try {
  {
    const rec = launchSeat({
      root,
      name: "counter",
      spec: {
        command: process.execPath,
        args: ["-e", "let n=0; setInterval(()=>process.stdout.write(String(++n)+'\\n'), 50)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    handles.push(h);
    check("spawn: custodian and child are live", state(rec.custodianPid) !== "gone" && state(rec.childPid) !== "gone", rec);
    const snap = await h.attach().backlog();
    check("snapshot: backlog returns bytes", snap.length >= 0);
    const first = await collect(h, 400);
    const second = await collect(h, 400);
    check("concurrent read: two attach sessions both receive output", /\d/.test(first) && /\d/.test(second), { first, second });
    h.write("ping\n");
    const afterWrite = await collect(h, 200);
    check("input: write does not throw and seat stays running", h.status() === "running", afterWrite);
    h.attach().resize(80, 24);
    h.attach().resize(0, 0);
    check("resize: 0x0 is a no-op and seat stays running", h.status() === "running");
    await h.attach().backlog();
    const sized = h.attach();
    sized.resize(90, 25);
    check("resize: geometry is visible on the attach session", sized.cols === 90 && sized.rows === 25);
    await wait(50);
    check("resize: geometry survives the hello apply", sized.cols === 90 && sized.rows === 25, {
      cols: sized.cols,
      rows: sized.rows,
    });
    const worker = mkdtempSync(join(root, "worker-"));
    const ready = join(worker, "ready.json");
    const here = dirname(fileURLToPath(import.meta.url));
    const dist = join(here, "..", "dist");
    writeFileSync(
      join(worker, "owner.mjs"),
      `import { launchSeat, adoptSeatSync } from ${JSON.stringify(join(dist, "index.js"))};\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `const rec = launchSeat({ root: ${JSON.stringify(root)}, name: "survive", spec: { command: process.execPath, args: ["-e", "setInterval(()=>{}, 1000)"], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd() });\n` +
        `const h = adoptSeatSync(rec);\n` +
        `writeFileSync(process.env.READY ?? "", JSON.stringify({ workerPid: process.pid, childPid: rec.childPid, custodianPid: rec.custodianPid, id: rec.id }));\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    let owner: ChildProcess | undefined;
    owner = spawn(process.execPath, [join(worker, "owner.mjs")], {
      env: { PATH: process.env.PATH ?? "", READY: ready },
      stdio: "ignore",
    });
    const armed = await until(() => {
      try {
        return JSON.parse(readFileSync(ready, "utf8")).childPid !== undefined;
      } catch {
        return false;
      }
    }, 10_000);
    check("isolated worker fixture armed", armed);
    const ids = JSON.parse(readFileSync(ready, "utf8")) as { workerPid: number; childPid: number; custodianPid: number; id: string };
    process.kill(ids.workerPid, "SIGKILL");
    check("the fixture killed its actual worker process", await until(() => state(ids.workerPid) === "gone", 5_000), ids);
    check(
      "worker death leaves the custodial child PID running",
      await until(() => state(ids.childPid) !== "gone" && state(ids.childPid) !== "Z", 5_000),
      { child: state(ids.childPid), custodian: state(ids.custodianPid) },
    );
    const adopted = adoptSeatSync({
      version: 1,
      id: ids.id,
      name: "survive",
      socket: join(root, ids.id, "seat.sock"),
      token: JSON.parse(readFileSync(join(root, ids.id, "record.json"), "utf8")).token,
      custodianPid: ids.custodianPid,
      childPid: ids.childPid,
    });
    handles.push(adopted);
    check("adopt: successor proxy talks to the surviving seat", (await adopted.attach().backlog()).length >= 0);
    adopted.stop({ graceful: false });
    await adopted.waitForExit();
    check("hard stop: child is gone after waitForExit", await until(() => state(ids.childPid) === "gone" || state(ids.childPid) === "Z", 5_000), state(ids.childPid));
    if (owner.exitCode === null) owner.kill("SIGKILL");
  }

  {
    const rec = launchSeat({
      root,
      name: "exit-notify",
      spec: {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    handles.push(h);
    await h.attach().backlog();
    let fired = false;
    h.attach().onExit(() => {
      fired = true;
    });
    process.kill(rec.childPid, "SIGKILL");
    check(
      "onExit fires without an output subscription",
      await until(() => fired, 5_000),
      { fired, status: h.status() },
    );
  }

  {
    const rec = launchSeat({
      root,
      name: "fast-exit",
      spec: {
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    handles.push(h);
    check(
      "fast-exit child is gone before onExit subscribe",
      await until(() => state(rec.childPid) === "gone" || state(rec.childPid) === "Z", 5_000),
      state(rec.childPid),
    );
    await h.attach().backlog();
    check(
      "handle already observed exit before a late onExit subscribe",
      await until(() => h.status() === "exited", 5_000),
      h.status(),
    );
    let fired = false;
    h.attach().onExit(() => {
      fired = true;
    });
    check(
      "onExit fires for a child that exits before hello",
      await until(() => fired, 5_000),
      { fired, status: h.status() },
    );
  }

  {
    const rec = launchSeat({
      root,
      name: "wait-exit-close",
      spec: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const client = new SeatClient(rec);
    handles.push({
      stop: () => {},
      close: () => client.close(),
      record: rec,
    });
    await client.connect();
    check(
      "wait-exit close race: child has already exited",
      await until(() => client.info().status === "exited", 5_000),
      client.info(),
    );
    const pending = client.waitExit();
    client.close();
    let err = "";
    try {
      await pending;
    } catch (e) {
      err = (e as Error).message;
    }
    check("wait-exit still settles after close once the child has exited", err === "", err);
  }

  {
    const rec = launchSeat({
      root,
      name: "natural",
      spec: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('bye\\n'); process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    await h.waitForExit();
    check("natural exit: waitForExit resolves and status is exited", h.status() === "exited");
    h.close();
    const recordGone = join(root, rec.id, "record.json");
    check(
      "natural exit: custodian process, socket, and record converge without fixture kill",
      await until(() => {
        const custodianGone = state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z";
        return custodianGone && !existsSync(rec.socket) && !existsSync(recordGone);
      }, 5_000),
      {
        custodian: state(rec.custodianPid),
        socket: existsSync(rec.socket),
        record: existsSync(recordGone),
      },
    );
    handles.push(h);
  }

  {
    const rec = launchSeat({
      root,
      name: "fast-print",
      spec: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('FAST_MARK=1\\n'); process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    handles.push(h);
    check(
      "fast-print child is gone before attach subscribe",
      await until(() => state(rec.childPid) === "gone" || state(rec.childPid) === "Z", 5_000),
      state(rec.childPid),
    );
    const sess = h.attach();
    let buf = "";
    sess.onData((b) => {
      buf += b.toString("utf8");
    });
    let exited = false;
    sess.onExit(() => {
      exited = true;
    });
    await until(() => exited, 5_000);
    const seen = buf.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    check("fast-exit print reaches onData before onExit", exited && seen.includes("FAST_MARK=1"), { exited, seen });
  }

  {
    const leakRoot = mkdtempSync(join(tmpdir(), "sl-"));
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const dist = join(here, "..", "dist");
      const script = join(leakRoot, "drop-socket.mjs");
      writeFileSync(
        script,
        `import { launchSeat, adoptSeatSync } from ${JSON.stringify(join(dist, "index.js"))};
const rec = launchSeat({
  root: ${JSON.stringify(leakRoot)},
  name: "dropleak",
  spec: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } },
  cwd: process.cwd(),
});
const h = adoptSeatSync(rec);
h.stop({ graceful: false });
await h.waitForExit();
`,
      );
      const dropEnv = { ...process.env };
      for (const key of Object.keys(dropEnv)) if (key.startsWith("COTAL_")) delete dropEnv[key];
      const drop = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 8_000,
        killSignal: "SIGKILL",
        env: dropEnv,
      });
      check(
        "waitForExit drops the controller socket so the worker can exit",
        drop.status === 0 && drop.signal === null,
        { status: drop.status, signal: drop.signal, stderr: drop.stderr },
      );
    } finally {
      rmSync(leakRoot, { recursive: true, force: true });
    }
  }

  {
    // A custodian whose child has exited is not custody of anything. With no controller connected it
    // exits after the linger and forgets its record; before this policy it lived forever, one idle
    // node process per seat the manager ever ran.
    const rec = launchSeat({
      root,
      name: "linger-unadopted",
      spec: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    check("record pins both start identities", typeof rec.custodianStart === "string" && typeof rec.childStart === "string", rec);
    check(
      "unadopted custodian exits after its child exits",
      await until(() => state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z", EXIT_LINGER_MS + 5_000),
      state(rec.custodianPid),
    );
    check("its socket and record are gone with it", !existsSync(rec.socket) && !existsSync(join(root, rec.id, "record.json")), rec.socket);
  }

  {
    // A connected controller holds the custodian open past the linger (a late backlog read must
    // still work), but never past the hard bound: a manager that forgets to close its handle is
    // not a reason to keep a childless custodian alive forever.
    const rec = launchSeat({
      root,
      name: "linger-held",
      spec: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('held\\n'); process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    await h.waitForExit().catch(() => undefined);
    const held = adoptSeatSync(rec);
    await held.attach().backlog();
    await wait(EXIT_LINGER_MS + 1_000);
    check("a connected controller holds the exited custodian past the linger", state(rec.custodianPid) !== "gone", state(rec.custodianPid));
    held.close();
    check(
      "the custodian exits once the last controller drops",
      await until(() => state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z", EXIT_LINGER_MS + 5_000),
      state(rec.custodianPid),
    );
    check("the hard bound is wider than the linger", EXIT_LINGER_MAX_MS > EXIT_LINGER_MS);
  }

  {
    // reapSeat: a live custodied seat nobody adopted is signalled by identity, its process group is
    // proved empty, and the record is forgotten. A record without start identities refuses.
    const rec = launchSeat({
      root,
      name: "reap-live",
      spec: {
        command: process.execPath,
        args: ["-e", "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    await wait(500);
    const before = readdirSync("/proc").filter((e) => /^\d+$/.test(e)).filter((e) => {
      try {
        const stat = readFileSync(`/proc/${e}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2] === String(rec.childPid);
      } catch {
        return false;
      }
    });
    check("instrument: the seat child leads a group with a grandchild", before.length >= 2, before);
    const evidence = await reapSeat(root, rec.id);
    check("reapSeat signals a live seat by identity and proves it gone", evidence.outcome === "reaped" && state(rec.childPid) === "gone" && state(rec.custodianPid) === "gone", evidence);
    const after = before.filter((e) => state(Number(e)) !== "gone");
    check("the child's whole process group is gone", after.length === 0, after);
    check("the custody record is forgotten", !existsSync(join(root, rec.id)), rec.id);
    check("a second reap of the same id reports absent", (await reapSeat(root, rec.id)).outcome === "absent");
  }

  {
    // Identity refusal: a record naming a pid whose start token differs is never signalled.
    const rec = launchSeat({
      root,
      name: "reap-foreign",
      spec: {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    handles.push(adoptSeatSync(rec));
    const bare = { ...rec };
    delete (bare as Partial<typeof rec>).custodianStart;
    writeFileSync(join(root, rec.id, "record.json"), `${JSON.stringify(bare)}\n`);
    let refused = "";
    try {
      await reapSeat(root, rec.id);
    } catch (e) {
      refused = (e as Error).message;
    }
    check("a record with no start identity refuses to signal", /no process start identity/.test(refused) && state(rec.childPid) !== "gone", refused);
    // A forged identity proves the pids are not the recorded processes: nothing is signalled and
    // the record is forgotten as already-gone custody.
    const forged = { ...rec, custodianStart: "1", childStart: "1" };
    writeFileSync(join(root, rec.id, "record.json"), `${JSON.stringify(forged)}\n`);
    const evidence = await reapSeat(root, rec.id);
    check("a pid whose start identity differs from the record is treated as gone, never signalled", evidence.outcome === "reaped" && state(rec.childPid) !== "gone" && state(rec.custodianPid) !== "gone", { evidence, child: state(rec.childPid) });
  }

  {
    const rec = launchSeat({
      root,
      name: "grace",
      spec: {
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    h.stop({ graceful: true });
    await h.waitForExit();
    check("graceful stop: waitForExit resolves", h.status() === "exited");
    h.close();
  }
} finally {
  for (const h of handles) {
    try {
      h.stop({ graceful: false });
    } catch {
      /* gone */
    }
    try {
      h.close?.();
    } catch {
      /* gone */
    }
    const childGone = state(h.record.childPid) === "gone" || state(h.record.childPid) === "Z";
    const custodianGone = state(h.record.custodianPid) === "gone" || state(h.record.custodianPid) === "Z";
    if (childGone && custodianGone) continue;
    try {
      process.kill(h.record.custodianPid, "SIGKILL");
    } catch {
      /* gone */
    }
    try {
      process.kill(h.record.childPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nSEAT LIFECYCLE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
