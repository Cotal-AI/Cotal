import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CotalEndpoint,
  deliveryOf,
  parseSubject,
  spacePrefix,
  mintCreds,
  newIdentity,
  clearChannel,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  c,
  connectOrExit,
  localProcessPath,
  userViewAuth,
  userViewAuthOrExit,
  type LocalProcess,
  type UserViewAuth,
} from "@cotal-ai/workspace";

const here = dirname(fileURLToPath(import.meta.url));

/** The dashboard's default port and its branded address. The server binds loopback
 *  (127.0.0.1) but serves any Host, so `cotal.localhost` — which Chrome/Firefox/Edge
 *  resolve to loopback with no DNS setup — just works. (Safari may not resolve
 *  `*.localhost`; plain http://127.0.0.1:7799 always does.) */
export const WEB_PORT = 7799;
export const WEB_URL = `http://cotal.localhost:${WEB_PORT}/`;
const DETACHED_READY_TIMEOUT_MS = 30_000;
const DETACHED_STOP_TIMEOUT_MS = 3_000;
const DETACHED_ROOT_ENV = "COTAL_WEB_DETACHED_ROOT";
export const webProcess: LocalProcess = {
  kind: "local-process",
  name: "web",
  label: "web dashboard",
  order: 40,
  pidFile: "web.pid",
  // The dashboard starts target-resolved from any directory and claims its pidfile under the
  // TARGET mesh's root (`conn.root` below); `cotal down web` must resolve the same mesh.
  rootedAt: "target",
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomically claim this mesh's web pidfile so concurrent custom-port launches cannot overwrite it. */
function claimPid(path: string): void {
  let created = false;
  try {
    const fd = openSync(path, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
  } catch (e) {
    if (created) rmSync(path, { force: true });
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const raw = readFileSync(path, "utf8").trim();
    if (raw.startsWith("removing:")) {
      const owner = Number(raw.slice("removing:".length));
      throw new Error(
        pidAlive(owner)
          ? `web extension removal is in progress (pid ${owner})`
          : `web dashboard has a stale extension-removal reservation at ${path} - remove it and retry`,
      );
    }
    const prior = Number(raw);
    if (pidAlive(prior))
      throw new Error(`web dashboard is already running for this mesh (pid ${prior})`);
    throw new Error(`web dashboard has a stale pidfile at ${path} - clean it with \`cotal down web\`, then retry`);
  }
}

function releasePid(path: string): void {
  try {
    if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
  } catch {
    // Already removed by `down` or another cleanup path.
  }
}

// Message bodies render markdown via marked + DOMPurify (parse + sanitize). Their browser builds are
// copied into dist/web/vendor at build time (scripts/copy-vendor.mjs) and served from the dashboard's
// OWN files, so a published/seeded copy is self-contained and never reaches into node_modules at
// runtime — which is what lets web ship as a bundled first-party extension, seeded like the connectors.
const jsType = "text/javascript; charset=utf-8";
const PAGE: Record<string, { path: string; type: string }> = {
  "/": { path: join(here, "web/index.html"), type: "text/html; charset=utf-8" },
  "/harness.js": { path: join(here, "web/harness.js"), type: jsType },
  "/md.js": { path: join(here, "web/md.js"), type: jsType },
  "/app.js": { path: join(here, "web/app.js"), type: jsType },
  "/graph": { path: join(here, "web/graph.html"), type: "text/html; charset=utf-8" },
  "/graph.js": { path: join(here, "web/graph.js"), type: jsType },
  "/vendor/marked.umd.js": { path: join(here, "web/vendor/marked.umd.js"), type: jsType },
  "/vendor/purify.min.js": { path: join(here, "web/vendor/purify.min.js"), type: jsType },
};

/** A live observability dashboard for a space, served over HTTP + SSE. A read-only
 *  observer endpoint (invisible to peers) feeds the page presence, channel history,
 *  and a live message stream — no manager required. Bound to loopback. */
export async function web(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; server?: string; port?: string; "no-open"?: boolean; detach?: boolean; creds?: string };
  // Resolve WHICH running mesh + creds (admin god-view: shows DMs + anycast), then DROP the account
  // seed. The dashboard is a loopback HTTP process; holding the space signing seed (`auth` — it can
  // mint ANY identity/role) for the whole session would make a dashboard compromise = full account
  // control. Instead pre-mint ONE scoped `channel-purger` cred for the only write path (channel delete
  // = filtered CHAT purge + a channel-registry key delete) and let the seed fall out of scope here, so
  // it isn't reachable from the request handlers. `--creds` / open mode have no seed → the connection
  // creds carry the purge rights.
  //
  // USER MODE: the god view rides an exchange-gated "admin" VIEW bearer (ledger scope "admin",
  // fresh-checked at every mint and every connect) — standing via a bearer SOURCE so the tap
  // survives the ≤5-minute token life. No pre-minted purge cred: channel delete mints a one-shot
  // "channel-purger" view per action, so each destructive click is a fresh ledger check, and
  // `cotal actor revoke` kills the dashboard live (eviction) while a scope edit bites at the next
  // refresh.
  const conn = await connectOrExit(values, "admin");
  const detachedRoot = process.env[DETACHED_ROOT_ENV];
  if (detachedRoot && conn.root !== detachedRoot)
    throw new Error(`detached web target lost its recorded mesh root (${detachedRoot}) before startup`);
  const port = values.port ? Number(values.port) : WEB_PORT;
  if (values.detach) {
    if (!conn.root)
      throw new Error("`cotal web --detach` requires a recorded mesh root; start or register the mesh with `cotal up` first");
    await launchDetachedWeb(args.raw, conn.root, conn.space, conn.server, port, Boolean(values["no-open"]));
    return;
  }
  const user = conn.bearer ? await userViewAuthOrExit(conn, "admin") : undefined;
  const { server, space } = conn;
  const pidPath = conn.root ? localProcessPath(webProcess.pidFile, { root: conn.root, space }) : undefined;
  if (pidPath) {
    claimPid(pidPath);
    process.once("exit", () => releasePid(pidPath));
  }
  const purgeCreds = !user && conn.auth ? await mintCreds(conn.auth, newIdentity(), "channel-purger") : conn.creds;

  // Observer: never registers presence, never consumes an inbox — invisible to peers.
  const ep = new CotalEndpoint({
    space,
    servers: server,
    ...(user
      ? { bearer: user.source, sentinelCreds: user.sentinelCreds, card: { owner: user.owner, actor: user.actor, name: "web", kind: "endpoint" as const } }
      : { creds: conn.creds, card: { name: "web", kind: "endpoint" as const } }),
    channels: [],
    consume: false, // observer: reads via tap + history + presence-watch, binds no durables
    registerPresence: false,
    watchPresence: true,
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();

  const clients = new Set<ServerResponse>();
  const send = (res: ServerResponse, event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) if (!res.writableEnded) send(res, event, data);
  };

  // Presence changes → push the whole roster; the client just re-renders it.
  ep.on("presence", () => broadcast("roster", ep.getRoster()));

  // Broker-sourced channel membership (the authoritative graph spokes): push a `membership` SSE event
  // on every feed change (debounced; the client re-reads the snapshot). Best-effort — a space without the
  // feed (no delivery daemon, or provisioned before this feature) simply never emits, and the graph
  // degrades to traffic-only. The admin cred carries the read grant; agents never do.
  let membershipWatch: { stop(): void } | undefined;
  const pushMembership = debounce(() => {
    void ep.readMembership().then((m) => broadcast("membership", m)).catch(() => {});
  }, 150);
  try {
    membershipWatch = await ep.watchMembership(pushMembership);
  } catch (e) {
    console.error(c.dim(`• membership feed unavailable - graph shows traffic only (${(e as Error).message})`));
  }
  // Every comm on the mesh (chat / unicast / anycast) → push to the live feed. The admin cred
  // allows exactly the MESSAGING plane (SPEC 13.9/13.11: chat + inst + svc, enumerated — never
  // the space-wide `>`, which would also plain-subscribe the v0.4 endpoint request rails), so
  // the tap is one subscription per plane.
  const onTap = (subject: string, msg: unknown) => {
    const mode = deliveryOf(subject);
    if (!mode || !msg) return;
    // senderId is the subject's sender token — the *verified* publisher (the server
    // policed who could publish it), vs the advisory `from` in the payload.
    const senderId = parseSubject(subject)?.sender;
    broadcast("message", { mode, senderId, msg });
  };
  for (const plane of ["chat", "inst", "svc"])
    ep.tap(onTap, { subject: `${spacePrefix(space)}.${plane}.>` });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");

    if (path === "/feed") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      send(res, "roster", ep.getRoster());
      // Seed this client's graph with the current membership snapshot (the live tap only carries
      // post-connect traffic; membership is state, so a fresh client needs it explicitly).
      void ep.readMembership().then((m) => { if (!res.writableEnded) send(res, "membership", m); }).catch(() => {});
      req.on("close", () => clients.delete(res));
      return;
    }
    if (path === "/api/meta") return json(res, { space, pid: process.pid });
    if (path === "/api/roster") return json(res, ep.getRoster());
    if (path === "/api/membership") {
      // Authoritative who-is-subscribed (broker-sourced); {asOf, members:[{id,live,durable,observedAt}]}.
      // An unavailable feed returns an empty snapshot so the graph cleanly degrades to traffic-only.
      try { return json(res, await ep.readMembership()); }
      catch { return json(res, { asOf: undefined, members: [] }); }
    }
    if (path === "/api/channels") {
      // Resolve defaults at the endpoint so every web client renders the same channel policy the
      // core applies; the registry's `config` holds only per-channel overrides.
      const channels = await ep.listChannels();
      return json(res, channels.map(({ channel, messages, config }) => ({
        channel,
        messages,
        description: config?.description,
        replay: ep.channelReplay(channel),
        replayWindow: ep.channelReplayWindow(channel),
        deliveryClass: ep.channelDeliveryClass(channel),
      })));
    }
    if (path === "/api/activity") {
      // Backfill the all-activity feed: merge recent channel history with DM history (the live
      // SSE tap only carries messages from after a client connects). Entries are mode-tagged
      // ({mode, msg}) to match the live feed so DMs render as DMs.
      const limit = query.get("limit") ? Number(query.get("limit")) : 200;
      const chans = await ep.listChannels();
      const chat = (
        await Promise.all(chans.map((ch) => ep.channelHistory(ch.channel, { limit })))
      )
        .flat()
        .map((msg) => ({ mode: "chat" as const, msg }));
      const dms = (await ep.dmHistory({ limit })).map((msg) => ({ mode: "unicast" as const, msg }));
      const all = [...chat, ...dms].sort((a, b) => a.msg.ts - b.msg.ts);
      return json(res, all.slice(-limit));
    }
    if (path === "/api/dms") {
      // DM history for the Direct-messages lens (god-view); the client groups it by peer/pair.
      const limit = query.get("limit") ? Number(query.get("limit")) : 500;
      return json(res, await ep.dmHistory({ limit }));
    }
    if (path.startsWith("/api/channels/") && path.endsWith("/history")) {
      const name = decodeURIComponent(path.slice("/api/channels/".length, -"/history".length));
      const limit = query.get("limit") ? Number(query.get("limit")) : 200;
      return json(res, await ep.channelHistory(name, { limit }));
    }
    // Delete a channel and its content. The only write path on this otherwise read-only
    // dashboard, so it's POST-gated and guarded by a confirm in the UI. Uses the manager cred
    // pre-minted at startup (auth mode) or the connection creds (open / --creds), NOT the account
    // seed (which we dropped). A wildcard / missing channel is a 400.
    if (path === "/api/channel/delete" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}) as { channel?: string });
      const channel = typeof body.channel === "string" ? body.channel : "";
      if (!channel) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "channel required" }));
        return;
      }
      try {
        // User mode mints a one-shot channel-purger VIEW per delete — the ledger is re-checked at
        // this click, and a mid-session revoke becomes this handler's 400, never a dead dashboard.
        const result = user
          ? await userViewAuth(conn, "channel-purger").then((p: UserViewAuth) =>
              clearChannel({ servers: server, space, channel, bearer: p.bearer, sentinelCreds: p.sentinelCreds }),
            )
          : await clearChannel({ servers: server, space, channel, creds: purgeCreds });
        return json(res, { ok: true, ...result });
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
        return;
      }
    }

    const file = PAGE[path];
    if (file) {
      // no-cache: always revalidate so a `cotal` upgrade's new dashboard code is picked up on
      // reload — a stale cached graph.js silently runs old behavior (e.g. pre-fix filters).
      res.writeHead(200, { "content-type": file.type, "cache-control": "no-cache" });
      res.end(readFileSync(file.path));
      return;
    }
    res.writeHead(404).end("not found");
  };

  // A route handler talks to the broker, so ANY of them can reject — a JetStream request that
  // times out (a slow or briefly unreachable broker, e.g. a mesh reached over a relayed overlay
  // link) rejects inside the async handler. `createServer(async …)` does not await its listener,
  // so such a rejection became an unhandled rejection and killed the whole dashboard process on
  // the first slow request. The dashboard is a read-only observer: one failed route must degrade
  // to a 500, never take down the server. Reply only when nothing has been written yet — a /feed
  // stream (or any partially-sent response) is already committed to its status line.
  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      console.error(c.red(`! ${req.method ?? "GET"} ${req.url ?? "/"} failed: ${why}`));
      if (res.headersSent) return void res.end();
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: why }));
    });
  });

  // Comment ping keeps idle SSE connections alive through proxies.
  const ping = setInterval(() => {
    for (const res of clients) if (!res.writableEnded) res.write(": ping\n\n");
  }, 20_000);

  httpServer.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(c.red(`Port ${port} is in use. Pass --port <n>.`));
    else console.error(c.red("! " + e.message));
    process.exit(1);
  });

  await new Promise<void>((ready) => httpServer.listen(port, "127.0.0.1", ready));
  // Branded URL only when on the default port; a custom --port keeps the plain loopback address.
  const url = webUrl(port);
  console.log(`${c.bold("Cotal web")} - observing space ${c.bold(space)}`);
  console.log(c.dim("  god-view - DMs + anycast visible"));
  console.log(`  ${c.cyan(url)}  ${c.dim("(Ctrl-C to stop)")}`);
  if (!values["no-open"]) openBrowser(url);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(ping);
    membershipWatch?.stop();
    for (const res of clients) res.end();
    httpServer.close();
    await ep.stop();
    if (pidPath) releasePid(pidPath);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}

/** Launch the dashboard through this exact Cotal entrypoint, then report success only after the
 * spawned PID proves it owns both the mesh pidfile and the HTTP listener. */
async function launchDetachedWeb(
  raw: readonly string[],
  root: string,
  space: string,
  server: string,
  port: number,
  noOpen: boolean,
): Promise<void> {
  const context = { root, space };
  const pidPath = localProcessPath(webProcess.pidFile, context);
  const logPath = localProcessPath("web.log", context);
  const logFd = openSync(logPath, "a", 0o600);
  const logOffset = fstatSync(logFd).size;
  const childArgs = detachedArgs(raw, space, server);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [...process.execArgv, process.argv[1], "web", ...childArgs], {
      cwd: root,
      detached: true,
      env: { ...process.env, [DETACHED_ROOT_ENV]: root },
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const url = webUrl(port);
  try {
    await waitForDetachedWeb(child, { pidPath, url: `http://127.0.0.1:${port}/`, space, timeoutMs: DETACHED_READY_TIMEOUT_MS });
  } catch (e) {
    let cleanupError: Error | undefined;
    try { await terminateDetachedWeb(child, pidPath); }
    catch (err) { cleanupError = err as Error; }
    const tail = appendedLogTail(logPath, logOffset);
    throw new Error(`${(e as Error).message}${cleanupError ? `; ${cleanupError.message}` : ""} - see ${logPath}${tail ? `\n${tail}` : ""}`);
  }

  console.log(c.green(`✓ web dashboard ready at ${url} (pid ${child.pid})`));
  console.log(c.dim(`  log: ${logPath}`));
  console.log(c.dim("  stop: cotal down web"));
  if (!noOpen) openBrowser(url);
}

export function detachedArgs(raw: readonly string[], space: string, server: string): string[] {
  const kept: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === "--detach" || arg === "--no-open") continue;
    if (arg === "--space" || arg === "--server") {
      i++;
      continue;
    }
    if (arg.startsWith("--space=") || arg.startsWith("--server=")) continue;
    kept.push(arg);
  }
  return [...kept, "--space", space, "--server", server, "--no-open"];
}

export async function waitForDetachedWeb(
  child: ChildProcess,
  opts: { pidPath: string; url: string; space: string; timeoutMs: number },
): Promise<void> {
  let spawnError: Error | undefined;
  const spawnErrorPromise = new Promise<Error>((resolve) => child.once("error", (e) => {
    spawnError = e;
    resolve(e);
  }));
  const pid = child.pid;
  if (!pid) {
    const error = await Promise.race([spawnErrorPromise, sleep(100).then(() => undefined)]);
    throw new Error(`web dashboard failed to start${error ? `: ${error.message}` : " (no process id)"}`);
  }
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`web dashboard failed to start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null || !pidAlive(pid))
      throw new Error(`web dashboard exited before becoming ready (pid ${pid})`);
    if (pidFileOwned(opts.pidPath, pid)) {
      const meta = await fetch(`${opts.url}api/meta`, { signal: AbortSignal.timeout(500) })
        .then(async (res) => res.ok ? await res.json() as { space?: unknown; pid?: unknown } : undefined)
        .catch(() => undefined);
      if (meta?.space === opts.space && meta.pid === pid) {
        if (child.exitCode !== null || child.signalCode !== null || !pidAlive(pid))
          throw new Error(`web dashboard exited during readiness (pid ${pid})`);
        return;
      }
    }
    await sleep(100);
  }
  throw new Error(`web dashboard did not become HTTP-ready within ${opts.timeoutMs}ms (pid ${pid})`);
}

export async function terminateDetachedWeb(child: ChildProcess, pidPath: string): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (pidAlive(pid)) {
    try { child.kill("SIGTERM"); } catch { /* verify below */ }
    if (!(await waitForDeath(child, pid, DETACHED_STOP_TIMEOUT_MS))) {
      try { child.kill("SIGKILL"); } catch { /* verify below */ }
      if (!(await waitForDeath(child, pid, DETACHED_STOP_TIMEOUT_MS)))
        throw new Error(`failed to terminate detached web dashboard (pid ${pid}); ${pidPath} was preserved`);
    }
  }
  if (pidFileOwned(pidPath, pid)) rmSync(pidPath, { force: true });
}

function pidFileOwned(path: string, pid: number): boolean {
  try { return readFileSync(path, "utf8").trim() === String(pid); }
  catch { return false; }
}

async function waitForDeath(child: ChildProcess, pid: number, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || !pidAlive(pid)) return true;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(timeoutMs),
  ]);
  return child.exitCode !== null || child.signalCode !== null || !pidAlive(pid);
}

export function appendedLogTail(path: string, offset: number): string {
  try {
    const size = statSync(path).size;
    if (size <= offset) return "";
    const start = Math.max(offset, size - 4096);
    const bytes = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try { readSync(fd, bytes, 0, bytes.length, start); } finally { closeSync(fd); }
    return bytes.toString("utf8").trim();
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function webUrl(port: number): string {
  return port === WEB_PORT ? WEB_URL : `http://127.0.0.1:${port}/`;
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Trailing-edge debounce — coalesces a burst of membership-feed deltas into one push. */
function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

async function readBody(req: IncomingMessage): Promise<{ channel?: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Best-effort open of the dashboard in the default browser. The URL is already
 *  printed, so a failure here is harmless — never block startup on it. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener on this platform — the printed URL is the fallback */
  }
}
