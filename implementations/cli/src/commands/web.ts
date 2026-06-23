import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  deliveryOf,
  parseSubject,
  spaceWildcard,
  authDir,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  clearChannel,
} from "@cotal-ai/core";
import { resolveSpace } from "../lib/status.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { c } from "../ui.js";
import { selfArgv } from "../lib/self-exec.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The dashboard's default port and its branded address. The server binds loopback
 *  (127.0.0.1) but serves any Host, so `cotal.localhost` — which Chrome/Firefox/Edge
 *  resolve to loopback with no DNS setup — just works. (Safari may not resolve
 *  `*.localhost`; plain http://127.0.0.1:7799 always does.) */
export const WEB_PORT = 7799;
export const WEB_URL = `http://cotal.localhost:${WEB_PORT}/`;

const PAGE: Record<string, { path: string; type: string }> = {
  "/": { path: join(here, "../web/index.html"), type: "text/html; charset=utf-8" },
  "/app.js": { path: join(here, "../web/app.js"), type: "text/javascript; charset=utf-8" },
  "/graph": { path: join(here, "../web/graph.html"), type: "text/html; charset=utf-8" },
  "/graph.js": { path: join(here, "../web/graph.js"), type: "text/javascript; charset=utf-8" },
};

/** A live observability dashboard for a space, served over HTTP + SSE. A read-only
 *  observer endpoint (invisible to peers) feeds the page presence, channel history,
 *  and a live message stream — no manager required. Bound to loopback. */
export async function web(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      creds: { type: "string" },
    },
  });
  const space = values.space ?? resolveSpace(process.cwd());
  const server = values.server ?? DEFAULT_SERVER;
  const port = values.port ? Number(values.port) : WEB_PORT;
  // The dashboard is always an admin god-view (no read-only viewer mode) so it can show DMs
  // and anycast. Auth mode (`.cotal/auth` present): self-mint an `admin` cred so it joins the
  // authed mesh with no manual --creds — like `cotal spawn`, it holds the space signing key.
  // An explicit --creds still wins. Open mode (no auth): connect bare.
  // Loaded once at function scope: the observer connects with a read-only `admin` cred, but
  // the channel-delete write path mints an ephemeral `manager` cred from this same material.
  const auth = loadSpaceAuth(authDir(cotalRoot()));
  let creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  if (!creds && auth) {
    if (auth.space !== space) {
      console.error(
        c.red(`Auth here is for space "${auth.space}", not "${space}". Use --space ${auth.space} (or pass --creds).`),
      );
      process.exit(1);
    }
    creds = await mintCreds(auth, newIdentity(), "admin");
  }
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm cotal up`));
    process.exit(1);
  }

  // Observer: never registers presence, never consumes an inbox — invisible to peers.
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false, // observer: reads via tap + history + presence-watch, binds no durables
    registerPresence: false,
    watchPresence: true,
    card: { name: "web", kind: "endpoint" },
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
    console.error(c.dim(`• membership feed unavailable — graph shows traffic only (${(e as Error).message})`));
  }
  // Every comm on the mesh (chat / unicast / anycast) → push to the live feed. The admin cred
  // allows the whole space, so the observer taps everything — DMs + anycast included.
  const tapSubject = spaceWildcard(space);
  ep.tap((subject, msg) => {
    const mode = deliveryOf(subject);
    if (!mode || !msg) return;
    // senderId is the subject's sender token — the *verified* publisher (the server
    // policed who could publish it), vs the advisory `from` in the payload.
    const senderId = parseSubject(subject)?.sender;
    broadcast("message", { mode, senderId, msg });
  }, { subject: tapSubject });

  const httpServer = createServer(async (req, res) => {
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
    if (path === "/api/meta") return json(res, { space });
    if (path === "/api/roster") return json(res, ep.getRoster());
    if (path === "/api/membership") {
      // Authoritative who-is-subscribed (broker-sourced); {asOf, members:[{id,live,durable,observedAt}]}.
      // An unavailable feed returns an empty snapshot so the graph cleanly degrades to traffic-only.
      try { return json(res, await ep.readMembership()); }
      catch { return json(res, { asOf: undefined, members: [] }); }
    }
    if (path === "/api/channels") return json(res, await ep.listChannels());
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
    // dashboard, so it's POST-gated and guarded by a confirm in the UI. The observer's admin
    // cred can't purge; mint an ephemeral manager cred (auth mode) for the op, else connect
    // bare (open mode has full rights). A wildcard / missing channel is a 400.
    if (path === "/api/channel/delete" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}) as { channel?: string });
      const channel = typeof body.channel === "string" ? body.channel : "";
      if (!channel) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "channel required" }));
        return;
      }
      try {
        const purgeCreds = auth ? await mintCreds(auth, newIdentity(), "manager") : creds;
        const result = await clearChannel({ servers: server, space, channel, creds: purgeCreds });
        return json(res, { ok: true, ...result });
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
        return;
      }
    }

    const file = PAGE[path];
    if (file) {
      res.writeHead(200, { "content-type": file.type });
      res.end(readFileSync(file.path));
      return;
    }
    res.writeHead(404).end("not found");
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
  const url = port === WEB_PORT ? WEB_URL : `http://127.0.0.1:${port}/`;
  console.log(`${c.bold("Cotal web")} — observing space ${c.bold(space)}`);
  console.log(c.dim("  god-view — DMs + anycast visible"));
  console.log(`  ${c.cyan(url)}  ${c.dim("(Ctrl-C to stop)")}`);
  if (!values["no-open"]) openBrowser(url);

  const shutdown = async () => {
    clearInterval(ping);
    membershipWatch?.stop();
    for (const res of clients) res.end();
    httpServer.close();
    await ep.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
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

/** True if something is already listening on the dashboard port (loopback). */
export function webUp(port: number = WEB_PORT): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect(port, "127.0.0.1");
    sock.setTimeout(400);
    const done = (up: boolean) => {
      sock.destroy();
      res(up);
    };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Start the dashboard in the background (pid in `.cotal/web.pid`, output to `.cotal/web.log`),
 *  stopped by `cotal down`. Re-execs this same CLI — `process.execArgv` carries the tsx loader in
 *  dev, and is empty in prod where `node <entry.js> web …` runs the compiled binary. */
export function startWebDetached(o: { space?: string; server?: string } = {}): { pid: number; url: string } {
  const fd = openSync(cotalPath("web.log"), "a");
  const [node, ...self] = selfArgv();
  const args = [
    ...self,
    "web",
    "--no-open",
    "--port",
    String(WEB_PORT),
    "--space",
    o.space ?? resolveSpace(process.cwd()),
    ...(o.server ? ["--server", o.server] : []),
  ];
  const child = spawn(node, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  writeFileSync(cotalPath("web.pid"), String(child.pid));
  return { pid: child.pid ?? 0, url: WEB_URL };
}

/** Make the dashboard available: reuse one already listening, else start it detached and wait
 *  briefly for it to come up. Best-effort — callers treat a non-running result as non-fatal. */
export async function ensureWeb(o: { space?: string; server?: string } = {}): Promise<{ url: string; running: boolean }> {
  if (await webUp()) return { url: WEB_URL, running: true };
  startWebDetached(o);
  for (let i = 0; i < 20 && !(await webUp()); i++) await new Promise((r) => setTimeout(r, 150));
  return { url: WEB_URL, running: await webUp() };
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
