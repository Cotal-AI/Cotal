"use strict";

// src/monitor.ts
var import_node_net = require("node:net");

// ../../packages/core/dist/secret-fs.js
var isWin = process.platform === "win32";

// ../connector-core/dist/session-env.js
function hasIdentity(env = process.env) {
  return Boolean(env.COTAL_NAME?.trim() || env.COTAL_LINK?.trim() || env.COTAL_AGENT_FILE?.trim());
}

// ../connector-core/dist/control.js
var MAX_FRAME_BYTES = 1 << 20;

// src/wake-feed.ts
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var WAKE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var WIN_PIPES = "\\\\.\\pipe\\";
var WIN_PREFIX = "cotal-claude-wake-";
function wakeDir() {
  if (process.platform === "win32") return WIN_PIPES;
  const uid = process.getuid();
  const dir = (0, import_node_path.join)((0, import_node_os.tmpdir)(), `cotal-claude-wake-${uid}`);
  (0, import_node_fs.mkdirSync)(dir, { recursive: true, mode: 448 });
  const st = (0, import_node_fs.lstatSync)(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 63) !== 0) throw new Error(`${dir} is not a private directory of this user's`);
  return dir;
}
var entryName = (claudePid, serverPid) => process.platform === "win32" ? `${WIN_PREFIX}${claudePid}-${serverPid}` : `${claudePid}-${serverPid}.sock`;
var ENTRY = process.platform === "win32" ? new RegExp(`^${WIN_PREFIX}(\\d+)-(\\d+)$`) : /^(\d+)-(\d+)\.sock$/;
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function wakeSocketPath(claudePid, serverPid = process.pid) {
  const dir = wakeDir();
  return process.platform === "win32" ? `${dir}${entryName(claudePid, serverPid)}` : (0, import_node_path.join)(dir, entryName(claudePid, serverPid));
}
function wakeSockets(claudePid) {
  const dir = wakeDir();
  return (0, import_node_fs.readdirSync)(dir).flatMap((name) => {
    const m = ENTRY.exec(name);
    return m?.[1] === String(claudePid) && alive(Number(m[2])) ? [wakeSocketPath(claudePid, Number(m[2]))] : [];
  });
}

// src/monitor.ts
var SCAN_MS = 1e3;
var wakeEvent = (id) => `Cotal: a new message for connection_id ${id}. Read it with cotal_inbox.`;
function main() {
  if (hasIdentity()) return;
  const claude = process.argv.includes("--native") ? process.ppid : Number(process.env.CLAUDE_PID);
  if (!Number.isInteger(claude) || claude <= 0) {
    process.stderr.write("[cotal-monitor] no CLAUDE_PID, so this is not a Claude Code session\n");
    process.exitCode = 1;
    return;
  }
  const reading = /* @__PURE__ */ new Set();
  const read = (path) => {
    reading.add(path);
    let buf = "";
    const s = (0, import_node_net.createConnection)(path);
    s.setEncoding("utf8");
    s.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const id = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (WAKE_ID.test(id)) process.stdout.write(`${wakeEvent(id)}
`);
      }
      if (buf.length > 256) s.destroy();
    });
    s.on("error", () => {
    });
    s.on("close", () => reading.delete(path));
  };
  const scan = () => {
    try {
      process.kill(claude, 0);
    } catch {
      process.exit(0);
    }
    for (const path of wakeSockets(claude)) if (!reading.has(path)) read(path);
  };
  scan();
  setInterval(scan, SCAN_MS);
}
main();
