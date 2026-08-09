import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EpEnvelopeError } from "@cotal-ai/core";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Vendored xterm.js assets (served from node_modules, resolved at startup). */
const ASSETS: Record<string, { path: string; type: string }> = {
  "/assets/xterm.js": { path: require.resolve("@xterm/xterm/lib/xterm.js"), type: "text/javascript" },
  "/assets/xterm.css": { path: require.resolve("@xterm/xterm/css/xterm.css"), type: "text/css" },
  "/assets/addon-fit.js": { path: require.resolve("@xterm/addon-fit/lib/addon-fit.js"), type: "text/javascript" },
  "/assets/addon-attach.js": { path: require.resolve("@xterm/addon-attach/lib/addon-attach.js"), type: "text/javascript" },
};

/** Anything the console page needs to render itself, served from this dir. `session-bundle.js` is
 *  the pre-built (esbuild) mesh §13.6 session client — present only in a built dist, so the page
 *  falls back to a clear "bundle not loaded" notice when running from source (P2 item 6). */
const PAGE: Record<string, { path: string; type: string }> = {
  "/": { path: join(here, "console/index.html"), type: "text/html" },
  "/app.js": { path: join(here, "console/app.js"), type: "text/javascript" },
  "/session-bundle.js": { path: join(here, "console/session-bundle.js"), type: "text/javascript" },
};

/**
 * The address the console endpoint binds and advertises, derived from a mesh broker URL.
 *
 * With no server URL there is no mesh address to follow, so this is loopback: the conservative
 * default. An unparseable URL is a caller bug and throws rather than quietly binding somewhere the
 * operator did not ask for.
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

/** One Server-Sent-Events frame: a named event carrying JSON data. */
export interface FeedEvent {
  event: string;
  data: unknown;
}

/** What `POST /session/<name>` returns: the console's mesh §13.6 session establishment (P2 item 6).
 *  The `grant` is the holder-bound offer (no ws:// URL, non-bearer); `wsUrl` is the broker's
 *  localhost websocket listener; `creds` is the per-session, rails-only session-caller credential the
 *  browser connects with. NO 127.0.0.1 terminal transport — the terminal rides the mesh session. */
export interface SessionEstablishment {
  grant: unknown;
  wsUrl: string;
  creds: string;
}

/** The manager-injected session establisher (P2 item 6): given a managed agent name, mint the offer
 *  through the ONE {@link import("./session/plane.js").ManagerSessionPlane} + the per-session caller
 *  credential, and return what the browser needs to connect. INJECTED — the face never constructs a
 *  plane; the manager wires the single plane + the cred mint at boot (6b-2). Absent ⇒ the route 503s
 *  (an open mesh with no console session client, or the pre-6b-2 stub). */
export type SessionEstablisher = (name: string) => Promise<SessionEstablishment>;

/**
 * The manager's local HTTP face. It serves the **console** (a lightweight xterm.js page + its
 * assets) and is the browser's credential broker: `POST /session/<name>` mints a mesh §13.6 session
 * for the console to drive the terminal over the broker's WebSocket listener. The terminal never
 * rides a manager-hosted socket (P2 item 6 replaced the loopback `ws://.../attach/` transport with
 * the mesh session, closing the bearer-less-local hole) — `cotal attach` reaches a manager on
 * another machine over the mesh, not by dialing this face.
 *
 * **Where it binds, and why it is credentialed.** The bind address is an explicit option (default
 * loopback, so nothing is exposed by accident); `cotal up` passes the address it bound the broker
 * to when the operator asked for an exposed console. A broker DIAL address is deliberately NOT used
 * as the bind: a manager may supervise a broker on another host and could not bind that address at
 * all. Where the manager can only name loopback (a wildcard bind), it advertises loopback.
 *
 * Reachability is why the surface is credentialed. It carries the managed roster, the live mesh
 * feed, and — through `POST /session/<name>` — the mint of a real §13.6 session grant plus its
 * per-session caller credential. Once the face can leave the box, "unauthenticated but
 * loopback-only" stops being a safe position, so every DATA route requires the manager's console
 * token. The console SHELL (its HTML, its script, the vendored xterm assets) is static and carries
 * nothing about this mesh, so it stays open — that is what lets the page load and then present the
 * token, held in memory from its own URL, on the requests that do matter.
 *
 * The credential travels in `?t=` or a bearer header, never a cookie: cookies are host-scoped, not
 * port-scoped, so one set here would be sent to every other HTTP service on this host and would
 * collide between two managers on one box. The console URL carries its token in the FRAGMENT, which
 * a browser never sends to a server.
 *
 * Routes: `GET /` console page + `/app.js` + `/session-bundle.js` + `/assets/*`; `GET /agents` the
 * managed roster (JSON); `GET /feed` the live mesh feed (SSE: presence roster + comms);
 * `POST /session/<name>` the mesh session establishment.
 */
export class AttachEndpoint {
  #http: Server;
  #port: number;
  #host: string;
  #sse = new Set<ServerResponse>();
  #ping?: ReturnType<typeof setInterval>;

  constructor(
    private readonly list: () => unknown,
    /** Events replayed to each console as it connects to `/feed` (e.g. the current roster). */
    private readonly snapshot: () => FeedEvent[],
    port = 0,
    /** P2 item 6: the manager-injected mesh-session establisher backing `POST /session/<name>`
     *  (the console's session-client transport). Absent ⇒ the route 503s. Wired at 6b-2. */
    private readonly establishSession?: SessionEstablisher,
    /** Bind address, and the host advertised in {@link consoleUrl}. Defaults to loopback; the
     *  manager passes an operator-chosen address when the console is meant to be reachable from
     *  another machine. A wildcard bind still advertises loopback, since a wildcard is not a
     *  dialable name. */
    host = "127.0.0.1",
    /** The endpoint credential. Generated per manager process; required on every data route. */
    private readonly token: string = randomBytes(32).toString("hex"),
  ) {
    // A blank credential is the fail-OPEN shape of this gate, and it would only ever be consulted on
    // the dangerous path. Refuse it at CONSTRUCTION, not at request time: an endpoint that cannot be
    // credentialed must not exist rather than serve the roster, the feed and the session mint to
    // anyone who can reach the bind host. (The default above means "no token configured" is already
    // a fresh per-process secret; this closes the one way a caller could ask for none.)
    if (!token) throw new Error("AttachEndpoint: refusing to serve without a console token - the roster, the feed and the session mint are all credentialed on it");
    this.#port = port;
    this.#host = host;
    this.#http = createServer((req, res) => this.#onRequest(req, res));
    // HTTP-only face: refuse any WebSocket upgrade with a clean 400 (P2 item 6 removed the loopback
    // `ws://.../attach/` terminal transport — the console drives the terminal over the mesh session).
    // A proper response beats leaving a stray/malformed upgrade hanging or resetting it abruptly.
    this.#http.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
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

  /** The operator's own console credential. It reaches every managed agent, because the console
   *  legitimately drives all of them, and it is printed solely to this manager process's output (so
   *  it is as sensitive as `.cotal/manager.log`, and never handed to a mesh caller). */
  #authorized(req: IncomingMessage): boolean {
    return this.#sameSecret(this.#presented(req), this.token);
  }

  async start(): Promise<void> {
    // The bind host is the operator's explicit choice. A manager asked to bind an address this
    // machine does not own dies deep inside startup with a bare errno; say so in operator terms
    // instead — the address is the diagnosis.
    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRNOTAVAIL" || e.code === "EADDRINUSE") {
          reject(
            new Error(
              e.code === "EADDRINUSE"
                ? `the manager's console endpoint cannot bind ${this.#host}:${this.#port} - that port is already in use on this host`
                : `the manager's console endpoint cannot bind ${this.#host} - this machine has no such address. Give this manager a console host it owns, or leave it on loopback.`,
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
      // The console shell must not be cached or leak a referrer: the page holds the console
      // credential in memory, and a stale cached copy would keep working against a restarted
      // manager whose token has rotated.
      if (PAGE[path]) {
        res.setHeader("cache-control", "no-store");
        res.setHeader("referrer-policy", "no-referrer");
      }
      // Every DATA route is credentialed. The roster and the live feed describe real agents, and
      // `POST /session/` MINTS a §13.6 grant plus a per-session caller credential — the most
      // sensitive thing this face does. Loopback alone stopped being the trust boundary once the
      // bind host became an operator choice, so the token gate is unconditional.
      if (path === "/agents" || path === "/feed" || path.startsWith("/session/")) {
        if (!this.#authorized(req)) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized - this endpoint requires the manager's console token");
          return;
        }
      }
      // P2 item 6: the console's mesh §13.6 session establishment. `POST /session/<name>` mints the
      // holder-bound offer + the per-session caller credential (via the injected establisher) and
      // returns {grant, wsUrl, creds} for the browser to open the caller rail — no ws:// terminal
      // transport in the reply.
      if (path.startsWith("/session/")) {
        this.#onSession(req, res, path);
        return;
      }
      // Browsers request the favicon unprompted; answer 204 so it isn't a noisy 404 in the console.
      if (path === "/favicon.ico") {
        res.writeHead(204).end();
        return;
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

  /** `POST /session/<name>` (P2 item 6): establish a mesh §13.6 session for the console and return
   *  {grant, wsUrl, creds}. POST because it has side effects (it mints a one-use offer + a
   *  per-session credential). 503 when no establisher is wired (open mesh / pre-6b-2). */
  #onSession(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end("method not allowed");
      return;
    }
    if (!this.establishSession) {
      res.writeHead(503).end("mesh session establishment is not available (open mesh, or not yet wired)");
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(path.slice("/session/".length));
    } catch {
      res.writeHead(400).end("bad agent name");
      return;
    }
    if (!name) {
      res.writeHead(400).end("missing agent name");
      return;
    }
    this.establishSession(name)
      .then((est) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(est));
      })
      .catch((e) => {
        // A CAPACITY refusal is not an internal fault, and the browser has to be able to tell them
        // apart: the live-session ceiling is a bounded, retryable condition (429), while a 500 says
        // the manager broke. Both carry the envelope `code`, so the page branches on a stable token
        // rather than on message text.
        const code = e instanceof EpEnvelopeError ? e.code : undefined;
        const status = code === "resource-exhausted" ? 429 : 500;
        if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message, ...(code ? { code } : {}) }));
      });
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
}
