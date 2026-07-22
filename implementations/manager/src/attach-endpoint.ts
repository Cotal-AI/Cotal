import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
 * assets) and is the browser's loopback credential broker: `POST /session/<name>` mints a mesh
 * §13.6 session for the console to drive the terminal over the broker's WebSocket listener. The
 * terminal never rides a manager-hosted socket (P2 item 6 replaced the loopback `ws://.../attach/`
 * transport with the mesh session, closing the bearer-less-local hole). Bound to loopback.
 *
 * Routes: `GET /` console page + `/app.js` + `/session-bundle.js` + `/assets/*`; `GET /agents` the
 * managed roster (JSON); `GET /feed` the live mesh feed (SSE: presence roster + comms);
 * `POST /session/<name>` the mesh session establishment.
 */
export class AttachEndpoint {
  #http: Server;
  #port: number;
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
  ) {
    this.#port = port;
    this.#http = createServer((req, res) => this.#onRequest(req, res));
    // HTTP-only face: refuse any WebSocket upgrade with a clean 400 (P2 item 6 removed the loopback
    // `ws://.../attach/` terminal transport — the console drives the terminal over the mesh session).
    // A proper response beats leaving a stray/malformed upgrade hanging or resetting it abruptly.
    this.#http.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#http.listen(this.#port, "127.0.0.1", resolve));
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

  /** The console page URL. */
  consoleUrl(): string {
    return `http://127.0.0.1:${this.#port}/`;
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      const path = (req.url ?? "/").split("?")[0];
      // P2 item 6: the console's mesh §13.6 session establishment. `POST /session/<name>` mints the
      // holder-bound offer + the per-session caller credential (via the injected establisher) and
      // returns {grant, wsUrl, creds} for the browser to open the caller rail — no ws:// terminal
      // transport in the reply. Loopback + same-host operator is the trust boundary here.
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
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
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
