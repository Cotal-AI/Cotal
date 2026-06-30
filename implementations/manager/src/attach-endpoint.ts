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

/** One Server-Sent-Events frame: a named event carrying JSON data. */
export interface FeedEvent {
  event: string;
  data: unknown;
}

/**
 * The manager's local HTTP + WebSocket face. It hosts the **console** (a
 * lightweight xterm.js page) and bridges each agent's PTY to the browser — and to
 * `cotal attach` — over a direct socket, never the mesh, so owning the terminal
 * keeps the manager off the message hot path. Bound to loopback.
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
  #sse = new Set<ServerResponse>();
  #ping?: ReturnType<typeof setInterval>;

  constructor(
    private readonly lookup: (name: string) => AgentHandle | undefined,
    private readonly list: () => unknown,
    /** Events replayed to each console as it connects to `/feed` (e.g. the current roster). */
    private readonly snapshot: () => FeedEvent[],
    port = 0,
  ) {
    this.#port = port;
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
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, name));
    });
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
    for (const ws of this.#wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  /** Push a named event to every connected console (SSE). */
  publish(event: string, data: unknown): void {
    for (const res of this.#sse) this.#writeEvent(res, event, data);
  }

  /** The ws URL a client uses to attach to `name`. */
  url(name: string): string {
    return `ws://127.0.0.1:${this.#port}/attach/${encodeURIComponent(name)}`;
  }

  /** The console page URL. */
  consoleUrl(): string {
    return `http://127.0.0.1:${this.#port}/`;
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      const path = (req.url ?? "/").split("?")[0];
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

  #onConnection(ws: WebSocket, name: string): void {
    const handle = this.lookup(name);
    if (!handle || handle.status() !== "running") {
      ws.close();
      return;
    }
    // Only streamable backends (pty/host) can be attached over the wire; tmux/cmux are watched
    // natively and their attach() throws. Close cleanly instead of letting it crash the upgrade.
    let session: AttachSession;
    try {
      session = handle.attach();
    } catch {
      ws.close(1011, `attach unsupported for the ${handle.kind} runtime — watch its surface directly`);
      return;
    }

    const backlog = session.backlog();
    if (backlog.length) ws.send(backlog);

    const offData = session.onData((chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    const offExit = session.onExit(() => ws.close());

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        session.write((data as Buffer).toString("utf8"));
        return;
      }
      const text = data.toString();
      const m = /^r:(\d+),(\d+)$/.exec(text);
      if (m) session.resize(Number(m[1]), Number(m[2]));
      else session.write(text);
    });
    ws.on("close", () => {
      offData();
      offExit();
    });
  }
}
