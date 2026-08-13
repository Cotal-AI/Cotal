// Cotal console client (P2 item 6): one xterm pane per managed agent, each wired to the manager
// over a mesh §13.6 SESSION — never a 127.0.0.1 terminal socket. Per pane we POST /session/<name>
// (the loopback face mints a holder-bound offer + a per-session, rails-only caller credential),
// connect to the broker's WebSocket listener with that credential, open the caller rail with the
// redeemed grant, and drive xterm over the SAME core rail code the manager serves. Agents are
// discovered over HTTP (/agents, cross-referenced with mesh presence).
const { Terminal } = window;
const { FitAddon } = window.FitAddon;
const S = window.CotalSession; // the served session bundle (wsconnect + core rail + frame codec)

const grid = document.getElementById("grid");
const empty = document.getElementById("empty");
const meta = document.getElementById("meta");
const panes = new Map(); // name -> { el, term, fit, session, status }

// The console token, taken once from this page's own URL and kept only in memory. Deliberately not
// stored in a cookie: cookies are host-scoped and not port-scoped, so a cookie set here would be
// sent to every other HTTP service on this host, and two managers on one host would clobber each
// other's. The manager serves the static shell openly and requires this on every route that carries
// real data (/agents, /feed) or mints one (/session/<name>).
// Preferred source is the FRAGMENT: a browser never sends it to a server, so the credential stays
// out of request logs, proxies, and `Referer`. The query is accepted as a fallback for a hand-built
// URL.
const TOKEN =
  new URLSearchParams(location.hash.replace(/^#/, "")).get("t") ??
  new URLSearchParams(location.search).get("t") ??
  "";
const withToken = (path) => `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(TOKEN)}`;

function layout() {
  const n = panes.size;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  for (const p of panes.values()) p.fit.fit();
}

function addPane(agent) {
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML = `<div class="bar"><span class="dot"></span><span class="name"></span><span class="role"></span></div><div class="term"></div>`;
  el.querySelector(".name").textContent = agent.name;
  el.querySelector(".role").textContent = agent.role ? `· ${agent.role}` : "";
  grid.appendChild(el);

  const term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    cursorBlink: true,
    theme: { background: "#000000" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector(".term"));

  const pane = { el, term, fit, session: undefined, status: agent.status };
  panes.set(agent.name, pane);
  empty.style.display = "none";
  layout();
  void openSession(agent.name, pane);
}

// Open the mesh §13.6 session for one pane: POST /session, connect over the broker ws with the
// per-session cred, open the caller rail with the grant, and bridge it to xterm.
async function openSession(name, pane) {
  const { term, fit } = pane;
  if (!S) { term.write("\r\n[cotal: session bundle not loaded]\r\n"); return; }
  let est;
  try {
    const res = await fetch(withToken(`/session/${encodeURIComponent(name)}`), { method: "POST" });
    if (!res.ok) { term.write(`\r\n[cotal: attach failed (${res.status})]\r\n`); return; }
    est = await res.json();
  } catch { term.write("\r\n[cotal: attach request failed]\r\n"); return; }
  const { grant, wsUrl, creds } = est;
  let nc;
  try {
    nc = await S.wsconnect({
      servers: wsUrl,
      ...(creds ? { authenticator: S.credsAuthenticator(new TextEncoder().encode(creds)) } : {}),
    });
  } catch { term.write("\r\n[cotal: broker connection failed]\r\n"); return; }
  if (!panes.has(name)) { void nc.close(); return; } // pane removed while connecting

  // Mark the pane's dot as dead when the SESSION ends — honest even if /agents still lists the
  // agent for a beat (the terminal is gone). `ended` wins over the roster-poll dot (setStatus).
  const markEnded = () => { pane.ended = true; const dot = pane.el.querySelector(".dot"); if (dot) dot.className = "dot exited"; };
  const rail = S.openSessionRail({
    nc,
    grant,
    role: "caller",
    onData: (data) => {
      let frame;
      try { frame = S.decodeTerminalFrame(data); } catch { return; }
      if (frame.k === "data") term.write(S.terminalFrameBytes(frame));
      else if (frame.k === "end") { term.write(`\r\n[cotal: session ended - ${frame.reason}]\r\n`); markEnded(); }
      else if (frame.k === "drop") term.write(`\r\n[cotal: ${frame.bytes} bytes dropped - backpressure]\r\n`);
    },
    onClose: () => { term.write("\r\n[cotal: session closed]\r\n"); markEnded(); },
    onProtocolError: (reason) => { term.write(`\r\n[cotal: session error - ${reason}]\r\n`); markEnded(); },
  });

  // The caller's `out` subscription must be live before the serving side replays (EPS is at-most-
  // once, no retention). flush() forces the SUB, then send `ready` and go.
  await nc.flush();
  try { rail.send({ k: "ready" }); } catch { /* the onProtocolError path surfaces it */ }
  fit.fit();
  // xterm's onData is a STRING, but the §13.6 data frame carries raw bytes — UTF-8-encode it (a raw
  // string would base64-encode its chars as NUL bytes the pty silently ignores: no echo).
  term.onData((data) => { try { rail.send(S.encodeTerminalData(new TextEncoder().encode(data))); } catch (e) { console.error("[cotal] keystroke send failed", e); } });
  // Guard the resize: a pane fitting before it is laid out can compute a 0 dimension, which the
  // §13.6 codec rejects — a bad frame the serving side now tolerates, but never emit it in the first place.
  term.onResize(() => { if (term.cols > 0 && term.rows > 0) { try { rail.send({ k: "resize", cols: term.cols, rows: term.rows }); } catch { /* advisory */ } } });
  pane.session = { nc, rail };
}

function removePane(name) {
  const p = panes.get(name);
  if (!p) return;
  try { p.session?.rail.close(); } catch {}
  try { void p.session?.nc.close(); } catch {}
  p.term.dispose();
  p.el.remove();
  panes.delete(name);
  if (panes.size === 0) empty.style.display = "";
  layout();
}

function setStatus(name, status) {
  const p = panes.get(name);
  if (!p) return;
  p.status = status;
  if (p.ended) { p.el.querySelector(".dot").className = "dot exited"; return; } // a dead session stays dead in the UI
  p.el.querySelector(".dot").className = `dot ${status === "running" ? "running" : "exited"}`;
}

async function poll() {
  try {
    const agents = await (await fetch(withToken("/agents"))).json();
    meta.textContent = `${agents.length} agent${agents.length === 1 ? "" : "s"} · space ${agents[0]?.space ?? ""}`.trim();
    const seen = new Set();
    for (const a of agents) {
      seen.add(a.name);
      if (!panes.has(a.name)) addPane(a);
      setStatus(a.name, a.status);
    }
    for (const name of [...panes.keys()]) if (!seen.has(name)) removePane(name);
  } catch {
    meta.textContent = "manager unreachable";
  }
}

window.addEventListener("resize", layout);
poll();
setInterval(poll, 2000);
