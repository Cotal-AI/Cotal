/**
 * Callout replicas on a real user-auth broker: the full auth service and `--callout-only` replicas,
 * each its own daemon process in the one `cotal-auth-callout` queue group. Load comes from the
 * callout-load harness's `load` child; the broker's own per-subscription counters say which
 * process answered each callout.
 *
 * Cells: a replica binds no listening socket and leaves the primary's `auth-service.json` as it
 * was; HTTP and service-endpoint flags refuse with `--callout-only`; the primary and two replicas
 * share the callouts; killing a replica mid-load loses at most its in-flight connects and none
 * after; a replica whose store connection is cut exits non-zero and the primary alone serves
 * every connect; a primary restarted, then killed, under load loses at most its own in-flight
 * connects while the replicas answer; the replicas alone serve every connect and deny an actor
 * revoked in the live ledger.
 *
 * Run: pnpm smoke:callout-replica [--rate 20] [--seconds 6]   (nats-server on PATH, or NATS_SERVER_BIN)
 */
import assert from "node:assert/strict";
import { SMOKE_BROKER_TOKEN, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.argv[2] === "__daemon-auth-service") {
  await import("@cotal-ai/auth");
  const { parseCommandArgs, registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const command = registry.all<Command>("command").find((c) => c.name === process.argv[2])!;
  await command.run(parseCommandArgs(command, process.argv.slice(3)));
} else {
  const { spawn } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  type ChildProcess = import("node:child_process").ChildProcess;
  const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}callout-replica-`));
  const root = join(home, "workspace");
  mkdirSync(root);
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") && key !== "COTAL_TELEMETRY") delete process.env[key];
  process.env.COTAL_HOME = home;
  const { connect, credsAuthenticator, tokenAuthenticator } = await import("@nats-io/transport-node");
  const { encodeUser, fmtCreds } = await import("@nats-io/jwt");
  const { createUser, fromPublic, fromSeed } = await import("@nats-io/nkeys");
  const { createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams } = await import("@cotal-ai/core");
  const { authDir, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantManagedActor, loadAuthServiceInfo, loadCalloutAuth, newActorToken } = await import("@cotal-ai/auth");
  const { revokeManagedActorIf } = await import("../src/ledger.js");
  const { saveIdpSession } = await import("../src/login.js");
  const { pickFreePort } = await import("./_free-port.js");

  const argv = process.argv.slice(2);
  const num = (name: string, dflt: number): number => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? Number(argv[i + 1]) : dflt;
    if (!Number.isFinite(v) || v <= 0) throw new Error(`callout-replica: --${name} must be a positive number`);
    return v;
  };
  const RATE = num("rate", 20), SECONDS = num("seconds", 6), USERS = num("users", 16);
  /** The callout's own concurrency bound (`maxInFlight` in callout.ts): what one killed member can hold. */
  const MAX_IN_FLIGHT = 32;
  const NATS_BIN = process.env.NATS_SERVER_BIN ?? "nats-server";
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(100); }
    throw new Error(message);
  };
  let passed = 0;
  const check = (name: string, condition: unknown, detail?: unknown) => {
    assert(condition, `${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
    passed++;
    console.log(`  ✓ ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };

  // ---- /proc: which sockets a process holds -------------------------------------------------------
  const socketInodes = (pid: number): Set<string> => {
    const inodes = new Set<string>();
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) inodes.add(m[1]); }
      catch { /* an fd closed while listing */ }
    }
    return inodes;
  };
  const rows = (pid: number, table: string) => readFileSync(`/proc/${pid}/net/${table}`, "utf8").split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 6);
  /** Every listening TCP or Unix socket the process holds. */
  const listeners = (pid: number): string[] => {
    const inodes = socketInodes(pid);
    const tcp = ["tcp", "tcp6"].flatMap((t) => rows(pid, t).filter((c) => c[3] === "0A" && inodes.has(c[9])).map((c) => `${t} ${c[1]}`));
    const unix = rows(pid, "unix").filter((c) => (parseInt(c[3], 16) & 0x10000) !== 0 && inodes.has(c[6])).map((c) => `unix ${c[7] ?? "(unnamed)"}`);
    return [...tcp, ...unix];
  };
  /** The local TCP ports of the process's sockets: the client ports the broker's CONNZ reports. */
  const clientPorts = (pid: number): Set<number> => {
    const inodes = socketInodes(pid);
    return new Set(["tcp", "tcp6"].flatMap((t) => rows(pid, t).filter((c) => inodes.has(c[9])).map((c) => parseInt(c[1].split(":").at(-1)!, 16))));
  };

  const space = `replica-${process.pid}`;
  const port = await pickFreePort();
  const monPort = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const stateDir = userAuthStateDir(root, space);
  const store = workspaceSecretStore(root);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];
  childEnv.COTAL_HOME = home;
  childEnv.COTAL_TELEMETRY = "off";
  const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"keys":[]}'); });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;
  let broker: ChildProcess | undefined;
  let releaseBroker: (() => void) | undefined;
  const daemons = new Map<string, { child: ChildProcess; out: string[] }>();
  const loads = new Set<ChildProcess>();

  /** Start one auth-service daemon (the primary, or a replica with `--callout-only`). */
  const startDaemon = (label: string, extra: string[] = []) => {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "__daemon-auth-service", "--space", space, "--server", servers, ...extra],
      { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const out: string[] = [];
    child.stdout!.setEncoding("utf8").on("data", (d: string) => out.push(d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => out.push(d));
    daemons.set(label, { child, out });
    return { child, out };
  };
  const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code));
  });
  const startReplica = async (label: string) => {
    const r = startDaemon(label, ["--callout-only"]);
    await until(() => r.out.join("").includes("✓ auth callout replica up") || r.child.exitCode !== null, `${label} did not come up`);
    if (r.child.exitCode !== null) throw new Error(`${label} exited ${r.child.exitCode}: ${r.out.join("")}`);
    return r;
  };

  // ---- callouts per process, from the broker's subscription counters --------------------------------
  const calloutsByPort = async (): Promise<Map<number, number>> => {
    const body = await (await fetch(`http://127.0.0.1:${monPort}/connz?subs=detail&limit=4096`)).json() as {
      connections: Array<{ port: number; subscriptions_list_detail?: Array<{ subject: string; qgroup?: string; msgs: number }> }>;
    };
    const counts = new Map<number, number>();
    for (const c of body.connections)
      for (const s of c.subscriptions_list_detail ?? [])
        if (s.subject === "$SYS.REQ.USER.AUTH" && s.qgroup === "cotal-auth-callout") counts.set(c.port, (counts.get(c.port) ?? 0) + s.msgs);
    return counts;
  };
  const calloutsByProcess = async (labels: string[]): Promise<Record<string, number>> => {
    const counts = await calloutsByPort();
    return Object.fromEntries(labels.map((label) => {
      const ports = clientPorts(daemons.get(label)!.child.pid!);
      return [label, [...counts].filter(([p]) => ports.has(p)).reduce((a, [, n]) => a + n, 0)];
    }));
  };
  const delta = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - (a[k] ?? 0)]));
  /** utime + stime in ms (Linux, 100 ticks per second). */
  const cpuMs = (pid: number): number => {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return (Number(f[11]) + Number(f[12])) * 10;
  };
  const live = (label: string) => daemons.get(label)!.child.exitCode === null && daemons.get(label)!.child.signalCode === null;

  // ---- load, from the callout-load harness's own child -------------------------------------------------
  interface LoadResult { attempts: number; ok: number; byReason: Record<string, number>; latencies: number[] }
  const harness = join(import.meta.dirname, "callout-load.smoke.ts");
  let bearers: string[] = [];
  let sentinelCreds = "";
  /** One generator process: its connect rate, not the number of generators, is what this suite varies. */
  const load = async (seconds: number): Promise<LoadResult & { p50: number; p99: number }> => {
    const results = await Promise.all([new Promise<LoadResult>((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, harness, "load"], { stdio: ["pipe", "pipe", "inherit"], env: childEnv });
      loads.add(child);
      let out = "";
      child.stdout!.setEncoding("utf8").on("data", (d: string) => { out += d; });
      child.on("error", reject);
      // `close`, not `exit`: only `close` guarantees the child's stdout was read to its end.
      child.on("close", (code) => {
        loads.delete(child);
        const line = out.split("\n").find((l) => l.startsWith("RESULT "));
        if (!line) return reject(new Error(`load child exited ${code} with no result`));
        resolve(JSON.parse(line.slice("RESULT ".length)) as LoadResult);
      });
      child.stdin!.end(JSON.stringify({ mode: "churn", servers, sentinelCreds, bearers, connectTimeoutMs: 10_000, ratePerSec: RATE, seconds }));
    })]);
    const latencies = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
    const pct = (p: number) => latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]) : NaN;
    const byReason: Record<string, number> = {};
    for (const r of results) for (const [k, v] of Object.entries(r.byReason)) byReason[k] = (byReason[k] ?? 0) + v;
    return { attempts: results.reduce((a, r) => a + r.attempts, 0), ok: results.reduce((a, r) => a + r.ok, 0), byReason, latencies, p50: pct(50), p99: pct(99) };
  };
  /** One load window. `also` names a process that starts during it, counted from its first callout. */
  const phase = async (name: string, labels: string[], seconds = SECONDS, during?: () => Promise<void>, also: string[] = []) => {
    const before = await calloutsByProcess(labels);
    const cpu0 = Object.fromEntries(labels.map((l) => [l, cpuMs(daemons.get(l)!.child.pid!)]));
    const t0 = performance.now();
    const [result] = await Promise.all([load(seconds), during?.()]);
    const elapsed = (performance.now() - t0) / 1000;
    const survivors = [...labels, ...also].filter((l) => daemons.has(l) && live(l));
    const counts = delta(before, await calloutsByProcess(survivors));
    const cpu = Object.fromEntries(survivors.map((l) => {
      const ms = cpuMs(daemons.get(l)!.child.pid!) - (cpu0[l] ?? 0);
      return [l, { cores: Number((ms / 1000 / elapsed).toFixed(2)), msPerCallout: counts[l] ? Math.round(ms / counts[l]) : null }];
    }));
    console.log(`  phase ${JSON.stringify({ phase: name, offered: result.attempts, ok: result.ok, refused: result.byReason, p50ms: result.p50, p99ms: result.p99, callouts: counts, cpu })}`);
    return { result, counts };
  };

  let complete = false;
  console.log(`callout-replica: ${RATE} connects/s, ${SECONDS} s per phase, ${USERS} actors`);
  try {
    // ---- a provisioned user-auth space, as `cotal up --user-auth` leaves it ------------------------------
    const auth = await createSpaceAuth(space);
    saveSpaceAuth(authDir(root), auth);
    const prepared = await cotalAuthProvider.prepareServer({ space, operatorSeed: auth.operator.seed,
      account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store, dir: stateDir, idpUrl });
    const conf = join(home, "server.conf");
    writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(home, "js"), extraAccounts: prepared.extraAccounts })
      + `\nhttp: 127.0.0.1:${monPort}\n`);
    broker = spawn(NATS_BIN, ["-c", conf], { stdio: "ignore" });
    releaseBroker = teardownOnSignal(broker, home);
    await until(async () => broker!.exitCode === null && await isReachable(servers), "the user-auth broker did not bind");
    await setupSpaceStreams({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    saveIdpSession(home, idpUrl, { token: "replica-fixture-session", sub: "replica-fixture-human", expiresAt: Math.floor(Date.now() / 1000) + 600 });
    const owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space });
    const actors = Array.from({ length: USERS }, (_, i) => {
      const { actorToken, tokenHash } = newActorToken();
      const lifecycleUid = mintLifecycleUid();
      grantManagedActor(stateDir, { custody: { kind: "foreground" }, owner, actor: `load_${i}`, scope: [], allowSubscribe: ["general"], allowPublish: ["general"], tokenHash, lifecycleUid });
      return { actor: `load_${i}`, actorToken, lifecycleUid };
    });
    sentinelCreds = (await loadCalloutAuth(store, space))!.sentinelCreds;

    // ---- the primary, and real bearers from its exchange ----------------------------------------------
    const primary = startDaemon("primary");
    await until(() => loadAuthServiceInfo(stateDir)?.pid === primary.child.pid, `the primary did not write its auth-service.json: ${primary.out.join("")}`);
    const info = loadAuthServiceInfo(stateDir)!;
    bearers = await Promise.all(actors.map(async ({ actor, actorToken }) => {
      const res = await fetch(`${info.url}/exchange`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` }, body: JSON.stringify({ owner, actor, actorToken }) });
      const body = await res.json() as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(`exchange for ${actor} refused: ${body.error ?? res.status}`);
      return body.token;
    }));
    const recordFile = join(stateDir, "auth-service.json");
    const record = readFileSync(recordFile);
    const stateFiles = readdirSync(stateDir).sort();
    check("the primary listens (the listener check sees a real listener)", listeners(primary.child.pid!).length > 0);

    // ---- a replica's footprint ---------------------------------------------------------------------------
    const r1 = await startReplica("replica1");
    check("a replica binds no listening socket", listeners(r1.child.pid!).length === 0, listeners(r1.child.pid!));
    check("a replica leaves the primary's auth-service.json byte-identical", readFileSync(recordFile).equals(record) && loadAuthServiceInfo(stateDir)!.pid === primary.child.pid);
    check("a replica writes no file into the state dir", JSON.stringify(readdirSync(stateDir).sort()) === JSON.stringify(stateFiles), readdirSync(stateDir));
    for (const flag of [["--port", "0"], ["--service-endpoints"], ["--exchange-public-port", "0"]]) {
      const refused = startDaemon(`refused${flag[0]}`, ["--callout-only", ...flag]);
      const code = await exited(refused.child);
      check(`--callout-only with ${flag[0]} refuses before connecting`, code !== 0 && refused.out.join("").includes(`drop ${flag[0]}`), refused.out.join("").trim().slice(0, 160));
    }

    // ---- three members share the callouts ----------------------------------------------------------------
    await startReplica("replica2");
    const members = ["primary", "replica1", "replica2"];
    const shared = await phase("primary + 2 replicas", members);
    const total = Object.values(shared.counts).reduce((a, n) => a + n, 0);
    check("every connect succeeds with the primary and two replicas", shared.result.ok === shared.result.attempts, shared.result.byReason);
    check("each of the three processes answers a share of the callouts", members.every((m) => shared.counts[m] >= total * 0.2), shared.counts);

    // ---- one replica killed mid-load -----------------------------------------------------------------------
    const killed = await phase("replica2 killed mid-load", members, SECONDS, async () => {
      await wait((SECONDS * 1000) / 2);
      await killAndAwaitExit(daemons.get("replica2")!.child, "SIGKILL");
    });
    const lost = killed.result.attempts - killed.result.ok;
    check("killing a replica mid-load loses at most its in-flight connects", lost <= MAX_IN_FLIGHT, { lost, refused: killed.result.byReason });
    const after = await phase("primary + replica1 after the kill", ["primary", "replica1"]);
    check("after the kill every connect succeeds on the remaining two", after.result.ok === after.result.attempts && after.counts.primary > 0 && after.counts.replica1 > 0, after.result.byReason);

    // ---- a replica that loses its store connection exits non-zero ------------------------------------------
    const sysUser = createUser();
    const enc = (s: string) => new TextEncoder().encode(s);
    const sysJwt = await encodeUser("replica-kick", sysUser, fromPublic(auth.sys.pub), { pub: { allow: ["$SYS.REQ.SERVER.*.KICK"] }, sub: { allow: ["_INBOX.>"] } }, { signer: fromSeed(enc(auth.sys.signingSeed!)) });
    const sysNc = await connect({ servers, authenticator: credsAuthenticator(fmtCreds(sysJwt, sysUser)) });
    try {
      const connz = await (await fetch(`http://127.0.0.1:${monPort}/connz?limit=4096`)).json() as { server_id: string; connections: Array<{ cid: number; port: number; name?: string }> };
      const r1Ports = clientPorts(r1.child.pid!);
      const storeConn = connz.connections.find((c) => r1Ports.has(c.port) && c.name === `cotal:auth-replica-store:${space}`);
      check("the replica's store connection is visible by name", storeConn !== undefined);
      await sysNc.request(`$SYS.REQ.SERVER.${connz.server_id}.KICK`, enc(JSON.stringify({ cid: storeConn!.cid })), { timeout: 5000 });
    } finally {
      await sysNc.close();
    }
    const kickedCode = await Promise.race([exited(r1.child), wait(15_000).then(() => "still running")]);
    check("a replica whose store connection is cut exits non-zero", kickedCode === 1 && r1.out.join("").includes("lost its store connection"), { kickedCode });
    await until(async () => [...(await calloutsByPort()).keys()].length === 1, "the cut replica's callout subscription is still on the broker", 10_000);
    const alone = await phase("primary alone", ["primary"]);
    check("the primary alone answers every connect", alone.result.ok === alone.result.attempts, alone.result.byReason);
    check("the primary's auth-service.json is unchanged after replicas came and went", readFileSync(recordFile).equals(record));

    // ---- the primary restarts, then crashes, under load; the replicas answer throughout --------------------
    await startReplica("replica3");
    await startReplica("replica4");
    let restarted: ReturnType<typeof startDaemon> | undefined;
    const restart = await phase("primary restarted mid-load", ["primary", "replica3", "replica4"], SECONDS, async () => {
      await wait((SECONDS * 1000) / 4);
      primary.child.kill("SIGTERM");
      await exited(primary.child);
      restarted = startDaemon("primary2");
      await until(() => loadAuthServiceInfo(stateDir)?.pid === restarted!.child.pid, `the restarted primary did not write its auth-service.json: ${restarted!.out.join("")}`);
    }, ["primary2"]);
    check("the old primary stops cleanly on SIGTERM", primary.child.exitCode === 0);
    check("a primary restart under load loses at most its in-flight connects", restart.result.attempts - restart.result.ok <= MAX_IN_FLIGHT, { lost: restart.result.attempts - restart.result.ok, refused: restart.result.byReason });
    check("the restarted primary's auth-service.json names it, and no replica wrote one", loadAuthServiceInfo(stateDir)!.pid === restarted!.child.pid && JSON.stringify(readdirSync(stateDir).sort()) === JSON.stringify(stateFiles));
    const crash = await phase("primary killed mid-load", ["primary2", "replica3", "replica4"], SECONDS, async () => {
      await wait((SECONDS * 1000) / 2);
      await killAndAwaitExit(restarted!.child, "SIGKILL");
    });
    check("a primary crash under load loses at most its in-flight connects", crash.result.attempts - crash.result.ok <= MAX_IN_FLIGHT, { lost: crash.result.attempts - crash.result.ok, refused: crash.result.byReason });
    const replicasOnly = await phase("replicas alone", ["replica3", "replica4"]);
    check("with no primary running the replicas answer every connect", replicasOnly.result.ok === replicasOnly.result.attempts && replicasOnly.counts.replica3 > 0 && replicasOnly.counts.replica4 > 0, replicasOnly.result.byReason);

    // ---- live ledger reads -----------------------------------------------------------------------------------
    const tryConnect = async (bearer: string): Promise<"connected" | "denied"> => {
      const nonce = `ibx${newIdentity().id.replace(/[^A-Za-z0-9]/g, "")}`;
      try {
        const nc = await connect({ servers, authenticator: [credsAuthenticator(enc(sentinelCreds)), tokenAuthenticator(bearer)], name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: 10_000, maxReconnectAttempts: 0 });
        await nc.close();
        return "connected";
      } catch (e) {
        if (/authorization/i.test(e instanceof Error ? e.message : String(e))) return "denied";
        throw e;
      }
    };
    revokeManagedActorIf(stateDir, owner, actors[1].actor, { lifecycleUid: actors[1].lifecycleUid, custody: { kind: "foreground" } });
    check("the replicas deny an actor revoked in the live ledger", (await tryConnect(bearers[1])) === "denied" && (await tryConnect(bearers[1])) === "denied");
    check("and still admit the actors that remain granted", (await tryConnect(bearers[0])) === "connected");
    for (const label of ["replica3", "replica4"]) {
      const { child } = daemons.get(label)!;
      child.kill("SIGTERM");
      check(`${label} stops cleanly on SIGTERM`, (await exited(child)) === 0);
    }

    complete = true;
    emitSentinel({ passed, failed: 0 });
  } finally {
    for (const child of loads) child.kill("SIGKILL");
    for (const { child } of daemons.values()) if (child.exitCode === null && child.signalCode === null) await killAndAwaitExit(child, "SIGTERM");
    if (broker) await killAndAwaitExit(broker, "SIGKILL");
    releaseBroker?.();
    idp.close();
    rmSync(home, { recursive: true, force: true });
    if (!complete) process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
