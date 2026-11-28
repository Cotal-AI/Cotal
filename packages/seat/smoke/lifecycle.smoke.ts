/**
 * Seat behavior cells plus worker-death survival and wait-exit close settlement.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptSeatSync, launchSeat, linuxSharedCustodyAvailable, processStartToken, processStatFields, reapSeat, seatId, SeatClient } from "../src/index.js";
import { sharedCgroupAvailable } from "../src/shared-cgroup.js";
import { isSharedScope, readPrivateRecord, readSharedHost, recordedProcess, sharedHostSocket } from "../src/shared-record.js";
import { makeSeatRoot } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") {
  console.log(`SEAT LIFECYCLE COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

// OS-level socket teardown race: a block closes its handles before the linger cells, but the
// custodian tears the Unix socket down at the kernel level when it settles. If the FIN for our
// close() is still in flight when the custodian exits, the kernel delivers RST to this process's
// fd and Node surfaces it as an uncaught ECONNRESET on the internal Pipe read callback. The socket
// is already closed on our side, so this is the OS race and not a missing close. Everything else
// still ends the run.
process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
  console.error(err);
  process.exit(1);
});

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
const oomAdj = (pid: number): string => {
  try {
    return readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim();
  } catch {
    return "unreadable";
  }
};

const root = makeSeatRoot("cotal-seat-life-");
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
    // The launcher raises its own oom_score_adj above the seat value before launching: the custodian and the child inherit 600, so only the helper's write can make the child read 500. On a hosted runner whose processes already start at 500 an inherited value would otherwise pass the child cell with the write skipped (the CI reproof at 19312d774 let both oom mutants survive).
    writeFileSync("/proc/self/oom_score_adj", "600");
    check("oom: the launcher sits above the seat value, so inheritance cannot pass the child cell", oomAdj(process.pid) === "600");
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
    check("oom: the custodial child carries the seat preference", oomAdj(rec.childPid) === "500");
    check("oom: the custodian keeps the launcher's inherited oom_score_adj", oomAdj(rec.custodianPid) === oomAdj(process.pid));
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
    const recordFile = join(root, rec.id, "record.json");
    const exited = await until(() => {
      const custodianGone = state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z";
      return custodianGone && !existsSync(rec.socket) && existsSync(recordFile);
    }, 5_000);
    const reaped = exited ? await reapSeat(root, rec.id) : undefined;
    check(
      "natural exit: custodian process, socket, and record converge without fixture kill",
      Boolean(exited && reaped?.outcome === "reaped" && !existsSync(recordFile)),
      {
        custodian: state(rec.custodianPid),
        socket: existsSync(rec.socket),
        record: existsSync(recordFile),
        reaped: reaped?.outcome,
      },
    );
    handles.push(h);
  }

  {
    const prefix = "[cotal-fixture] diagnostic: ";
    const diagnostic = prefix + "x".repeat(4351 - prefix.length) + "🙂";
    const rec = launchSeat({
      root,
      name: "fast-print",
      spec: {
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(`${diagnostic} extra\nFAST_MARK=1\n`)}, () => process.exit(0))`],
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
    check("exit keeps a generic connector diagnostic up to the code point limit", h.exitInfo()?.diagnostic === `${diagnostic}…`);
  }

  {
    const leakRoot = makeSeatRoot("sl-");
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
    // Close every handle the blocks above still hold before the unadopted cells run: their
    // custodians can settle the moment their child has exited, and the settle tears the socket
    // down under a socket this process has not closed yet.
    for (const h of handles) { try { h.close?.(); } catch { /* already gone */ } }

    // A custodian whose child has exited is custody of nothing. Before this policy it lived
    // forever, one idle node process per seat the manager ever ran. Nobody adopts this seat, so it
    // settles on the custodian's unobserved-handoff path rather than on a client drop, which is the
    // one arm of that policy the adopted natural-exit cell above does not reach.
    const rec = launchSeat({
      root,
      name: "unadopted",
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
      await until(() => state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z", 20_000),
      state(rec.custodianPid),
    );
    const unadoptedRecord = join(root, rec.id, "record.json");
    const unadoptedSettled = !existsSync(rec.socket) && existsSync(unadoptedRecord);
    const unadoptedReaped = unadoptedSettled ? await reapSeat(root, rec.id) : undefined;
    check("its socket and record are gone with it", Boolean(unadoptedSettled && unadoptedReaped?.outcome === "reaped" && !existsSync(unadoptedRecord)), rec.socket);
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
    // A refusal is reported as this cell failing, never as a throw out of the suite: a reap that
    // refuses a record it should have signalled is exactly what these cells exist to catch, and a
    // throw here ends the run before any of them print.
    const evidence = await reapSeat(root, rec.id).catch((e: Error) => e);
    check("reapSeat signals a live seat by identity and proves it gone", !(evidence instanceof Error) && evidence.outcome === "reaped" && state(rec.childPid) === "gone" && state(rec.custodianPid) === "gone", evidence instanceof Error ? evidence.message : evidence);
    const after = before.filter((e) => state(Number(e)) !== "gone");
    check("the child's whole process group is gone", after.length === 0, after);
    check("the custody record is forgotten", !existsSync(join(root, rec.id)), rec.id);
    const second = await reapSeat(root, rec.id).catch((e: Error) => e);
    check("a second reap of the same id reports absent", !(second instanceof Error) && second.outcome === "absent", second instanceof Error ? second.message : second);
    // Whatever the cells above found, this seat must not outlive the suite.
    try { process.kill(-rec.childPid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(rec.custodianPid, "SIGKILL"); } catch { /* already gone */ }
  }

  {
    // A dead leader leaves no generation witness for its numeric group. Retain custody
    // rather than signalling members whose relationship to the recorded leader is unproved.
    const rec = launchSeat({
      root,
      name: "dead-leader-grandchild",
      spec: {
        command: process.execPath,
        args: ["-e", "const c = require('child_process').spawn(process.execPath, ['-e', 'process.on(\"SIGHUP\", ()=>{}); setInterval(()=>{},1000)'], { stdio: 'ignore' }); c.on('spawn', () => { setTimeout(() => process.exit(0), 100); });"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    // Wait for leader to exit naturally
    await until(() => state(rec.childPid) === "gone" || state(rec.childPid) === "Z", 5_000);
    // Wait for custodian to settle and exit
    await until(() => state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z", 5_000);
    // Verify grandchild is still running in the leader's process group
    const membersBefore = readdirSync("/proc").filter((e) => /^\d+$/.test(e)).filter((e) => {
      try {
        const stat = readFileSync(`/proc/${e}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2] === String(rec.childPid);
      } catch {
        return false;
      }
    });
    const owned = membersBefore.map((pid) => ({ pid: Number(pid), start: processStartToken(Number(pid)) }));
    check("instrument: grandchild lives after leader exit", owned.length >= 1 && owned.every((p) => p.start !== undefined), owned);
    const evidence = await reapSeat(root, rec.id).catch((e: Error) => e);
    check(
      "reapSeat refuses unproved dead-leader group ownership",
      evidence instanceof Error && /group ownership is unproved/.test(evidence.message),
      evidence instanceof Error ? evidence.message : evidence,
    );
    check("unproved group members retain their recorded identities", owned.every((p) => p.start !== undefined && processStartToken(p.pid) === p.start));
    check("unproved dead-leader custody record is retained", existsSync(join(root, rec.id, "record.json")));
    for (const p of owned) {
      if (p.start !== undefined && processStartToken(p.pid) === p.start) process.kill(p.pid, "SIGKILL");
    }
    const departed = await until(() => owned.every((p) => processStartToken(p.pid) !== p.start), 5_000);
    check("fixture-owned descendants depart before final reap", departed);
    const reaped = departed ? await reapSeat(root, rec.id) : undefined;
    check("verified empty group permits custody cleanup", reaped?.outcome === "reaped" && !existsSync(join(root, rec.id, "record.json")));

  }

  {
    // A reference reaches reapSeat and loadSeat from a durable slot row, so the id is checked
    // against the shape seatId mints before it is joined to the custody root. An id that walks out
    // of the root is refused rather than resolved: reporting it as absent would call an
    // unaddressable seat "already forgotten".
    const traversal = "../../../etc";
    let refusedReap = "";
    try { await reapSeat(root, traversal); } catch (e) { refusedReap = (e as Error).message; }
    check("a forged custody id that walks out of the root is refused, not resolved", /is not 32 lowercase hex characters/.test(refusedReap), refusedReap);
    let refusedLaunch = "";
    try { launchSeat({ root, name: "traversal", spec: { command: process.execPath, args: ["-e", ""], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd(), id: traversal }); } catch (e) { refusedLaunch = (e as Error).message; }
    check("a launch under a forged custody id is refused before any process starts", /is not 32 lowercase hex characters/.test(refusedLaunch), refusedLaunch);
    const reserved = seatId();
    const rec = launchSeat({ root, name: "reserved", spec: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd(), id: reserved });
    handles.push(adoptSeatSync(rec));
    check("a launch under a reserved id custodies the seat under exactly that id", rec.id === reserved && existsSync(join(root, reserved, "record.json")), { reserved, got: rec.id });
    let reused = "";
    try { launchSeat({ root, name: "reserved", spec: { command: process.execPath, args: ["-e", ""], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd(), id: reserved }); } catch (e) { reused = (e as Error).message; }
    check("a custody id already holding a record refuses a second launch", /already holds a custody record/.test(reused), reused);
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
    const evidence = await reapSeat(root, rec.id).catch((e: Error) => e);
    check("a pid whose start identity differs from the record is treated as gone, never signalled", !(evidence instanceof Error) && evidence.outcome === "reaped" && state(rec.childPid) !== "gone" && state(rec.custodianPid) !== "gone", { evidence: evidence instanceof Error ? evidence.message : evidence, child: state(rec.childPid) });
  }

  {
    // Boot binding: a start token counts ticks SINCE BOOT, so it tells two processes apart only
    // within one boot, while a custody record outlives a reboot on disk. A record carried across a
    // reboot names processes that ended with that boot, so it reaps as gone without signalling the
    // pids this boot put at those numbers. A record written before the boot stamp existed proves
    // neither, so it is refused.
    const rec = launchSeat({
      root,
      name: "reap-reboot",
      spec: {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    handles.push(adoptSeatSync(rec));
    const path = join(root, rec.id, "record.json");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    check("the custodian stamps the boot its pids belong to", onDisk.bootId === readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), onDisk.bootId);
    const { bootId: _dropped, ...unbound } = onDisk;
    writeFileSync(path, `${JSON.stringify(unbound)}\n`);
    let refusedUnbound = "";
    try { await reapSeat(root, rec.id); } catch (e) { refusedUnbound = (e as Error).message; }
    check("a record with no boot identity refuses to signal", /carries no boot identity/.test(refusedUnbound) && state(rec.childPid) !== "gone", { refusedUnbound, child: state(rec.childPid) });
    writeFileSync(path, `${JSON.stringify({ ...onDisk, bootId: "00000000-0000-0000-0000-000000000000" })}\n`);
    const foreign = await reapSeat(root, rec.id).catch((e: Error) => e);
    check("a record from another boot reaps as gone without signalling", !(foreign instanceof Error) && foreign.outcome === "reaped" && foreign.child === "gone" && foreign.custodian === "gone" && !existsSync(path) && state(rec.childPid) !== "gone" && state(rec.custodianPid) !== "gone", { foreign: foreign instanceof Error ? foreign.message : foreign, child: state(rec.childPid) });
  }

  {
    // An UNAUTHENTICATED socket must not pin a custodian whose child has exited. Such a peer holds
    // no session, no output subscription and no wait, so a settle owes it nothing; counting it kept
    // one ~65 MB custodian resident per stray dial for the life of the host, and suite runs
    // accumulated them until the box was under memory pressure (#1648). The adopter below
    // authenticates and leaves first, so this is the real post-handoff settle path, not the
    // unobserved-launch one.
    const rec = launchSeat({
      root,
      name: "unauthed-peer",
      spec: {
        command: process.execPath,
        args: ["-e", "setTimeout(()=>process.exit(0), 500)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const adopter = adoptSeatSync(rec);
    await adopter.attach().backlog();
    adopter.close();
    const mute = connect(rec.socket);
    mute.on("error", () => {});
    await new Promise<void>((resolve) => mute.once("connect", () => resolve()));
    check(
      "an unauthenticated peer does not keep a custodian whose child exited alive",
      await until(() => state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z", 20_000),
      { custodian: state(rec.custodianPid), child: state(rec.childPid) },
    );
    mute.destroy();
    try { process.kill(rec.custodianPid, "SIGKILL"); } catch { /* already gone */ }
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

  {
    const here = dirname(fileURLToPath(import.meta.url));
    const dist = join(here, "..", "dist");
    const distFiles = ["record.js", "reap.js", "launcher.js", "custodian.js", "index.js"] as const;
    const statReads = Object.fromEntries(
      distFiles.map((f) => [f, (readFileSync(join(dist, f), "utf8").match(/\/proc\/\$\{[^}]+\}\/stat/g) ?? []).length]),
    );
    const terminators = Object.fromEntries(
      distFiles.map((f) => [f, (readFileSync(join(dist, f), "utf8").match(/lastIndexOf\("\) "\)/g) ?? []).length]),
    );
    check(
      "stat parser: only record.js reads /proc/<pid>/stat and locates the comm terminator",
      JSON.stringify(statReads) === JSON.stringify({ "record.js": 1, "reap.js": 0, "launcher.js": 0, "custodian.js": 0, "index.js": 0 }) &&
        JSON.stringify(terminators) === JSON.stringify({ "record.js": 1, "reap.js": 0, "launcher.js": 0, "custodian.js": 0, "index.js": 0 }),
      { statReads, terminators },
    );

    const probeDir = mkdtempSync(join(root, "stat-probe-"));
    const probeScript = join(probeDir, "probe.mjs");
    writeFileSync(
      probeScript,
      `import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import * as seat from ${JSON.stringify(join(dist, "index.js"))};

assert.equal(typeof seat.processStatFields, "function");
assert.equal(process.env.COTAL_RUN, "probe-3152-real");
delete process.env.COTAL_RUN;

const sleepBin = cp.execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
const decoy = cp.spawn(sleepBin, ["300"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", COTAL_RUN: "probe-3152-decoy" } });
const real = cp.spawn(process.execPath, ["-e", "process.title = 'x) y (z'; setInterval(() => {}, 1000)"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
const P = real.pid;
const Q = decoy.pid;
assert.ok(P && Q);

try {
  for (let i = 0; i < 50; i++) {
    try {
      if (fs.readFileSync(\`/proc/\${P}/stat\`, "utf8").includes("(x) y (z)")) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 40));
  }
  const rawStat = fs.readFileSync(\`/proc/\${P}/stat\`, "utf8");
  assert.ok(rawStat.includes("(x) y (z)"), rawStat);
  const expectedToken = rawStat.slice(rawStat.lastIndexOf(") ") + 2).trim().split(/\\s+/)[19];

  const observe = () => ({
    fields: seat.processStatFields(P),
    token: seat.processStartToken(P),
    verdict: seat.identityVerdict(P, expectedToken),
    runMarker: seat.runMarker(process.env, P),
  });

  const before = observe();
  assert.ok(Array.isArray(before.fields) && before.fields.length >= 20);
  assert.equal(before.fields[1], String(process.pid));
  assert.equal(before.token, expectedToken);
  assert.equal(before.verdict, "live");
  assert.equal(before.runMarker, "probe-3152-real");

  const origRead = fs.readFileSync;
  const malformedLines = [
    \`\${P} \${Q} S\`,
    \`\${P} ) \${Q} S 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 99\`,
    \`\${Q} (x) y (z) S \${Q} \${Q} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 99\`,
    \`\${P} (x) y (z) S \${Q} \${Q}\`,
    \`\${P} (x) y (z) \`,
    \`\${P} (x) y (z) S \${Q} \${Q} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 99\\ninjected\`,
  ];
  const reapRoot = fs.mkdtempSync(path.join(${JSON.stringify(probeDir)}, "reap-"));
  try {
    for (const line of malformedLines) {
      fs.readFileSync = function (file, ...args) {
        if (String(file) === \`/proc/\${P}/stat\`) return line;
        return origRead.call(this, file, ...args);
      };
      syncBuiltinESMExports();
      const got = observe();
      assert.deepEqual(got, {
        fields: undefined,
        token: undefined,
        verdict: "gone",
        runMarker: \`pid-\${P}\`,
      }, \`malformed stat line failed: \${JSON.stringify(line)}\`);
    }

    const absentLeader = 999999;
    const reapId = "b".repeat(32);
    const reapRecPath = seat.recordPath(reapRoot, reapId);
    fs.mkdirSync(path.dirname(reapRecPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(reapRecPath, JSON.stringify({
      version: 1,
      id: reapId,
      name: "malformed-group-probe",
      socket: seat.socketPath(reapRoot, reapId),
      token: "fixture",
      custodianPid: absentLeader,
      custodianStart: "1",
      childPid: absentLeader,
      childStart: "1",
      bootId: seat.bootToken(),
    }) + "\\n", { mode: 0o600 });
    fs.readFileSync = function (file, ...args) {
      if (String(file) === \`/proc/\${P}/stat\`) return \`\${P} (x) y (z) S 1 \${absentLeader}\`;
      return origRead.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    const reaped = await seat.reapSeat(reapRoot, reapId, { graceMs: 200 });
    assert.equal(reaped.outcome, "reaped");

    const launchRoot = ${JSON.stringify(root)};
    const launchId = "c".repeat(32);
    const launchRecFile = seat.recordPath(launchRoot, launchId);
    let launchStatPolls = 0;
    let launchedCustodianPid = 0;
    process.env.COTAL_RUN = "probe-3152-real";
    fs.readFileSync = function (file, ...args) {
      const s = String(file);
      if (s === launchRecFile) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const m = /^\\/proc\\/(\\d+)\\/stat$/.exec(s);
      if (m && Number(m[1]) !== P && Number(m[1]) !== Q && Number(m[1]) !== process.pid) {
        launchedCustodianPid = Number(m[1]);
        launchStatPolls++;
        return \`\${launchedCustodianPid} \${Q} S\`;
      }
      return origRead.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    let launchErr = "";
    try {
      seat.launchSeat({
        root: launchRoot,
        id: launchId,
        name: "malformed-pidlive",
        spec: { command: process.execPath, args: ["-e", "process.exit(0)"], env: { PATH: process.env.PATH ?? "" } },
        cwd: process.cwd(),
      });
    } catch (e) {
      launchErr = e.message;
    } finally {
      delete process.env.COTAL_RUN;
      fs.readFileSync = origRead;
      syncBuiltinESMExports();
      if (launchedCustodianPid > 0) {
        try { process.kill(-launchedCustodianPid, "SIGKILL"); } catch {}
        try { process.kill(launchedCustodianPid, "SIGKILL"); } catch {}
        try {
          const rec = JSON.parse(fs.readFileSync(launchRecFile, "utf8"));
          if (rec.childPid > 0) try { process.kill(-rec.childPid, "SIGKILL"); } catch {}
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      fs.rmSync(path.dirname(launchRecFile), { recursive: true, force: true });
    }
    assert.equal(launchStatPolls, 1);
    assert.match(launchErr, /custodian exited before ready/);
  } finally {
    fs.readFileSync = origRead;
    syncBuiltinESMExports();
    fs.rmSync(reapRoot, { recursive: true, force: true });
  }

  const after = observe();
  assert.equal(after.token, expectedToken);
  assert.equal(after.verdict, "live");
  assert.equal(after.runMarker, "probe-3152-real");
} finally {
  try { real.kill("SIGKILL"); } catch {}
  try { decoy.kill("SIGKILL"); } catch {}
}
`,
    );
    const probeRun = spawnSync(process.execPath, [probeScript], {
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH ?? "", COTAL_RUN: "probe-3152-real" },
    });
    check(
      "stat parser: comm with ') ' parses cleanly and malformed stat lines never shift into a decoy pid",
      probeRun.status === 0 && probeRun.signal === null,
      { status: probeRun.status, signal: probeRun.signal, stderr: probeRun.stderr },
    );
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

function nativeSharedSkip(): string | undefined {
  if (!linuxSharedCustodyAvailable()) return "systemd user manager or systemd-run unavailable";
  if (!sharedCgroupAvailable()) return "unified cgroup v2 memory controller unavailable";
  if (typeof (process as typeof process & { execve?: unknown }).execve !== "function") return "Node process.execve unavailable";
  return undefined;
}

function removeNativeScratch(path: string): void {
  if (lstatSync(path).isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) removeNativeScratch(join(path, name));
  }
}

async function sharedAmbiguousLaunchCell(
  api: typeof import("../src/shared-managed.js"), lineage: string, base: string,
  host: ReturnType<typeof readSharedHost>, wire: Socket,
): Promise<void> {
  const id = seatId();
  const marker = join(base, "ambiguous-payload-ran");
  const liveHost = () => recordedProcess(host.pid, host.start, host.bootId) === "live";
  assert(liveHost() && !wire.destroyed && wire.writable);
  process.kill(host.pid, "SIGSTOP");
  try {
    assert(await until(() => liveHost() && state(host.pid) === "T", 2000), "fixture host did not stop");
    const bytesBefore = wire.bytesWritten;
    const started = performance.now();
    const attempt = api.launchManagedSharedSeat(lineage, { root: lineage, id, name: "ambiguous-launch", cwd: base,
      spec: { command: "/usr/bin/touch", args: [marker] } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ambiguous launch exceeded 27 seconds")), 27_000);
    });
    let sent: boolean;
    try {
      [sent] = await Promise.race([Promise.all([
        until(() => wire.bytesWritten > bytesBefore, 4000), assert.rejects(attempt, api.SharedLaunchHeld),
      ]), deadline]);
    } finally { clearTimeout(timer); }
    const elapsed = performance.now() - started;
    check("v2 launch sent without a reply is held, not returned as fallback", sent && !existsSync(marker) &&
      elapsed >= 17_500 && elapsed < 25_000, { sent, elapsed });
  } finally {
    if (liveHost()) process.kill(host.pid, "SIGCONT");
  }
}

async function sharedCustodyCell(): Promise<boolean> {
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const absent = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const { linuxSharedCustodyAvailable } = await import(${JSON.stringify(entry)}); process.exitCode = linuxSharedCustodyAvailable() ? 1 : 0;`], {
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/cotal-smoke-user-bus", XDG_RUNTIME_DIR: "/nonexistent/cotal-smoke-runtime" },
    timeout: 5000,
  });
  check("Linux without an answering user manager does not enable shared PTY custody", absent.status === 0);
  const skip = nativeSharedSkip();
  if (skip) {
    console.log(`  SKIP v2 shared PTY lifecycle: ${skip}`);
    return false;
  }
  const api: typeof import("../src/shared-managed.js") = await import(new URL("../dist/shared-managed.js", import.meta.url).href);
  const { SharedController }: typeof import("../src/shared-controller.js") = await import(new URL("../dist/shared-controller.js", import.meta.url).href);
  const base = makeSeatRoot("cotal-v2-lifecycle-");
  const lineage = join(base, `p-${seatId()}${seatId()}`);
  const id = seatId();
  type Handle = NonNullable<Awaited<ReturnType<typeof api.launchManagedSharedSeat>>>;
  const handles: Handle[] = [];
  let transport: Socket | undefined;
  const connectController = SharedController.prototype.connect;
  SharedController.prototype.connect = async function (this: InstanceType<typeof SharedController>) {
    await connectController.call(this);
    // Capture the authenticated client fd without replacing the real controller or protocol.
    transport = (this as unknown as { current?: { socket: Socket } }).current?.socket;
  };
  try {
    const handle = await api.launchManagedSharedSeat(lineage, { root: lineage, id, name: "reconnect", cwd: base,
      spec: { command: "/bin/sh", args: ["-c", "while IFS= read -r line; do printf 'reply:%s\\n' \"$line\"; done"] } });
    const roots = nativeGenerations(lineage);
    if (!handle && roots.length === 1 && existsSync(join(roots[0]!, "execution.json")) && !existsSync(join(roots[0]!, "host.json"))) {
      console.log("  SKIP v2 shared PTY lifecycle: user manager did not publish a host with delegated memory cgroups");
      return false;
    }
    assert(handle, "managed v2 launch did not admit the fixture");
    handles.push(handle);
    assert.equal(roots.length, 1);
    const generation = roots[0]!;
    const host = readSharedHost(generation);
    const child = handle.childIdentity;
    assert(child);
    const terminal = handle.attach();
    let output = "", exits = 0;
    terminal.onData(data => { output = (output + data.toString()).slice(-8192); });
    terminal.onExit(() => { exits++; });
    const reply = async (seat: Handle, marker: string, received: () => string): Promise<boolean> => {
      const deadline = Date.now() + 5000;
      do {
        assert.equal(await seat.write(`${marker}\n`), marker.length + 1);
        if (await until(() => received().includes(`reply:${marker}`), 350)) return true;
      } while (Date.now() < deadline);
      return false;
    };
    assert(await reply(handle, "before-drop", () => output), "original attachment never received its initial reply");
    const wire = transport;
    assert(wire && !wire.destroyed);
    const socket = sharedHostSocket(generation);
    assert(Buffer.byteLength(socket) > 108);
    renameSync(socket, `${socket}.away`);
    try {
      const dropped = new Promise<void>(resolve => wire.once("close", () => resolve()));
      wire.destroy();
      await dropped;
      await assert.rejects(api.reopenManagedSharedSeat(generation, id));
      check("v2 socket loss and refused reopen do not report a live seat exited", exits === 0 && handle.status() === "running");
    } finally { renameSync(`${socket}.away`, socket); }
    check("v2 reconnect receives fresh PTY output on the original attachment", await reply(handle, "on-original-attachment", () => output) && transport !== wire && exits === 0);
    const reopened = await api.reopenManagedSharedSeat(generation, id);
    handles.push(reopened);
    assert.deepEqual(reopened.childIdentity, child);
    assert.deepEqual(readSharedHost(generation), host);
    const newTerminal = reopened.attach();
    let reopenedOutput = "";
    newTerminal.onData(data => { reopenedOutput = (reopenedOutput + data.toString()).slice(-8192); });
    check("v2 reopen reaches the same live host and seat", reopened.status() === "running" &&
      await reply(reopened, "after-reopen", () => reopenedOutput));
    assert(transport && transport !== wire);
    await sharedAmbiguousLaunchCell(api, lineage, base, host, transport);
    assert.equal(recordedProcess(host.pid, host.start, host.bootId), "live");
    process.kill(host.pid, "SIGKILL");
    check("v2 host death ends the exact child and reports exit to the original attachment", await until(() =>
      recordedProcess(child.pid, child.start, child.boot) === "gone" && exits === 1 && reopened.status() === "exited", 10_000));
    return true;
  } finally {
    SharedController.prototype.connect = connectController;
    for (const handle of handles) handle.close();
    await cleanNativeSharedFixture(base, lineage);
  }
}

function nativeGenerations(lineage: string): string[] {
  return existsSync(lineage) ? readdirSync(lineage).filter(name => /^[a-f0-9]{64}$/.test(name)).map(name => join(lineage, name)) : [];
}

async function cleanNativeSharedFixture(base: string, lineage: string): Promise<void> {
  for (const root of nativeGenerations(lineage)) {
    const pin = join(root, "execution.json");
    if (!existsSync(pin)) continue;
    const { scope } = readPrivateRecord(pin) as { scope: unknown };
    assert(isSharedScope(scope));
    const group = `/sys/fs/cgroup/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/app.slice/${scope}`;
    spawnSync("/usr/bin/systemctl", ["--user", "--no-ask-password", "stop", "--", scope], { timeout: 8000, stdio: "ignore" });
    assert(await until(() => !existsSync(group), 10_000), `fixture unit still present: ${scope}`);
  }
  removeNativeScratch(base);
  rmSync(base, { recursive: true });
}

async function sharedOwnerDeathCell(): Promise<void> {
  const base = makeSeatRoot("cotal-v2-owner-");
  const lineage = join(base, `p-${seatId()}${seatId()}`);
  const entry = new URL("../dist/shared-managed.js", import.meta.url).href;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { existsSync, readFileSync } from 'node:fs';
    import { processStartToken } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    import { launchManagedSharedSeat } from ${JSON.stringify(entry)};
    const [base, lineage] = process.argv.slice(1);
    const marker = base + '/detached-pid';
    const payload = "const { spawn } = require('node:child_process'); " +
      "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' }); " +
      "child.once('spawn', () => require('node:fs').writeFileSync(process.argv[1], String(child.pid))); " +
      "setInterval(()=>{}, 1000);";
    const seats = [];
    for (const name of ['owner-death-one', 'owner-death-two']) {
      const handle = await launchManagedSharedSeat(lineage, { root: lineage, name, cwd: base,
        spec: { command: process.execPath,
          args: name === 'owner-death-one' ? ['-e', payload, marker] : ['-e', 'setInterval(()=>{}, 1000)'],
          env: { PATH: '/usr/bin:/bin' } } });
      assert(handle?.childIdentity, 'owner fixture did not launch a managed v2 seat');
      seats.push(handle.childIdentity);
    }
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const pid = Number(readFileSync(marker, 'utf8'));
    const start = processStartToken(pid);
    assert(start, 'detached fixture descendant did not start');
    process.send({ seats, detached: { pid, start, boot: seats[0].boot } });
    setInterval(() => {}, 1000);
  `, base, lineage], {
    cwd: base, stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
      HOME: base, XDG_CONFIG_HOME: join(base, "config"), TMPDIR: base, DO_NOT_TRACK: "1" },
  });
  const stopped = new Promise<void>(resolve => owner.once("close", () => resolve()));
  type Identity = { pid: number; start: string; boot: string };
  let report: { seats: Identity[]; detached: Identity } | undefined;
  owner.on("message", (message: typeof report) => { report = message; });
  try {
    assert(await until(() => report !== undefined || owner.exitCode !== null || owner.signalCode !== null, 30_000));
    assert(report?.seats.length === 2, "child owner did not report two seats");
    const { seats, detached } = report;
    const roots = nativeGenerations(lineage);
    assert.equal(roots.length, 1);
    const host = readSharedHost(roots[0]!);
    const ownerStart = processStartToken(owner.pid!);
    assert(ownerStart && recordedProcess(owner.pid!, ownerStart, host.bootId) === "live");
    assert.equal(recordedProcess(host.pid, host.start, host.bootId), "live");
    const rows = [...seats, detached];
    const membership = (pid: number) => readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
    assert(rows.every(child => recordedProcess(child.pid, child.start, child.boot) === "live"));
    assert(rows.every(child => membership(child.pid).includes(`/${host.scope}/seat-`)));
    assert.equal(membership(detached.pid), membership(seats[0]!.pid));
    assert.equal(processStatFields(detached.pid)?.[3], String(detached.pid), "descendant owns a separate session");
    const group = `/sys/fs/cgroup${dirname(membership(detached.pid).slice(3))}`;
    const listed = () => {
      const result = spawnSync("/usr/bin/systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", host.scope],
        { encoding: "utf8", timeout: 1000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert(existsSync(group) && listed().includes(host.scope), "the exact unit and its cgroup are live");
    assert(owner.kill("SIGKILL"));
    // No daemon, successor, or fixture stop runs during this wait. Only the host observes owner death.
    check("v2 owner-only SIGKILL ends the unit, host, both seats and detached descendant within 10 seconds", await until(() =>
      owner.signalCode === "SIGKILL" && recordedProcess(owner.pid!, ownerStart, host.bootId) === "gone" &&
      recordedProcess(host.pid, host.start, host.bootId) === "gone" &&
      rows.every(child => recordedProcess(child.pid, child.start, child.boot) === "gone") &&
      !existsSync(group) && !listed(), 10_000));
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await stopped;
    await cleanNativeSharedFixture(base, lineage);
  }
}

if (await sharedCustodyCell()) await sharedOwnerDeathCell();

console.log(`\nSEAT LIFECYCLE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
