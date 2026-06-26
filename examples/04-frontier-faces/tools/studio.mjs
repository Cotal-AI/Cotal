#!/usr/bin/env node
// studio.mjs — the frontier-faces mesh as a live web app. One command brings up the whole thing:
//
//   node tools/studio.mjs                 # curated roster
//   node tools/studio.mjs sven david elon # explicit agents (agent-file basenames)
//   SPACE=demo PORT=4097 node tools/studio.mjs
//
// What it does, end to end — NO scripting, all real agents on a real mesh:
//   1. ensures a Cotal mesh is up (starts `cotal up --open` if one isn't);
//   2. joins it as an operator endpoint ("you") — the human seat in the room;
//   3. spawns each roster member as a REAL headless mesh agent (OpenCode + the cotal plugin),
//      capturing its private OpenCode server {port, session, password};
//   4. serves a browser studio that renders each agent's animated pixel face driven by that
//      agent's live OpenCode stream, plus the authoritative mesh transcript (what the operator
//      endpoint actually receives) and a prompt box that posts into #general.
//
// Type into the studio → the operator posts to #general → every agent's connector turns it into
// an OpenCode turn → they reply and coordinate over the mesh → you watch their faces talk.
//
// Requires: node, opencode (`opencode auth login`), and a built repo (`pnpm build`).

import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { CotalEndpoint } from "@cotal-ai/core";

// ---- paths + config -------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const EX = join(HERE, ".."); // the example dir (serves web/, personas.mjs, qr-cotal.mjs)
const ROOT = join(EX, "..", ".."); // repo root (agent data dirs live under ROOT/.cotal/opencode/<name>)
const CONN = join(ROOT, "extensions", "connector-opencode", "dist");
const SERVE = join(CONN, "serve.js");
const PLUGIN = join(CONN, "plugin.bundle.js");

const SPACE = process.env.SPACE || "demo";
const SERVERS = process.env.COTAL_SERVERS || "nats://127.0.0.1:4222";
const PORT = Number(process.env.PORT || 4097);
const MODEL = process.env.MODEL || ""; // overrides each agent file's model
const MAX = 9;
const DEFAULT_ROSTER = ["sven", "david", "garry", "elon"];

const log = (...a) => console.error("\x1b[36m[studio]\x1b[0m", ...a);
const warn = (...a) => console.error("\x1b[33m[studio]\x1b[0m", ...a);

// ---- roster resolution ----------------------------------------------------------------------
let roster = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (roster.length === 0) roster = DEFAULT_ROSTER;
if (roster.length > MAX) {
  warn(`capping roster at ${MAX} (got ${roster.length})`);
  roster = roster.slice(0, MAX);
}

/** Read an agent file's `face:` (persona) and `model:` from its frontmatter — same mapping the
 *  terminal wall uses (elon→musk, steve→jobs, rayan→ray). */
function agentMeta(name) {
  const file = join(EX, "agents", `${name}.md`);
  if (!existsSync(file)) throw new Error(`no agent file agents/${name}.md (try a basename from agents/)`);
  const head = readFileSync(file, "utf8");
  const face = head.match(/^face:\s*(\S+)/m)?.[1] || name;
  const role = head.match(/^role:\s*(.+)$/m)?.[1]?.trim() || "";
  const model = MODEL || head.match(/^model:\s*(\S+)/m)?.[1] || "";
  return { file, persona: face, role, model };
}

// ---- mesh + agent lifecycle -----------------------------------------------------------------
function reachable(url, timeoutMs = 800) {
  const { hostname, port } = new URL(url.replace(/^nats:/, "http:"));
  return new Promise((resolve) => {
    const sock = netConnect({ host: hostname, port: Number(port) }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let meshProc = null; // set only if WE started the mesh (so teardown stops it)

async function ensureMesh() {
  if (await reachable(SERVERS)) {
    log(`mesh already up on ${SERVERS} — reusing`);
    return { reused: true };
  }
  log(`starting mesh: cotal up --open --space ${SPACE} --server ${SERVERS}`);
  meshProc = spawn("pnpm", ["cotal", "up", "--open", "--space", SPACE, "--server", SERVERS], {
    cwd: ROOT,
    detached: true, // own process group → teardown can reap nats-server too
    stdio: "ignore",
  });
  meshProc.on("exit", (code) => {
    if (!shuttingDown) warn(`mesh process exited (code ${code})`);
  });
  for (let i = 0; i < 80; i++) {
    if (await reachable(SERVERS)) {
      log("mesh up");
      return { reused: false };
    }
    await sleep(250);
  }
  throw new Error("mesh did not come up within 20s");
}

/** Wipe the space's retained chat history so a fresh boot starts clean — no replayed backlog for
 *  the agents to react to (which both clutters the feed and biases the model toward old, long
 *  messages). Best-effort: a brand-new mesh has nothing to clear. */
async function clearHistory() {
  log(`fresh boot — clearing chat history on space "${SPACE}"`);
  await new Promise((resolve) => {
    const p = spawn("pnpm", ["cotal", "history", "clear", "--force", "--dms", "--space", SPACE], {
      cwd: ROOT,
      stdio: "ignore",
    });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
}

const agents = []; // { name, persona, role, model, child, port, session, password }

/** Spawn ONE real mesh agent headlessly and resolve once its OpenCode handshake lands. */
function spawnAgent(name) {
  const { file, persona, role, model } = agentMeta(name);
  const env = {
    ...process.env,
    COTAL_SERVE_HEADLESS: "1",
    COTAL_SPACE: SPACE,
    COTAL_NAME: name,
    COTAL_SERVERS: SERVERS,
    COTAL_AGENT_FILE: file,
    COTAL_OPENCODE_HOME: ROOT,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      permission: "allow",
      plugin: [PLUGIN],
      ...(model ? { model } : {}),
    }),
  };
  const child = spawn(process.execPath, [SERVE], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });

  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent "${name}" never handed back its server (~75s)`));
    }, 75_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/\[cotal-serve\] (\{.*\})/);
      if (!m) return;
      clearTimeout(timer);
      let hs;
      try {
        hs = JSON.parse(m[1]);
      } catch (e) {
        return reject(new Error(`agent "${name}" sent a bad handshake: ${e.message}`));
      }
      const rec = { name, persona, role, model: model || "default", child, ...hs };
      agents.push(rec);
      log(`agent ${name} joined (face=${persona}, opencode :${hs.port}, session ${hs.session.slice(0, 12)}…)`);
      resolve(rec);
    });
    // Forward the agent's boot/error log to our stderr, dimmed and name-prefixed, for debugging.
    child.stderr.setEncoding("utf8");
    let errbuf = "";
    child.stderr.on("data", (d) => {
      errbuf += d;
      let i;
      while ((i = errbuf.indexOf("\n")) >= 0) {
        const line = errbuf.slice(0, i);
        errbuf = errbuf.slice(i + 1);
        if (line.trim()) process.stderr.write(`\x1b[90m  ${name} | ${line}\x1b[0m\n`);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const rec = agents.find((a) => a.name === name);
      if (rec) rec.dead = true;
      if (!shuttingDown) warn(`agent ${name} exited (code ${code})`);
    });
  });
}

// ---- operator endpoint (the human seat) -----------------------------------------------------
let ep = null;
const feedClients = new Set(); // open SSE responses
const recent = []; // last N transcript events for late-joining browsers
let roomRoster = [];
const peerIds = new Map(); // agent name -> live instance id (from presence), for direct messages

function pushFeed(ev) {
  if (ev.type === "msg") {
    recent.push(ev);
    if (recent.length > 80) recent.shift();
  }
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of feedClients) {
    try {
      res.write(line);
    } catch {
      /* client gone; reaped on 'close' */
    }
  }
}

// Strip stray model-leaked pseudo-tags (e.g. a hallucinated `</MESSAGE-v0>` envelope or a leftover
// `[[face:x]]`) so the transcript stays clean.
const clean = (t) => t.replace(/<\/?[A-Z][A-Z0-9-]*>/g, "").replace(/\[\[\s*face\s*:[^\]]*\]\]/gi, "").trim();
const textOf = (msg) => clean(msg.parts.filter((p) => p.kind === "text").map((p) => p.text).join(""));

function normalizeMsg(msg, meta) {
  return {
    type: "msg",
    id: msg.id,
    kind: meta?.kind || "channel",
    historical: !!meta?.historical,
    from: msg.from?.name || "?",
    role: msg.from?.role || "",
    channel: msg.channel,
    to: msg.to,
    toService: msg.toService,
    text: textOf(msg),
    ts: msg.ts,
  };
}

async function startOperator(reused) {
  ep = new CotalEndpoint({
    space: SPACE,
    servers: SERVERS,
    card: { name: "you", kind: "endpoint", role: "host" },
    channels: ["general"],
    consume: true, // we want every message
    registerPresence: true, // appear in the room as "you"
    watchPresence: true,
  });
  ep.on("error", (e) => warn("endpoint error:", e?.message || e));
  ep.on("message", (msg, delivery, meta) => {
    delivery?.ack?.();
    // Show only this session's live traffic — never the durable backlog replayed on connect.
    if (!meta?.historical) pushFeed(normalizeMsg(msg, meta));
  });
  ep.on("roster", (r) => {
    roomRoster = r.map((p) => ({
      name: p.card.name,
      role: p.card.role || "",
      kind: p.card.kind,
      status: p.status,
      activity: p.activity || "",
    }));
    for (const p of r) if (p.card.name !== "you") peerIds.set(p.card.name, p.card.id);
    pushFeed({ type: "roster", roster: roomRoster });
  });
  try {
    await ep.start();
  } catch (e) {
    // Stop the failed endpoint so it can't reconnect-loop in the background.
    try {
      await ep.stop();
    } catch {
      /* ignore */
    }
    ep = null;
    // The common case: an auth mesh is already on this port (the studio needs an --open mesh).
    // Fail loud with a copy-pasteable fix rather than silently spinning up a divergent mesh.
    if (reused)
      throw new Error(
        `a mesh is already running on ${SERVERS}, but it rejected the studio's connection ` +
          `(${e?.message || e}). The studio needs an --open mesh.\n` +
          `  Fix: stop it with \`pnpm cotal down\` and retry, or run the studio on its own free port + space:\n` +
          `    SPACE=frontier COTAL_SERVERS=nats://127.0.0.1:4299 node tools/studio.mjs ${roster.join(" ")}`,
      );
    throw e;
  }
  log(`operator "you" joined space "${SPACE}"`);
}

// ---- http server: static + per-agent proxy + feed + say -------------------------------------
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

async function serveStatic(req, res) {
  let p = new URL(req.url, "http://x").pathname;
  if (p === "/") p = "/studio.html";
  const name = decodeURIComponent(p).replace(/^\/+/, "");
  if (name.includes("..")) {
    res.writeHead(403);
    res.end("nope");
    return;
  }
  // pages live in web/; personas.mjs and qr-cotal.mjs sit one level up (imported as ../*.mjs).
  const file = name === "personas.mjs" || name === "qr-cotal.mjs" ? join(EX, name) : join(EX, "web", name);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found: " + name);
  }
}

/** Reverse-proxy /agent/<name>/<rest> to that agent's private OpenCode server, injecting its
 *  basic-auth so the browser never holds the per-agent password. Streams SSE unbuffered. */
function proxyAgent(req, res, name, rest) {
  const rec = agents.find((a) => a.name === name && !a.dead);
  if (!rec) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no such agent: " + name);
    return;
  }
  const auth = "Basic " + Buffer.from(`opencode:${rec.password}`).toString("base64");
  const up = httpRequest(
    {
      hostname: "127.0.0.1",
      port: rec.port,
      path: rest || "/",
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${rec.port}`, authorization: auth },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("agent server unreachable");
  });
  req.pipe(up);
}

function handleFeed(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  // snapshot so a fresh tab has context immediately
  res.write(`data: ${JSON.stringify({ type: "roster", roster: roomRoster })}\n\n`);
  for (const ev of recent) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  feedClients.add(res);
  req.on("close", () => feedClients.delete(res));
}

function handleSay(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let text, to;
    try {
      ({ text, to } = JSON.parse(body || "{}"));
    } catch {
      /* fall through */
    }
    if (!text || !text.trim()) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "empty" }));
      return;
    }
    const reply = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      if (to) {
        // Direct message a single agent — only it wakes; the others don't see it.
        const id = peerIds.get(to);
        if (!id) return reply(409, { error: `agent "${to}" isn't reachable yet` });
        const msg = await ep.unicast(id, text.trim());
        // The endpoint doesn't receive its own send back — surface the DM in the feed ourselves.
        pushFeed({ type: "msg", id: msg.id, kind: "dm", from: "you", role: "host", to, text: text.trim(), ts: msg.ts });
        return reply(200, { ok: true, id: msg.id });
      }
      const msg = await ep.multicast(text.trim(), { channel: "general" });
      pushFeed(normalizeMsg(msg, { kind: "channel", historical: false }));
      return reply(200, { ok: true, id: msg.id });
    } catch (e) {
      return reply(500, { error: e.message });
    }
  });
}

function startHttp() {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          space: SPACE,
          you: "you",
          agents: agents
            .filter((a) => !a.dead)
            .map((a) => ({ name: a.name, persona: a.persona, role: a.role, model: a.model, session: a.session })),
        }),
      );
      return;
    }
    if (p === "/api/feed") return handleFeed(req, res);
    if (p === "/api/say" && req.method === "POST") return handleSay(req, res);
    const am = p.match(/^\/agent\/([^/]+)(\/.*)?$/);
    if (am) return proxyAgent(req, res, am[1], am[2] || "/");
    return serveStatic(req, res);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

// ---- teardown -------------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down…");
  for (const res of feedClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  try {
    await ep?.stop();
  } catch {
    /* ignore */
  }
  for (const a of agents) {
    try {
      a.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (meshProc) {
    try {
      process.kill(-meshProc.pid, "SIGTERM"); // whole group (cotal up + nats-server)
    } catch {
      /* ignore */
    }
  }
  await sleep(400);
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ---- boot -----------------------------------------------------------------------------------
async function main() {
  if (!existsSync(SERVE) || !existsSync(PLUGIN)) throw new Error("connector not built — run `pnpm build` at the repo root");
  for (const name of roster) agentMeta(name); // validate roster up front (throws on a bad name)

  const { reused } = await ensureMesh();
  if (!reused) await clearHistory(); // start clean unless we're joining someone else's live mesh
  await startOperator(reused);

  log(`spawning ${roster.length} agents: ${roster.join(", ")}`);
  const results = await Promise.allSettled(roster.map(spawnAgent));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  for (const r of results) if (r.status === "rejected") warn(r.reason.message);
  if (ok === 0) throw new Error("no agents came up — see the logs above");

  const server = await startHttp();
  log(`\x1b[1m\x1b[32mstudio ready → http://127.0.0.1:${PORT}/\x1b[0m  (${ok}/${roster.length} agents · space "${SPACE}")`);
  log("type into the page to talk to the panel · Ctrl-C to stop");
  server.on("error", (e) => warn("http error:", e.message));
}

main().catch((e) => {
  console.error("\x1b[31m[studio] fatal:\x1b[0m", e.message);
  shutdown(1);
});
