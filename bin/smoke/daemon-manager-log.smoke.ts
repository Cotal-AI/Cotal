import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { globalConfigDir } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { saveIdpSession } from "@cotal-ai/auth";
import { createHostedManagers, daemonManagerRoot } from "../daemon/manager.js";

const fullDiskCell = "--hosted-log-full-disk";
const redactionSpace = "log-proof";
const space = "log-full-proof";

async function waitFor<T>(label: string, sample: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  do {
    const result = sample();
    if (result !== undefined) return result;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${label}`);
}

function fillDisk(root: string, fill: string): void {
  const { bfree, bsize } = statfsSync(root);
  writeFileSync(fill, Buffer.alloc(bfree * bsize, 1));
  assert.equal(statfsSync(root).bfree, 0);
}

async function proveFullDisk(home: string): Promise<void> {
  const root = daemonManagerRoot(space, home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  execFileSync("mount", ["-t", "tmpfs", "-o", "size=8m,mode=0700", "tmpfs", root]);
  try {
    await proveAppendRecovery(home, root);
  } finally {
    execFileSync("umount", [root]);
  }
}

async function proveAppendRecovery(home: string, root: string): Promise<void> {
  const log = join(root, "manager.log");
  const fill = join(root, "fill");
  const marker = (name: string) => join(home, name);
  const failed = "blocked append\n";
  const recovered = "recovered append\n";
  // End the initial line at a block boundary so the failed append cannot use an allocated tail.
  const blockSize = statfsSync(root).bsize;
  const lineSize = Math.min(blockSize, 4096);
  const before = "prior bytes".padEnd(lineSize - 1, "x") + "\n";
  const preload = `if (process.argv.includes('__machine-manager')) {
    const { existsSync } = await import('node:fs');
    const { setTimeout } = await import('node:timers/promises');
    process.once('disconnect', () => process.exit(0));
    const wait = async (path) => { while (!existsSync(path)) await setTimeout(25); };
    process.stdout.write(${JSON.stringify(before)}.repeat(${blockSize / lineSize}));
    await wait(${JSON.stringify(marker("write-full"))});
    process.stdout.write(${JSON.stringify(failed)});
    await wait(${JSON.stringify(marker("write-recovered"))});
    process.stdout.write(${JSON.stringify(recovered)});
    await wait(${JSON.stringify(marker("finish"))});
    process.send?.({ kind: 'manager-refusal', reason: 'log fixture complete', terminal: true, status: 403 }, () => process.exit(0));
  }`;
  process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(preload)}`);
  const failures: { code?: string; syscall?: string; directory: string }[] = [];
  const successes: string[] = [];
  const changes: (string | undefined)[] = [];
  const managers = createHostedManagers(home, undefined, undefined, () => {
    changes.push(managers.status(space).logError);
  }, (error: unknown, directory: string) => {
    const { code, syscall } = error as NodeJS.ErrnoException;
    failures.push({ code, syscall, directory });
  }, (directory: string) => { successes.push(directory); });
  const prematureExit = managers.start(space).then(view => {
    throw new Error(`hosted Manager stopped before the append proof: ${view.reason ?? view.state}`);
  });
  void prematureExit.catch(() => {});
  let pid: number | undefined;
  try {
    await Promise.race([prematureExit, waitFor("initial child log append", () => statSync(log, { throwIfNoEntry: false })?.size === blockSize ? true : undefined)]);
    const initial = managers.status(space);
    pid = initial.pid;
    assert.ok(pid);
    assert.equal(initial.logError, undefined);
    const prior = before.repeat(blockSize / lineSize);
    assert.equal(readFileSync(log, "utf8"), prior);

    changes.length = 0;
    fillDisk(root, fill);
    writeFileSync(marker("write-full"), "");
    await waitFor("child append failure", () => failures[0]);
    assert.deepEqual(failures, [{ code: "ENOSPC", syscall: "write", directory: root }]);
    const full = managers.status(space);
    assert.equal(full.pid, pid);
    assert.match(full.logError ?? "", /disk is full/i);
    assert.deepEqual(changes, [full.logError]);
    assert.deepEqual(successes, []);
    assert.equal(readFileSync(log, "utf8"), prior);

    rmSync(fill);
    assert.equal(managers.status(space).logError, full.logError, "freeing space alone does not prove an append");
    writeFileSync(marker("write-recovered"), "");
    await waitFor("recovered child log append", () => successes[0]);
    const after = managers.status(space);
    assert.equal(after.pid, pid);
    assert.equal(after.restarts, initial.restarts);
    assert.equal(after.logError, undefined);
    assert.deepEqual(changes, [full.logError, undefined]);
    assert.deepEqual(successes, [root]);
    assert.equal(failures.length, 1);
    assert.equal(readFileSync(log, "utf8"), prior + recovered);
  } finally {
    try {
      rmSync(fill, { force: true });
      writeFileSync(marker("finish"), "");
    } finally {
      await managers.close();
    }
    const stoppedPid = pid;
    if (stoppedPid !== undefined) assert.throws(() => process.kill(stoppedPid, 0), { code: "ESRCH" });
  }
  console.log("PASS genuine hosted child: ENOSPC, preserved log and same-child recovery");
}

function runFullDiskCell(home: string, entry: string): void {
  if (process.platform !== "linux") {
    console.log("SKIP hosted Manager log ENOSPC cell: Linux only");
    return;
  }
  const namespace = ["-Urm", "--pid", "--fork", "--kill-child"];
  const probe = spawnSync("unshare", [...namespace, "true"], { encoding: "utf8" });
  if (probe.status !== 0) {
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT" && !/Operation not permitted|Permission denied|Invalid argument|unrecognized option/i.test(probe.stderr ?? "")) {
      throw new Error(`could not probe mount namespace: ${probe.error ?? probe.stderr}`);
    }
    console.log("SKIP hosted Manager log ENOSPC cell: isolated Linux namespaces unavailable");
    return;
  }
  execFileSync("unshare", [...namespace, process.execPath, ...process.execArgv, entry, fullDiskCell, home], { stdio: "inherit", timeout: 100_000, killSignal: "SIGKILL" });
}

const testFullDisk = process.argv[2] === fullDiskCell;
const home = testFullDisk ? realpathSync(process.argv[3]!) : realpathSync(mkdtempSync(join(tmpdir(), "manager-log-")));
const oldConfig = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = join(home, "config");
const stamp = join(globalConfigDir(), "seed", "stamp.json");
mkdirSync(join(stamp, ".."), { recursive: true, mode: 0o700 });
writeFileSync(stamp, JSON.stringify({ generation: JSON.parse(readFileSync(resolve("bin/package.json"), "utf8")).version }), { mode: 0o600 });
const oldHome = process.env.COTAL_HOME;
const oldArgv = process.argv[1];
const oldExec = [...process.execArgv];
process.env.COTAL_HOME = home;
process.argv[1] = resolve("bin/cotal.ts");
// Both cells use the verified shipped CLI entry with a child-only diagnostic preload.
const jwt = "eyJhbGciOiJub25lIn0.c3ludGhldGlj.c2lnbmF0dXJl";
const payload = `if(process.argv.includes('__machine-manager')) {\nprocess.stdout.write('stdout '+${JSON.stringify(jwt.slice(0, 13))});\nsetTimeout(()=>{process.stdout.write(${JSON.stringify(jwt.slice(13))}+'\\n');process.stderr.write('✗ stderr '+${JSON.stringify(jwt.slice(0, 20))});},50);\nsetTimeout(()=>{process.stderr.write(${JSON.stringify(jwt.slice(20))}+'\\n');process.send?.({kind:'manager-refusal',reason:'IPC '+${JSON.stringify(jwt)},terminal:true,status:403});},100);\nawait new Promise(r=>setTimeout(r,180));\nfor(let i=0;i<140;i++) { if(!process.stdout.write('rotation '+ 'x'.repeat(8000)+'\\n')) await new Promise(r=>process.stdout.once('drain',r)); }\nprocess.stdout.write('oversized '+ 'x'.repeat(17000)+${JSON.stringify(jwt)}+'\\n');\nprocess.stdout.write('trailing '+${JSON.stringify(jwt)});\nawait new Promise(r=>setTimeout(r,50));process.exit(1);\n}`;
try {
  if (testFullDisk) await proveFullDisk(home);
  else {
    const idp = "http://127.0.0.1:1";
    // Seed in the host user namespace, where the registry can verify ancestor ownership.
    for (const name of [redactionSpace, space]) {
      recordMesh({ space: name, server: "nats://127.0.0.1:1", root: home, mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: { provider: "cotal", remote: true, idp: { url: idp, issuer: idp, audience: idp }, endpoints: { url: idp } } });
    }
    saveIdpSession(home, idp, { token: "synthetic-session", sub: "fixture", expiresAt: Math.floor(Date.now()/1000)+3600 });
    await proveRedaction();
    process.execArgv.splice(0, process.execArgv.length, ...oldExec);
    runFullDiskCell(home, oldArgv!);
  }
} finally {
  process.argv[1] = oldArgv;
  process.execArgv.splice(0, process.execArgv.length, ...oldExec);
  if (oldHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = oldHome;
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
  if (!testFullDisk) rmSync(home, { recursive: true, force: true });
}

async function proveRedaction(): Promise<void> {
  process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(payload)}`);
  const managers = createHostedManagers(home);
  try {
    const status = await managers.start(redactionSpace);
    const root = daemonManagerRoot(redactionSpace, home);
    const log = readFileSync(join(root, "manager.log"), "utf8");
    const rotated = readFileSync(join(root, "manager.log.1"), "utf8");
    assert.match(rotated, /stdout/);
    assert.match(rotated, /stderr/);
    assert.match(log, /oversized Manager log line omitted/);
    assert.match(log, /trailing <redacted>/);
    for (const name of ["manager.log", "manager.log.1"]) {
      const st = statSync(join(root, name));
      assert.equal(st.mode & 0o777, 0o600);
      assert.ok(st.size <= 1024 * 1024);
    }
    assert.match(String(status.reason), /IPC <redacted>/);
    assert.equal(statSync(join(root, "manager.log")).mode & 0o777, 0o600);
    const disk = readdirSync(join(home, "daemon"), { recursive: true }).map(String).filter(p => p.endsWith(".json") || p.endsWith(".log") || p.endsWith(".log.1")).map(p => readFileSync(join(home, "daemon", p), "utf8")).join("\n");
    assert.equal((disk + JSON.stringify(status) + JSON.stringify(managers.status(redactionSpace))).includes(jwt), false, "raw split stdout/stderr JWT or IPC JWT escaped to disk/status");
    console.log("PASS genuine hosted child: split stdout/stderr and IPC JWT private and redacted");
  } finally {
    await managers.close();
  }
}
