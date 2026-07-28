import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AttachSession } from "@cotal-ai/core";
import type { AgentHandle } from "./runtime/index.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Vendored xterm.js assets (served from node_modules, resolved at startup). */
const ASSETS: Record<string, { path: string; type: string }> = {
  "/assets/xterm.js": { path: require.resolve("@xterm/xterm/lib/xterm.js"), type: "text/javascript" },
  "/assets/xterm.css": { path: require.resolve("@xterm/xterm/css/xterm.css"), type: "text/css" },
  "/assets/addon-fit.js": { path: require.resolve("@xterm/addon-fit/lib/addon-fit.js"), type: "text/javascript" },
  "/assets/addon-attach.js": { path: require.resolve("@xterm/addon-attach/lib/addon-attach.js"), type: "text/javascript" },
};

/** Anything the console page needs to render itself, served from this dir. */
const PAGE: Record<string, { path: string; type: string }> = {
  "/": { path: join(here, "console/index.html"), type: "text/html" },
  "/app.js": { path: join(here, "console/app.js"), type: "text/javascript" },
};

/**
 * The address the attach endpoint binds and advertises: the host of the mesh broker this manager is
 * attached to. Keeping the two in step is the whole point — a client that reached the control plane
 * to request an attach URL demonstrably has a route to that address, whereas a hardcoded
 * `127.0.0.1` resolves to the client's own machine.
 *
 * With no server URL there is no mesh address to follow, so this is loopback: the conservative
 * default and exactly the endpoint's previous behavior. An unparseable URL is a caller bug and
 * throws rather than quietly binding somewhere the operator did not ask for.
 */
export function attachHost(servers: string | undefined): string {
  if (!servers) return "127.0.0.1";
  const first = servers.split(",")[0].trim();
  if (!first) return "127.0.0.1";
  const hostname = new URL(first).hostname;
  if (!hostname) return "127.0.0.1";
  // `URL.hostname` returns an IPv6 literal in its BRACKETED form (`[::1]`), which is a URL
  // construct, not an address. `server.listen()` treats a bracketed string as a DNS name and fails
  // ENOTFOUND, so a manager on an IPv6 broker URL would die at startup. Strip here: this value is a
  // BIND address, and `#advertised` puts the brackets back for the URL form.
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** How long an issued attach capability stays redeemable. The client redeems it immediately (the
 *  control-plane reply goes straight into a connect), so this only has to cover that round trip;
 *  short means a URL that leaked into a log or shell history is already dead. */
const ATTACH_TICKET_TTL_MS = 120_000;

/** One Server-Sent-Events frame: a named event carrying JSON data. */
export interface FeedEvent {
  event: string;
  data: unknown;
}

/**
 * The manager's local HTTP + WebSocket face. It hosts the **console** (a
 * lightweight xterm.js page) and bridges each agent's PTY to the browser — and to
 * `cotal attach` — over a direct socket, never the mesh, so owning the terminal
 * keeps the manager off the message hot path.
 *
 * **Where it binds, and why it is credentialed.** A mesh can span machines: the manager that owns an
 * agent's PTY may sit on another host than the operator running `cotal attach`. Hardcoding
 * `127.0.0.1` made every remote attach fail with ECONNREFUSED against the *client's own* loopback.
 * The bind address is therefore an explicit option (default loopback, so nothing is exposed by
 * accident); `cotal up` passes the address it bound the broker to. A broker DIAL address is
 * deliberately NOT used as the bind: a manager may supervise a broker on another host and could not
 * bind that address at all. Where the manager can only name loopback (a wildcard bind), the CLIENT
 * substitutes the broker address its own control connection reached.
 *
 * Reachability is why the surface is credentialed, in two tiers. This face carries terminal READ AND
 * WRITE for every managed agent, plus the roster and the live feed, so once it can leave the box
 * "unauthenticated but loopback-only" stops being a safe position.
 *
 *  - **Attach tickets** are what a mesh caller gets: minted per authorized `attach` request, bound to
 *    the ONE agent the manager just authorized, single-use, short-lived. This is what makes the
 *    per-agent/owner check real — a manager-wide token would let a caller authorized for its own
 *    agent swap the path and take over anyone's terminal.
 *  - **The console token** is the operator's own: it reaches every agent, because the console
 *    legitimately drives all of them, and it is printed solely to this manager process's output
 *    (so it is as sensitive as `.cotal/manager.log`, and never handed to a mesh caller).
 *
 * Credentials travel in `?t=` or a bearer header, never a cookie: cookies are host-scoped, not
 * port-scoped, so one set here would be sent to every other HTTP service on this host and would
 * collide between two managers on one box. The console URL carries its token in the FRAGMENT, which
 * a browser never sends to a server.
 *
 * Routes: `GET /` console page, `GET /agents` the managed roster (JSON),
 * `GET /feed` the live mesh feed (SSE: presence roster + comms), static assets
 * under `/assets`, and `WS /attach/<name>` the PTY stream.
 *
 * Attach protocol: server → client sends raw terminal bytes (binary). client →
 * server: binary frames are keystrokes; a text frame `r:<cols>,<rows>` resizes.
 */
export class AttachEndpoint {
  #http: Server;
  #wss: WebSocketServer;
  #port: number;
  #host: string;
  #sse = new Set<ServerResponse>();
  #ping?: ReturnType<typeof setInterval>;
  /** Redeemable attach capabilities: token → the ONE INCARNATION it may attach, and when it lapses.
   *  `handle` is the identity that actually matters — see {@link AttachEndpoint.url}. */
  #tickets = new Map<string, { name: string; handle: AgentHandle; expires: number }>();

  constructor(
    private readonly lookup: (name: string) => AgentHandle | undefined,
    private readonly list: () => unknown,
    /** Events replayed to each console as it connects to `/feed` (e.g. the current roster). */
    private readonly snapshot: () => FeedEvent[],
    port = 0,
    /** Bind address, and the host advertised in {@link url} / {@link consoleUrl}. Defaults to
     *  loopback; the manager passes the mesh broker's host so attach is reachable from wherever the
     *  mesh is. A wildcard bind still advertises loopback, since a wildcard is not a dialable name. */
    host = "127.0.0.1",
    /** The endpoint credential. Generated per manager process; required on every route. */
    private readonly token: string = randomBytes(32).toString("hex"),
  ) {
    this.#port = port;
    this.#host = host;
    this.#http = createServer((req, res) => this.#onRequest(req, res));
    this.#wss = new WebSocketServer({ noServer: true });
    this.#http.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "/").split("?")[0];
      if (!path.startsWith("/attach/")) {
        socket.destroy();
        return;
      }
      let name: string;
      try {
        name = decodeURIComponent(path.slice("/attach/".length));
      } catch {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      // Terminal read+write, so the capability must name THIS agent: a ticket issued for one agent
      // must never attach another. Redeemed against the decoded name — the name is parsed first only
      // because the check needs it, and a malformed name is refused before any credential is looked
      // at, so neither order leaks the other's outcome.
      if (!this.#redeemAttach(req, name)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#onConnection(ws, name).catch(() => ws.close());
      });
    });
  }

  /** The credential a request presents, from `?t=` or a bearer header. */
  #presented(req: IncomingMessage): string | undefined {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("t") ?? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? undefined;
  }

  /** Constant-time equality — `timingSafeEqual` throws on unequal lengths, so screen those first. */
  #sameSecret(presented: string | undefined, secret: string): boolean {
    if (!presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The MANAGER-WIDE credential: the operator's own console session. It reaches every agent, which
   *  is not an escalation — it is only ever printed to the manager process's own output, and anyone
   *  who can read that already controls the process. Never handed to a mesh caller. */
  #authorized(req: IncomingMessage): boolean {
    return this.#sameSecret(this.#presented(req), this.token);
  }

  /**
   * Redeem an attach capability for EXACTLY `name`.
   *
   * The per-name control-plane authorization (`Manager.opAttach` → `authorizeNamed`) is only real if
   * the credential it hands back is bound to the agent it authorized. A manager-wide token is not:
   * a caller legitimately authorized for its own agent could edit `/attach/mine` to `/attach/victim`
   * and the endpoint, checking only "is this the manager's token", would attach it — silently
   * defeating the owner-domain and cross-owner admin boundaries on a user-auth mesh. So a mesh
   * caller receives a ticket that names one agent, expires, and is consumed on redemption.
   *
   * The console token is also accepted here, because the console legitimately drives every agent.
   */
  #redeemAttach(req: IncomingMessage, name: string): boolean {
    const presented = this.#presented(req);
    if (!presented) return false;
    if (this.#sameSecret(presented, this.token)) return true; // operator console: all agents
    const ticket = this.#tickets.get(presented);
    if (!ticket) return false;
    this.#tickets.delete(presented); // single use, redeemed or not
    if (ticket.expires < Date.now()) return false;
    // Compare the BOUND name against the requested one in constant time, so a redemption cannot be
    // probed character-by-character for another agent's name.
    if (!this.#sameSecret(name, ticket.name)) return false;
    // A NAME IS A REUSABLE SLOT, not an identity. Binding the capability to the name alone leaves it
    // valid for whoever occupies that slot at redemption time: if the authorized agent exits and a
    // same-name successor — possibly a different owner's — takes the slot inside the TTL, the
    // untouched URL would attach the successor's terminal. Bind to the incarnation instead. The
    // handle object IS that identity: the manager creates a new one per spawn, so a successor can
    // never compare equal to its predecessor.
    return this.lookup(name) === ticket.handle;
  }

  /** Drop expired tickets so an idle manager doesn't accumulate them. */
  #sweepTickets(): void {
    const now = Date.now();
    for (const [t, v] of this.#tickets) if (v.expires < now) this.#tickets.delete(t);
  }

  async start(): Promise<void> {
    // The bind host is the BROKER's, which is right when the manager is co-located with it (every
    // `cotal up` stack). A manager pointed at a broker on ANOTHER machine does not own that address,
    // and `listen` fails EADDRNOTAVAIL. Say so in operator terms instead of surfacing a bare errno
    // from deep inside startup: the address is the diagnosis, and the two real resolutions are to
    // run the manager on the broker's host or to give this space a broker address this host owns.
    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRNOTAVAIL" || e.code === "EADDRINUSE") {
          reject(
            new Error(
              e.code === "EADDRINUSE"
                ? `the manager's attach endpoint cannot bind ${this.#host}:${this.#port} - that port is already in use on this host`
                : `the manager's attach endpoint cannot bind ${this.#host} - this machine has no such address. The attach face binds the broker's host, so the manager must run on the machine the broker is bound to.`,
            ),
          );
          return;
        }
        reject(e);
      };
      this.#http.once("error", onError);
      this.#http.listen(this.#port, this.#host, () => {
        this.#http.off("error", onError);
        resolve();
      });
    });
    const addr = this.#http.address();
    if (addr && typeof addr === "object") this.#port = addr.port;
    // Comment ping keeps idle SSE connections from being dropped; no-op with none.
    this.#ping = setInterval(() => {
      for (const res of this.#sse) if (!res.writableEnded) res.write(": ping\n\n");
    }, 20_000);
  }

  async stop(): Promise<void> {
    if (this.#ping) clearInterval(this.#ping);
    for (const res of this.#sse) res.end();
    this.#sse.clear();
    for (const ws of this.#wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  /** Push a named event to every connected console (SSE). */
  publish(event: string, data: unknown): void {
    for (const res of this.#sse) this.#writeEvent(res, event, data);
  }

  /** A wildcard bind is not a dialable address — advertise loopback for it, the one host a wildcard
   *  is always reachable on locally. */
  get #advertised(): string {
    if (this.#host === "0.0.0.0" || this.#host === "::" || this.#host === "[::]") return "127.0.0.1";
    return this.#host.includes(":") && !this.#host.startsWith("[") ? `[${this.#host}]` : this.#host;
  }

  /**
   * The ws URL a client uses to attach to `name`, carrying a capability bound to THAT agent.
   *
   * Called once per authorized control-plane `attach` request, so the ticket inherits exactly the
   * authorization the manager just performed for this caller and this agent. It is single-use and
   * short-lived: the client redeems it immediately, and a leaked URL (shell history, a log, a
   * `Referer`) is spent or expired rather than a standing key to someone's terminal.
   *
   * `expected` is the handle the caller actually authorized, and it is REQUIRED. A name is a reusable
   * slot, and authorization is async (a user-mode ledger read), so between the caller resolving the
   * name and arriving here the slot can have been stopped and refilled by a same-name successor.
   * Re-resolving the name would then mint a valid ticket for an agent nobody authorized. Binding to
   * the caller's own handle closes that window: if the slot moved, there is no capability to issue.
   */
  url(name: string, expected: AgentHandle): string {
    this.#sweepTickets();
    const handle = this.lookup(name);
    if (!handle) throw new Error(`cannot issue an attach capability for "${name}": no such running agent`);
    if (handle !== expected)
      throw new Error(`cannot issue an attach capability for "${name}": it was replaced during authorization`);
    const ticket = randomBytes(32).toString("hex");
    this.#tickets.set(ticket, { name, handle: expected, expires: Date.now() + ATTACH_TICKET_TTL_MS });
    return `ws://${this.#advertised}:${this.#port}/attach/${encodeURIComponent(name)}?t=${ticket}`;
  }

  /** The console page URL. The token rides the FRAGMENT, which a browser never sends to a server:
   *  it stays out of this endpoint's request handling, out of any proxy's logs, and out of the
   *  `Referer` a click on the page would otherwise leak. The page reads it from `location.hash` and
   *  keeps it in memory. (It is still printed to the manager's own log, which is the operator's own
   *  file — see the class note.) */
  consoleUrl(): string {
    return `http://${this.#advertised}:${this.#port}/#t=${this.token}`;
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      const path = (req.url ?? "/").split("?")[0];
      // Every DATA route is credentialed: the managed roster and the live mesh feed both describe
      // real agents. The console shell (its HTML, its script, the vendored xterm assets) is static
      // and carries nothing about this mesh, so it stays open — that is what lets the page load and
      // then present the token, held in memory from its own URL, on the requests that do matter.
      //
      // Deliberately NOT a cookie. Cookies are host-scoped, not port-scoped: a `cotal_attach` cookie
      // set by a manager on one port would be sent by the browser to EVERY other HTTP service on
      // that host, handing a terminal credential to anything the operator happens to visit, and two
      // managers on one host would silently overwrite each other's. `Secure` fixes neither, and is
      // unavailable over plain HTTP anyway.
      // The console shell must not be cached or leak a referrer: the page holds a terminal-capable
      // credential in memory, and a stale cached copy would keep working against a restarted
      // manager whose token has rotated.
      if (PAGE[path]) {
        res.setHeader("cache-control", "no-store");
        res.setHeader("referrer-policy", "no-referrer");
      }
      if (path === "/agents" || path === "/feed") {
        if (!this.#authorized(req)) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized - this endpoint requires the manager's console token");
          return;
        }
      }
      if (path === "/agents") {
        const body = JSON.stringify(this.list());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      if (path === "/feed") {
        this.#openFeed(res);
        return;
      }
      const file = PAGE[path] ?? ASSETS[path];
      if (file) {
        this.#serveFile(res, file.path, file.type);
        return;
      }
      res.writeHead(404).end("not found");
    } catch {
      // Last-resort guard: a stray/malformed request must never kill the manager.
      try {
        if (!res.headersSent) res.writeHead(500);
        res.end("internal error");
      } catch {
        /* response already torn down */
      }
    }
  }

  #serveFile(res: ServerResponse, file: string, type: string): void {
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": type });
      res.end(body);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        res.writeHead(404).end("not found");
        return;
      }
      console.error(`manager console failed to serve ${file}:`, err);
      res.writeHead(500).end("internal error");
    }
  }

  /** Open an SSE stream, replay the snapshot, and keep it on the broadcast set. */
  #openFeed(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    this.#sse.add(res);
    try {
      for (const ev of this.snapshot()) this.#writeEvent(res, ev.event, ev.data);
    } catch {
      /* mesh not up yet — the console will get live events once it is */
    }
    res.on("close", () => this.#sse.delete(res));
  }

  #writeEvent(res: ServerResponse, event: string, data: unknown): void {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async #onConnection(ws: WebSocket, name: string): Promise<void> {
    const handle = this.lookup(name);
    if (!handle || handle.status() !== "running") {
      ws.close();
      return;
    }
    // Only streamable backends (pty/host) can be attached over the wire; external runtimes are watched
    // natively and their attach() throws. Close cleanly instead of letting it crash the upgrade.
    let session: AttachSession;
    try {
      session = handle.attach();
    } catch {
      ws.close(1011, `attach unsupported for the ${handle.kind} runtime - watch its surface directly`);
      return;
    }

    const send = (b: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(b);
    };
    // Subscribe to live output BEFORE requesting the snapshot, and buffer what arrives until the
    // snapshot is sent. The snapshot (below) is a point-in-time screen image; anything the child
    // emits after it must land after it, in order. Subscribing first (no await in between) means no
    // chunk can slip through unobserved, and the buffer stops a mid-snapshot burst from racing ahead
    // of — or being lost before — the image.
    let live = false;
    const buffered: Buffer[] = [];
    const offData = session.onData((chunk) => {
      if (live) send(chunk);
      else buffered.push(chunk);
    });
    const offExit = session.onExit(() => ws.close());
    // Wire input + cleanup now too, so the client's initial `r:cols,rows` (and any early keystrokes)
    // during the snapshot await aren't dropped, and a disconnect mid-await still unsubscribes.
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        session.write((data as Buffer).toString("utf8"));
        return;
      }
      const text = data.toString();
      const m = /^r:(\d+),(\d+)$/.exec(text);
      if (!m) {
        session.write(text);
        return;
      }
      session.resize(Number(m[1]), Number(m[2]));
    });
    ws.on("close", () => {
      offData();
      offExit();
    });

    // Reconstructed screen image: the backend replays a byte-exact snapshot — including the
    // alternate-screen buffer of a full-screen TUI (OpenCode/Claude) — so a late or concurrent attach
    // paints correctly without depending on the child to repaint. (Raw scrollback replay couldn't
    // rebuild an alt-screen, leaving same-size re/co-attaches a partial screen.) Then flush anything
    // that arrived while we built it, and switch to sending live output straight through.
    let snapshot: Buffer;
    try {
      snapshot = await session.backlog();
    } catch {
      ws.close(1011, "attach snapshot failed");
      return;
    }
    if (snapshot.length) send(snapshot);
    for (const chunk of buffered) send(chunk);
    live = true; // snapshot delivered — stream subsequent output straight through
  }
}
