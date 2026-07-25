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
  return new URL(first).hostname || "127.0.0.1";
}

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
 * **Where it binds, and why it needs a token.** A mesh can span machines: the manager that owns an
 * agent's PTY may sit on another host than the operator running `cotal attach`. So this endpoint
 * binds the SAME address the mesh's broker is bound to and advertises that address in its URLs — a
 * loopback mesh keeps a loopback-only console (unchanged), and a mesh the operator deliberately
 * exposed gets an attach face reachable from the same places. Hardcoding `127.0.0.1` instead made
 * every remote attach fail with ECONNREFUSED against the *client's own* loopback.
 *
 * That reachability is exactly why the whole surface is credentialed. This face carries terminal
 * READ AND WRITE for every managed agent, so once it can leave the box, "unauthenticated but
 * loopback-only" stops being a safe position. Every route, the WS upgrade included, requires the
 * endpoint token: the CLI receives it inside the attach URL over the already-authenticated and
 * authorized mesh control plane, and a browser gets it once via `?t=` on the console URL and
 * carries it thereafter in a same-origin cookie. No unauthenticated path, and no bind-dependent
 * branch — a loopback endpoint checks the token exactly like a remote one.
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
      // The PTY stream is terminal read+write: no token, no upgrade. Checked before the agent name
      // is even resolved, so an unauthenticated caller cannot probe which agents exist.
      if (!this.#authorized(req)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      let name: string;
      try {
        name = decodeURIComponent(path.slice("/attach/".length));
      } catch {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#onConnection(ws, name).catch(() => ws.close());
      });
    });
  }

  /** Constant-time check of the endpoint token, taken from `?t=`, the same-origin cookie the console
   *  page is served with, or a bearer header. Length-mismatched candidates are rejected before
   *  `timingSafeEqual`, which throws on unequal lengths. */
  #authorized(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cookie = /(?:^|;\s*)cotal_attach=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const presented = url.searchParams.get("t") ?? cookie ?? bearer;
    if (!presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
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

  /** The ws URL a client uses to attach to `name`. Carries the endpoint token: this URL only ever
   *  travels as the reply to an authenticated, authorized control-plane `attach` request. */
  url(name: string): string {
    return `ws://${this.#advertised}:${this.#port}/attach/${encodeURIComponent(name)}?t=${this.token}`;
  }

  /** The console page URL. The token rides the query once; the page is served with a cookie that
   *  carries it on every later request from that browser. */
  consoleUrl(): string {
    return `http://${this.#advertised}:${this.#port}/?t=${this.token}`;
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      const path = (req.url ?? "/").split("?")[0];
      // Every route is credentialed — the roster, the live feed, and the console that can drive any
      // agent's terminal. Rejected before anything is read or served.
      if (!this.#authorized(req)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("unauthorized - this endpoint requires the manager's attach token");
        return;
      }
      // The console page is the one entry point a human opens by URL, so it is where the browser
      // picks up the credential: token in the query once, then a same-origin cookie that carries it
      // on every later asset, /agents, /feed, and WS upgrade. HttpOnly so page scripts can't read
      // it back out; SameSite=Strict so another origin can never drive a cross-site request with it.
      if (path === "/" && new URL(req.url ?? "/", "http://localhost").searchParams.get("t"))
        res.setHeader("set-cookie", `cotal_attach=${this.token}; Path=/; HttpOnly; SameSite=Strict`);
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
