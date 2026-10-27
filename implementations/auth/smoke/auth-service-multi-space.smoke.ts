/**
 * One auth service process serving several spaces as their full primary, on a real user-auth broker.
 *
 * The host (`cotal auth-service --spaces <manifest>`) runs as its own daemon process holding one full
 * auth service lane per space: the callout, the authority plane, the loopback exchange and JWKS, and
 * the public face the space's manifest entry names. Every space is a real provisioned user-auth space
 * with its own auth account, data account and signing keys under one broker operator.
 *
 * Cells: the flag and manifest refusals; a startup with one space whose port is taken and one space
 * that was never provisioned serves the other two, names both, and opens the first once its port is
 * free; each space's loopback and public exchange and JWKS answer from that space's own keys; a bearer
 * from one space's exchange connects only into that space's data account, and the other space's
 * callout and exchange refuse it; every connection a lane opens is in its own space's accounts, read
 * from the broker's `/connz`; a changed entry moves that space's public face; removing a space from
 * the full host's and a callout host's manifests is acknowledged in each `<manifest>.applied` only
 * after that space has no listener, discovery file, connection or callout responder left, while the
 * other space keeps exchanging and connecting; SIGTERM closes every lane.
 *
 * `--measure` instead reports RSS in MiB per space for 1, 4 and 16 lanes in one process against 16
 * single-space processes, all idle.
 *
 * Run: pnpm smoke:auth-service-multi-space [--measure]   (nats-server on PATH, or NATS_SERVER_BIN)
 */
import assert from "node:assert/strict";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.argv[2] === "__daemon-auth-service") {
  await import("@cotal-ai/auth");
  const { parseCommandArgs, registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const command = registry.all<Command>("command").find((c) => c.name === process.argv[2])!;
  await command.run(parseCommandArgs(command, process.argv.slice(3)));
} else {
  const { spawn } = await import("node:child_process");
  const { createHash, randomUUID } = await import("node:crypto");
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { createServer: createTcpServer } = await import("node:net");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  type ChildProcess = import("node:child_process").ChildProcess;

  const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}authsvc-ms-`));
  const root = join(home, "workspace");
  mkdirSync(root);
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") && key !== "COTAL_TELEMETRY") delete process.env[key];
  process.env.COTAL_HOME = home;

  const { connect, credsAuthenticator, tokenAuthenticator } = await import("@nats-io/transport-node");
  const { createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams } = await import("@cotal-ai/core");
  const { authDir, parseSpaceManifest, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantManagedActor, loadAuthServiceInfo, loadCalloutAuth, newActorToken } = await import("@cotal-ai/auth");
  const { authHostSettings } = await import("../src/service.js");
  const { saveIdpSession } = await import("../src/login.js");
  const { pickFreePort } = await import("./_free-port.js");

  const MEASURE = process.argv.slice(2).includes("--measure");
  const NATS_BIN = process.env.NATS_SERVER_BIN ?? "nats-server";
  const MEASURE_LANES = [1, 4, 16];
  const SPACE_COUNT = MEASURE ? Math.max(...MEASURE_LANES) : 3;
  /** Every cell below that runs. A suite that skipped one fails here rather than passing short. */
  const EXPECTED_CHECKS = 49;

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 90_000) => {
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
  /** Resident set size in MiB. */
  const rssMb = (pid: number): number => {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (!m) throw new Error(`no VmRSS for pid ${pid}`);
    return Number(m[1]) / 1024;
  };

  const port = await pickFreePort();
  const monPort = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const store = workspaceSecretStore(root);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];
  childEnv.COTAL_HOME = home;
  childEnv.COTAL_TELEMETRY = "off";
  childEnv.DO_NOT_TRACK = "1";

  const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"keys":[]}'); });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;

  let broker: ChildProcess | undefined;
  let releaseBroker: (() => void) | undefined;
  const daemons = new Map<string, { child: ChildProcess; out: string[] }>();
  const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code));
  });
  const startDaemon = (label: string, args: string[]) => {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "__daemon-auth-service", "--server", servers, ...args],
      { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const out: string[] = [];
    child.stdout!.setEncoding("utf8").on("data", (d: string) => out.push(d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => out.push(d));
    daemons.set(label, { child, out });
    return { child, out, text: () => out.join("") };
  };
  const stopDaemon = async (label: string) => {
    const d = daemons.get(label);
    if (!d || d.child.exitCode !== null) return;
    await killAndAwaitExit(d.child, "SIGTERM");
  };

  interface Connz { connections: Array<{ cid: number; name?: string; account?: string; subscriptions_list_detail?: Array<{ subject: string; qgroup?: string }> }> }
  const connz = async (): Promise<Connz> =>
    await (await fetch(`http://127.0.0.1:${monPort}/connz?subs=detail&auth=1&limit=8192`)).json() as Connz;
  /** The connections a lane names for `space`: every lane connection's name ends in `:<space>`. */
  const laneConnections = async (space: string) =>
    (await connz()).connections.filter((c) => c.name?.startsWith("cotal:") && c.name.endsWith(`:${space}`));
  /** Members of `space`'s callout queue group, by connection name. */
  const calloutMembers = async (space: string) =>
    (await laneConnections(space)).filter((c) => (c.subscriptions_list_detail ?? []).some((s) => s.subject === "$SYS.REQ.USER.AUTH" && s.qgroup === "cotal-auth-callout")).map((c) => c.name!);

  /** One provisioned space and what a client needs to reach it. */
  interface Space { name: string; dataAccountPub: string; sentinelCreds: string; owner: string; actors: Array<{ actor: string; actorToken: string }> }

  const exchange = async (url: string, space: Space, actor: { actor: string; actorToken: string }, cap?: string) => {
    const res = await fetch(`${url}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cap !== undefined ? { authorization: `Bearer ${cap}` } : {}) },
      body: JSON.stringify({ owner: space.owner, actor: actor.actor, actorToken: actor.actorToken }),
    });
    return { status: res.status, body: await res.json() as { token?: string; error?: string } };
  };
  const getJson = async (url: string) => { const res = await fetch(url); return { status: res.status, body: await res.json() as Record<string, unknown> }; };
  const refused = async (url: string): Promise<boolean> => {
    try { await fetch(url, { signal: AbortSignal.timeout(3000) }); return false; } catch { return true; }
  };
  /** One connect through the real callout. Resolves the broker's view of the connection. */
  const connectOnce = async (space: Space, bearer: string) => {
    const nonce = `ibx${randomUUID().replace(/-/g, "")}`;
    const nc = await connect({
      servers, authenticator: [credsAuthenticator(new TextEncoder().encode(space.sentinelCreds)), tokenAuthenticator(bearer)],
      name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: 10_000, maxReconnectAttempts: 0,
    });
    const seen = (await connz()).connections.find((c) => c.name === nonce);
    await nc.close();
    if (!seen) throw new Error(`the broker reported no connection named ${nonce}`);
    return seen;
  };
  const connectRefusal = async (space: Space, bearer: string): Promise<string | undefined> => {
    try { await connectOnce(space, bearer); return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };

  /** Replace a manifest the way a provisioning backend does: a sibling renamed into place. Returns
   *  the SHA-256 of the bytes written, which the host's acknowledgment names. */
  const writeManifest = (path: string, doc: unknown): string => {
    const text = JSON.stringify(doc, null, 2);
    const tmp = `${path}.${randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return createHash("sha256").update(text).digest("hex");
  };
  const applied = (path: string): string | undefined => {
    try { return (JSON.parse(readFileSync(`${path}.applied`, "utf8")) as { sha256?: string }).sha256; } catch { return undefined; }
  };

  let complete = false;
  console.log(`auth-service-multi-space: ${SPACE_COUNT} space(s)${MEASURE ? " [measure]" : ""}`);
  try {
    // ---- one broker operator, N provisioned user-auth spaces ------------------------------------
    const brokerAuth = await createBrokerAuth("authsvc-ms");
    const names = Array.from({ length: SPACE_COUNT }, (_, i) => `ms${i}-${process.pid}`);
    const accounts = await Promise.all(names.map((n) => createSpaceAccountAuth(brokerAuth, n)));
    const spaceAuths = accounts.map((a) => ({ ...brokerAuth, ...a }));
    const extraAccounts: Array<{ pub: string; jwt: string }> = [];
    for (const auth of spaceAuths) {
      saveSpaceAuth(authDir(root), auth);
      const prepared = await cotalAuthProvider.prepareServer({
        space: auth.space, operatorSeed: brokerAuth.operator.seed,
        account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
        store, dir: userAuthStateDir(root, auth.space), idpUrl,
      });
      extraAccounts.push(...prepared.extraAccounts);
    }
    const conf = join(home, "server.conf");
    writeFileSync(conf, serverConfig(brokerAuth, accounts, { transport: { kind: "plaintext" }, port, storeDir: join(home, "js"), extraAccounts })
      + `\nhttp: 127.0.0.1:${monPort}\n`);
    broker = spawn(NATS_BIN, ["-c", conf], { stdio: "ignore" });
    releaseBroker = teardownOnSignal(broker, home);
    await until(async () => broker!.exitCode === null && await isReachable(servers), "the user-auth broker did not bind");
    saveIdpSession(home, idpUrl, { token: "ms-fixture-session", sub: "ms-fixture-human", expiresAt: Math.floor(Date.now() / 1000) + 3600 });

    const spaces: Space[] = [];
    for (const auth of spaceAuths) {
      const space = auth.space;
      const stateDir = userAuthStateDir(root, space);
      await setupSpaceStreams({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner") });
      const owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space });
      const actors = Array.from({ length: 2 }, (_, i) => {
        const { actorToken, tokenHash } = newActorToken();
        grantManagedActor(stateDir, { custody: { kind: "foreground" }, owner, actor: `agent_${i}`, scope: [], allowSubscribe: ["general"], allowPublish: ["general"], tokenHash, lifecycleUid: mintLifecycleUid() });
        return { actor: `agent_${i}`, actorToken };
      });
      spaces.push({ name: space, dataAccountPub: auth.account.pub, sentinelCreds: (await loadCalloutAuth(store, space))!.sentinelCreds, owner, actors });
    }
    console.log(`  provisioned ${spaces.length} space(s)`);

    if (MEASURE) {
      const settle = () => wait(5000);
      const table: Array<{ shape: string; procs: number; lanes: number; rssMb: number; loadavg: number }> = [];
      const record = (shape: string, pids: number[], lanes: number) => {
        const rss = pids.reduce((a, p) => a + rssMb(p), 0);
        table.push({ shape, procs: pids.length, lanes, rssMb: Number(rss.toFixed(1)), loadavg: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) });
        console.log(`  measured ${JSON.stringify(table.at(-1))}`);
      };
      const manifest = join(home, "measure.json");
      for (const lanes of MEASURE_LANES) {
        writeManifest(manifest, { version: 2, spaces: spaces.slice(0, lanes).map((s) => ({ space: s.name })) });
        const label = `host:${lanes}`;
        const host = startDaemon(label, ["--spaces", manifest]);
        await until(() => host.text().includes("✓ auth service host up") || host.child.exitCode !== null, `the ${lanes}-lane host did not come up: ${host.text()}`, 300_000);
        if (!host.text().includes(`(${lanes} of ${lanes} space(s) serving`)) throw new Error(`the ${lanes}-lane host did not serve every space: ${host.text().slice(-600)}`);
        await settle();
        record(`${lanes} lane(s), one process`, [host.child.pid!], lanes);
        await stopDaemon(label);
      }
      const labels: string[] = [];
      for (const s of spaces) {
        const label = `single:${s.name}`;
        const d = startDaemon(label, ["--space", s.name]);
        await until(() => loadAuthServiceInfo(userAuthStateDir(root, s.name))?.pid === d.child.pid || d.child.exitCode !== null, `the single-space service for ${s.name} did not come up: ${d.text()}`, 300_000);
        if (d.child.exitCode !== null) throw new Error(`the single-space service for ${s.name} exited ${d.child.exitCode}: ${d.text()}`);
        labels.push(label);
      }
      await settle();
      record(`${spaces.length} single-space processes`, labels.map((l) => daemons.get(l)!.child.pid!), spaces.length);
      for (const label of labels) await stopDaemon(label);
      console.log("");
      console.log("| shape | processes | spaces | RSS total (MiB) | RSS per space (MiB) | host loadavg |");
      console.log("| --- | --- | --- | --- | --- | --- |");
      for (const r of table) console.log(`| ${r.shape} | ${r.procs} | ${r.lanes} | ${r.rssMb} | ${(r.rssMb / r.lanes).toFixed(1)} | ${r.loadavg} |`);
      console.log("");
      const one = table.find((r) => r.shape.startsWith(`${spaces.length} lane`))!;
      const many = table.find((r) => r.shape.includes("single-space processes"))!;
      check(`${spaces.length} lanes in one process hold less RSS than ${spaces.length} single-space processes`, one.rssMb < many.rssMb, { oneProcess: one.rssMb, processes: many.rssMb });
      complete = true;
    } else {
      const [A, B, C] = spaces;
      const manifestPath = join(home, "spaces.json");
      const calloutManifest = join(home, "callout-spaces.json");
      const [portA, portA2, portB, portC] = [await pickFreePort(), await pickFreePort(), await pickFreePort(), await pickFreePort()];

      // ---- flag and manifest refusals at startup ----------------------------------------------------
      writeManifest(manifestPath, { version: 2, spaces: [{ space: A.name }] });
      const v1 = join(home, "v1.json");
      writeManifest(v1, { version: 1, spaces: [A.name] });
      const samePort = join(home, "same-port.json");
      writeManifest(samePort, { version: 2, spaces: [{ space: A.name, exchangePublicPort: portA }, { space: B.name, exchangePublicPort: portA }] });
      for (const [why, args, expect] of [
        ["a public-face flag with --spaces", ["--spaces", manifestPath, "--exchange-public-port", String(portA)], "drop --exchange-public-port"],
        ["--port with --spaces", ["--spaces", manifestPath, "--port", "0"], "drop --port"],
        ["--space with --spaces", ["--space", A.name, "--spaces", manifestPath], "are alternatives"],
        ["a version 1 manifest", ["--spaces", v1], "version must be 2"],
        ["two spaces naming one public port", ["--spaces", samePort], "both name exchangePublicPort"],
      ] as Array<[string, string[], string]>) {
        const d = startDaemon(`refused:${why}`, args);
        const code = await exited(d.child);
        check(`${why} refuses`, code !== 0 && d.text().includes(expect), d.text().trim().split("\n").at(-1)?.slice(0, 160));
      }
      check("no refused start wrote an acknowledgment", !existsSync(`${v1}.applied`) && !existsSync(`${samePort}.applied`));

      // ---- startup with one unservable space and one space whose port is taken ---------------------
      const squatter = createTcpServer();
      await new Promise<void>((resolve) => squatter.listen(portC, "127.0.0.1", resolve));
      const startSha = writeManifest(manifestPath, { version: 2, spaces: [
        { space: A.name, exchangePublicPort: portA, exchangeTrustedProxy: true },
        { space: B.name, exchangePublicPort: portB },
        { space: C.name, exchangePublicPort: portC },
        { space: "never-provisioned" },
      ] });
      const host = startDaemon("host", ["--spaces", manifestPath]);
      await until(() => host.text().includes("✓ auth service host up") || host.child.exitCode !== null, `the host did not come up: ${host.text()}`);
      if (host.child.exitCode !== null) throw new Error(`the host exited ${host.child.exitCode}: ${host.text()}`);
      const ready = host.text().split("\n").find((l) => l.startsWith("✓ auth service host up"))!;
      check("the host starts serving the two servable spaces and names the two it retries",
        ready.includes(`2 of 4 space(s) serving: ${A.name}, ${B.name}; retrying ${C.name}, never-provisioned`), ready.slice(0, 200));
      check("the unservable spaces are reported by name with their reason",
        host.text().includes(`space "${C.name}" could not be served`) && host.text().includes("EADDRINUSE")
        && /space "never-provisioned" could not be served \(.*user-auth material is missing/.test(host.text()));
      const info = (s: Space) => loadAuthServiceInfo(userAuthStateDir(root, s.name));
      check("each serving space has its own discovery file naming the host process, and the retried one has none",
        info(A)?.pid === host.child.pid && info(B)?.pid === host.child.pid && info(C) === undefined && info(A)!.url !== info(B)!.url && info(A)!.cap !== info(B)!.cap);
      check("the startup manifest is acknowledged by its SHA-256", applied(manifestPath) === startSha, { applied: applied(manifestPath), manifest: startSha });

      squatter.close();
      await until(() => host.text().includes(`space "${C.name}" opened`), `the host did not open ${C.name} once its port was free: ${host.text().slice(-600)}`, 60_000);
      check("the space whose port was taken opens on a retry once the port is free", info(C)?.pid === host.child.pid && info(C)?.publicUrl === `http://127.0.0.1:${portC}`);
      check("the never-provisioned space keeps being retried by name", (host.text().match(/space "never-provisioned" could not be served/g) ?? []).length >= 2);

      // ---- each space's exchange and JWKS answer from its own keys --------------------------------
      const healthA = await getJson(`http://127.0.0.1:${portA}/health`);
      const healthB = await getJson(`http://127.0.0.1:${portB}/health`);
      check("each space's public face answers with its own issuer", healthA.status === 200 && healthB.status === 200 && healthA.body.issuer !== healthB.body.issuer, { a: healthA.body.issuer, b: healthB.body.issuer });
      const jwksA = await getJson(`${info(A)!.url}/jwks`);
      const jwksB = await getJson(`${info(B)!.url}/jwks`);
      const pubJwksA = await getJson(`http://127.0.0.1:${portA}/jwks`);
      const keysOf = (j: { body: Record<string, unknown> }) => JSON.stringify(j.body.keys);
      check("each space's JWKS publishes its own keys, the same on its loopback and public faces",
        jwksA.status === 200 && jwksB.status === 200 && keysOf(jwksA) !== keysOf(jwksB) && keysOf(jwksA) === keysOf(pubJwksA));
      const bundleA = await getJson(`http://127.0.0.1:${portA}/.well-known/cotal-mesh`);
      const bundleB = await getJson(`http://127.0.0.1:${portB}/.well-known/cotal-mesh`);
      check("each public face serves its own space's discovery bundle", bundleA.body.space === A.name && bundleB.body.space === B.name);

      const loopA = await exchange(info(A)!.url, A, A.actors[0], info(A)!.cap);
      const publicB = await exchange(`http://127.0.0.1:${portB}`, B, B.actors[0]);
      check("space A's loopback exchange mints a bearer for A's actor", loopA.status === 200 && typeof loopA.body.token === "string", loopA.status);
      check("space B's public exchange mints a bearer for B's actor", publicB.status === 200 && typeof publicB.body.token === "string", publicB.status);
      const crossExchange = await exchange(`http://127.0.0.1:${portB}`, A, A.actors[1]);
      check("space B's exchange refuses space A's actor token", crossExchange.status >= 400 && crossExchange.body.token === undefined, crossExchange);
      const crossCap = await exchange(info(B)!.url, A, A.actors[1], info(A)!.cap);
      check("space B's loopback face refuses space A's capability", crossCap.status >= 400 && crossCap.body.token === undefined, crossCap.status);

      // ---- isolation, read from the broker ----------------------------------------------------------
      const a = await connectOnce(A, loopA.body.token!);
      const b = await connectOnce(B, publicB.body.token!);
      check("a bearer from space A's exchange connects into A's data account only", a.account === A.dataAccountPub && a.account !== B.dataAccountPub, { bound: a.account });
      check("a bearer from space B's exchange connects into B's data account only", b.account === B.dataAccountPub && b.account !== A.dataAccountPub, { bound: b.account });
      check("space B's callout refuses space A's bearer", (await connectRefusal(B, loopA.body.token!)) !== undefined);

      const connsA = await laneConnections(A.name);
      const connsB = await laneConnections(B.name);
      const calloutAccount = (conns: typeof connsA, space: string) => conns.find((c) => c.name === `cotal:auth-service:${space}`)?.account;
      const accountsA = new Set([A.dataAccountPub, calloutAccount(connsA, A.name)]);
      const accountsB = new Set([B.dataAccountPub, calloutAccount(connsB, B.name)]);
      check("each lane's callout connection is in its own space's auth account", calloutAccount(connsA, A.name) !== undefined && calloutAccount(connsA, A.name) !== calloutAccount(connsB, B.name));
      check("every connection space A's lane holds is in A's accounts", connsA.length > 0 && connsA.every((c) => accountsA.has(c.account)), connsA.map((c) => `${c.name}@${c.account?.slice(0, 6)}`));
      check("every connection space B's lane holds is in B's accounts", connsB.length > 0 && connsB.every((c) => accountsB.has(c.account)), connsB.map((c) => `${c.name}@${c.account?.slice(0, 6)}`));
      check("the two lanes hold the same number of connections, one shape per lane", connsA.length === connsB.length, { a: connsA.length, b: connsB.length });
      check("each space's callout queue group has one member, its own lane", (await calloutMembers(A.name)).length === 1 && (await calloutMembers(B.name)).length === 1);

      // ---- a changed entry moves that space's public face ------------------------------------------
      const movedSha = writeManifest(manifestPath, { version: 2, spaces: [
        { space: A.name, exchangePublicPort: portA2, exchangeTrustedProxy: true },
        { space: B.name, exchangePublicPort: portB },
        { space: C.name, exchangePublicPort: portC },
      ] });
      await until(() => applied(manifestPath) === movedSha && info(A)?.publicUrl === `http://127.0.0.1:${portA2}`, `space A's face did not move: ${host.text().slice(-600)}`);
      check("a changed entry closes and reopens only that space's lane", host.text().includes(`space "${A.name}" changed its settings`) && !host.text().includes(`space "${B.name}" changed its settings`));
      check("space A's public face answers on its new port and no longer on its old one",
        (await getJson(`http://127.0.0.1:${portA2}/health`)).status === 200 && await refused(`http://127.0.0.1:${portA}/health`));
      check("space B kept its lane and its discovery file across A's move", info(B)?.pid === host.child.pid && (await exchange(`http://127.0.0.1:${portB}`, B, B.actors[1])).status === 200);

      // ---- a callout replica host beside the full host ---------------------------------------------
      writeManifest(calloutManifest, { version: 1, spaces: [A.name, B.name] });
      const replica = startDaemon("replica", ["--callout-only", "--spaces", calloutManifest]);
      await until(() => replica.text().includes("✓ auth callout host up") || replica.child.exitCode !== null, `the callout host did not come up: ${replica.text()}`);
      check("with a callout host beside it, each space's callout queue group has two members",
        (await calloutMembers(A.name)).length === 2 && (await calloutMembers(B.name)).length === 2);

      // ---- removing one space: the fence --------------------------------------------------------------
      // B leaves both manifests. Each host acknowledges only once B has no lane in it, so after both
      // acknowledgments nothing on this box may serve B: no listener, no discovery file, no
      // connection named for B, no callout responder. A keeps exchanging and connecting.
      const bBearer = (await exchange(info(B)!.url, B, B.actors[1], info(B)!.cap)).body.token!;
      const bLoopback = info(B)!.url;
      check("space B's outstanding bearer connects before the removal", (await connectOnce(B, bBearer)).account === B.dataAccountPub);
      const removedSha = writeManifest(manifestPath, { version: 2, spaces: [{ space: A.name, exchangePublicPort: portA2, exchangeTrustedProxy: true }, { space: C.name, exchangePublicPort: portC }] });
      const removedCalloutSha = writeManifest(calloutManifest, { version: 1, spaces: [A.name] });
      // Space A's traffic runs alongside, from before the removal to after both acknowledgments.
      let duringOk = 0, duringAttempts = 0, trafficDone = false;
      const traffic = (async () => {
        while (!trafficDone || duringAttempts < 5) {
          duringAttempts++;
          const e = await exchange(info(A)!.url, A, A.actors[0], info(A)!.cap);
          if (e.status === 200 && (await connectOnce(A, e.body.token!)).account === A.dataAccountPub) duringOk++;
        }
      })();
      await until(() => applied(manifestPath) === removedSha && applied(calloutManifest) === removedCalloutSha,
        `the removal was not acknowledged: ${host.text().slice(-600)} ${replica.text().slice(-400)}`);
      // Read at once: the acknowledgment must already hold, with no wait after it.
      const leftover = await laneConnections(B.name);
      check("once both hosts acknowledge, no connection named for space B remains", leftover.length === 0, leftover.map((c) => c.name));
      check("once acknowledged, space B has no discovery file and neither face answers",
        info(B) === undefined && await refused(`http://127.0.0.1:${portB}/health`) && await refused(`${bLoopback}/health`));
      check("once acknowledged, space B's outstanding bearer is no longer authorized by any host", (await connectRefusal(B, bBearer)) !== undefined);
      trafficDone = true;
      await traffic;
      check("space A kept exchanging and connecting across B's removal", duringAttempts >= 5 && duringOk === duringAttempts, { ok: duringOk, attempts: duringAttempts });
      check("space A's queue group still has both of its members", (await calloutMembers(A.name)).length === 2);

      // ---- a discovery path the lane cannot write or remove leaves nothing serving --------------------
      // A non-empty directory where C's auth-service.json goes: removing it at C's close fails, and
      // writing it at C's next open fails. Either way the acknowledgment must still mean nothing
      // serves C, so no context may survive outside the host's lanes.
      const servingC = async () => !(await refused(`http://127.0.0.1:${portC}/health`)) || (await laneConnections(C.name)).length > 0;
      const blockC = join(userAuthStateDir(root, C.name), "auth-service.json");
      rmSync(blockC, { force: true });
      mkdirSync(blockC);
      writeFileSync(join(blockC, "held"), "");
      const onlyA = { version: 2, spaces: [{ space: A.name, exchangePublicPort: portA2, exchangeTrustedProxy: true }] };
      const closeSha = writeManifest(manifestPath, onlyA);
      await until(() => applied(manifestPath) === closeSha, `the removal of C was not acknowledged: ${host.text().slice(-600)}`);
      check("a lane whose discovery file cannot be removed still closes before the removal is acknowledged", !(await servingC()), host.text().slice(-300));
      const reopenMark = host.text().length;
      writeManifest(manifestPath, { version: 2, spaces: [...onlyA.spaces, { space: C.name, exchangePublicPort: portC }] });
      await until(() => host.text().slice(reopenMark).includes(`space "${C.name}" could not be served`), `C's open did not fail: ${host.text().slice(-600)}`);
      const retireSha = writeManifest(manifestPath, onlyA);
      await until(() => applied(manifestPath) === retireSha, `the second removal of C was not acknowledged: ${host.text().slice(-600)}`);
      check("a lane whose discovery file cannot be written leaves no context serving once removed", !(await servingC()), host.text().slice(reopenMark, reopenMark + 400));
      rmSync(blockC, { recursive: true, force: true });

      // ---- the manifest grammar -----------------------------------------------------------------------
      for (const [why, text] of [
        ["a version 1 manifest", '{"version":1,"spaces":["a"]}'],
        ["a name entry", '{"version":2,"spaces":["a"]}'],
        ["an entry with no space", '{"version":2,"spaces":[{"exchangePublicPort":7451}]}'],
        ["an unknown entry field", '{"version":2,"spaces":[{"space":"a","port":1}]}'],
        ["a public URL with no public port", '{"version":2,"spaces":[{"space":"a","exchangePublicUrl":"https://x"}]}'],
        ["a public URL that is not https", '{"version":2,"spaces":[{"space":"a","exchangePublicPort":1,"exchangePublicUrl":"http://x"}]}'],
        ["a duplicate space", '{"version":2,"spaces":[{"space":"a"},{"space":"a"}]}'],
        ["a partial file", '{"version":2,"spaces":[{"space":"a"'],
      ] as Array<[string, string]>) {
        let refusal: string | undefined;
        try { parseSpaceManifest(text, authHostSettings); } catch (e) { refusal = e instanceof Error ? e.message : String(e); }
        check(`the version 2 manifest refuses ${why}`, refusal !== undefined, refusal?.slice(0, 110));
      }
      const parsed = parseSpaceManifest('{"version":2,"spaces":[{"space":"a","exchangePublicPort":7451,"exchangeTrustedProxy":true},{"space":"b"}]}', authHostSettings);
      check("the version 2 manifest accepts the shape an embedder writes",
        parsed.spaces.length === 2 && parsed.settings.get("a")?.port === 7451 && parsed.settings.get("a")?.trustedProxy === true && parsed.settings.get("b") === null);

      // ---- SIGTERM closes every lane ------------------------------------------------------------------
      await stopDaemon("replica");
      const hostCode = (await Promise.all([exited(host.child), killAndAwaitExit(host.child, "SIGTERM")]))[0];
      check("a signalled host exits 0 and removes every discovery file it wrote", hostCode === 0 && info(A) === undefined && info(C) === undefined, hostCode);
      complete = true;
    }
  } finally {
    for (const label of [...daemons.keys()]) { try { await stopDaemon(label); } catch { /* already gone */ } }
    for (const { child } of daemons.values()) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    releaseBroker?.();
    if (broker) { try { await killAndAwaitExit(broker, "SIGKILL"); } catch { /* already gone */ } }
    idp.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (!complete) throw new Error("auth-service-multi-space: did not reach the end");
  if (!MEASURE) assert.equal(passed, EXPECTED_CHECKS, `auth-service-multi-space: ${passed} checks ran, ${EXPECTED_CHECKS} expected`);
  console.log(`auth-service-multi-space: ${passed} checks passed`);
}
