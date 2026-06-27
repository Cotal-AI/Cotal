/**
 * The connector's local control plane: a unix-socket server the lifecycle hooks
 * talk to. Hooks are dumb relays — they forward the raw runtime event JSON (which
 * carries `hook_event_name`) and print whatever we reply. All the logic lives here,
 * in-process, because this is where the live mesh endpoint is.
 *
 * The socket plumbing is platform-agnostic; each connector passes a {@link HookHandle}
 * that maps its runtime's events to presence changes + (for inject-capable events)
 * queued peer messages, in that runtime's own hook-output shape.
 */
import { createServer, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import type { MeshAgent, InboxItem } from "./agent.js";

/** One lifecycle event, as the agent runtime delivers it on stdin. */
export interface HookEvent {
  hook_event_name?: string;
  [k: string]: unknown;
}

/** Maps one hook event to the JSON reply the runtime applies. */
export type HookHandle = (agent: MeshAgent, ev: HookEvent) => Promise<Record<string, unknown>>;

/** The authenticated control-plane wire frame (one newline-delimited JSON object per connection):
 *  a hook event the runtime delivered, or the manager's cooperative shutdown — both carry the
 *  endpoint `token` as their first field, validated before anything else runs. Shutdown is an
 *  explicit op, NOT a disguised hook event. */
type ControlFrame =
  | { token?: unknown; event?: unknown; op?: undefined }
  | { token?: unknown; op?: "shutdown" };

export interface ControlServerOpts {
  /** Fail loud on a bind we can't hold. A managed listener (the in-agent MCP server, the Hermes
   *  sidecar) MUST own its endpoint: if `listen` errors (e.g. a squatter already holds the win32
   *  pipe → `EADDRINUSE`; libuv binds with `FILE_FLAG_FIRST_PIPE_INSTANCE`), the process exits
   *  rather than running on with a hijacked or no-op control plane. Default off (an ad-hoc/test
   *  server logs and stays up). */
  fatalBind?: boolean;
  /** Cooperative shutdown: invoked on an AUTHENTICATED `{op:"shutdown"}` frame. The connector runs
   *  its own clean teardown (close the server, `agent.stop()` to leave the mesh, then exit) — the
   *  server never owns `process.exit`. Absent → shutdown frames are accepted + acked but inert. */
  onShutdown?: () => void;
}

/** Constant-time match of a presented token against the endpoint's. Both sides are SHA-256'd first
 *  so the compare is fixed-length (and length-independent) regardless of the presented value — a
 *  non-string or wrong-length token can never throw `timingSafeEqual` or leak length via timing. */
function tokenMatches(presented: unknown, digest: Buffer): boolean {
  if (typeof presented !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(presented).digest(), digest);
}

function who(i: InboxItem): string {
  return i.fromRole ? `${i.fromName}/${i.fromRole}` : i.fromName;
}

function fmtItem(i: InboxItem): string {
  const h = i.historical ? " (history)" : ""; // backfilled on join — pre-dates you, not live
  if (i.kind === "dm") return `• DM from ${who(i)}${h}: ${i.text}`;
  if (i.kind === "anycast") return `• @${i.service} (from ${who(i)})${h}: ${i.text}`;
  return `• #${i.channel} ${who(i)}${h}: ${i.text}`;
}

/** The context block injected into a turn when peer messages are waiting (else undefined). */
export function formatInjection(items: InboxItem[]): string | undefined {
  if (!items.length) return undefined;
  const head = `📨 Cotal — ${items.length} new message${items.length === 1 ? "" : "s"} from peers:`;
  const tail = `(Reply with cotal_send / cotal_dm, or cotal_roster to see who's here.)`;
  return `${head}\n${items.map(fmtItem).join("\n")}\n${tail}`;
}

/** Start the authenticated control server. One newline-delimited JSON {@link ControlFrame} → one
 *  reply per connection. The first thing every connection does is validate its `token` against the
 *  endpoint's (constant-time) — a mismatch is dropped before `handle` (or `onShutdown`) ever runs,
 *  so an unauthenticated local process that finds/guesses the path still can't drive presence,
 *  inject peer messages, or shut the agent down. */
export function startControlServer(
  agent: MeshAgent,
  endpoint: { path: string; token: string },
  handle: HookHandle,
  opts: ControlServerOpts = {},
): Server {
  const { path } = endpoint;
  const digest = createHash("sha256").update(endpoint.token).digest();
  // Stale-socket cleanup is POSIX-only: a win32 named pipe is not a filesystem entry to unlink, and
  // a live one there is a SQUATTER the fatal `EADDRINUSE` is meant to catch — never clear it. (With
  // a token-random path a stale POSIX socket from a dead predecessor is itself near-impossible, but
  // the unlink stays as cheap insurance against an exact-path leftover.)
  if (process.platform !== "win32" && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
  const server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return; // wait for the full line
      let frame: ControlFrame = {};
      try {
        frame = JSON.parse(buf.slice(0, nl) || "{}") as ControlFrame;
      } catch {
        /* malformed — fails the auth check below and is dropped */
      }
      if (!tokenMatches(frame.token, digest)) {
        sock.end(); // unauthenticated — drop before handle/onShutdown
        return;
      }
      if ((frame as { op?: unknown }).op === "shutdown") {
        try {
          sock.end(JSON.stringify({ ok: true }) + "\n");
        } catch {
          /* client gone */
        }
        opts.onShutdown?.();
        return;
      }
      const ev = ((frame as { event?: unknown }).event ?? {}) as HookEvent;
      const reply = await handle(agent, ev);
      try {
        sock.end(JSON.stringify(reply) + "\n");
      } catch {
        /* client gone */
      }
    });
    sock.on("error", () => {
      /* ignore client errors */
    });
  });
  let bound = false;
  server.on("error", (e) => {
    process.stderr.write(`[cotal-connector] control server error: ${(e as Error).message}\n`);
    // A bind we never held (listen errored before "listening", e.g. EADDRINUSE from a squatter) is
    // fatal for a managed listener — better to die than serve a hijacked/no-op control plane. A
    // post-bind error is just logged.
    if (opts.fatalBind && !bound) process.exit(1);
  });
  server.listen(path, () => {
    bound = true;
    process.stderr.write(`[cotal-connector] control socket: ${path}\n`); // path is leakage-safe; the token never logs
  });
  return server;
}
