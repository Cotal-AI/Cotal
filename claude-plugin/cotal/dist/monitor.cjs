"use strict";

// src/monitor.ts
var import_node_net2 = require("node:net");

// ../../packages/core/dist/secret-fs.js
var import_node_fs = require("node:fs");
var import_node_child_process = require("node:child_process");
var import_node_path = require("node:path");
var isWin = process.platform === "win32";
function sys32(exe) {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return (0, import_node_path.join)(root, "System32", exe);
}
var cachedSid;
function ownerSid() {
  if (cachedSid)
    return cachedSid;
  const out = (0, import_node_child_process.execFileSync)(sys32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = out.trim().split(",").pop()?.replace(/^"|"$/g, "").trim();
  if (!sid || !/^S-1-/.test(sid))
    throw new Error(`could not determine the current user's SID from \`whoami\` (got: ${out.trim()})`);
  cachedSid = sid;
  return sid;
}
var BROAD_SIDS = ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"];
function hardenPrivate(path, kind) {
  if (!isWin) {
    if (kind === "file")
      (0, import_node_fs.closeSync)(openPrivate(path, import_node_fs.constants.O_RDONLY));
    else
      (0, import_node_fs.chmodSync)(path, 448);
    return;
  }
  const perm = kind === "dir" ? "(OI)(CI)(F)" : "(F)";
  const removeBroad = BROAD_SIDS.flatMap((sid) => ["/remove:g", `*${sid}`]);
  const grant = (sid) => ["/grant:r", `*${sid}:${perm}`];
  try {
    (0, import_node_child_process.execFileSync)(sys32("icacls.exe"), [
      path,
      "/inheritance:r",
      ...removeBroad,
      ...grant(ownerSid()),
      ...grant("S-1-5-18"),
      ...grant("S-1-5-32-544")
    ], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new Error(`failed to harden ${kind} "${path}" to private via icacls: ${e.message.trim()}. Cotal will not leave a secret with a permissive ACL - ensure the path is on an NTFS volume and %SystemRoot%\\System32\\icacls.exe is available.`);
  }
}
function notPrivate(path, why) {
  const refused = new Error(`refusing to write "${path}": it ${why}; it was left unchanged`);
  refused.code = "EPERM";
  return refused;
}
function openPrivate(path, flags) {
  if (isWin) {
    const fd2 = (0, import_node_fs.openSync)(path, flags, 384);
    try {
      (0, import_node_fs.fchmodSync)(fd2, 384);
    } catch (e) {
      (0, import_node_fs.closeSync)(fd2);
      throw e;
    }
    return fd2;
  }
  let fd;
  try {
    fd = (0, import_node_fs.openSync)(path, flags | import_node_fs.constants.O_NOFOLLOW | import_node_fs.constants.O_NONBLOCK, 384);
  } catch (e) {
    if (e.code === "ELOOP")
      throw notPrivate(path, "is a symlink");
    throw e;
  }
  try {
    const info = (0, import_node_fs.fstatSync)(fd);
    if (!info.isFile())
      throw notPrivate(path, "is not a regular file");
    if (info.uid !== process.getuid())
      throw notPrivate(path, `is owned by uid ${info.uid}, not this user`);
    (0, import_node_fs.fchmodSync)(fd, 384);
    return fd;
  } catch (e) {
    (0, import_node_fs.closeSync)(fd);
    throw e;
  }
}
function writeSecretFile(path, data) {
  writePrivate(path, data, false);
}
function writeBytes(path, data, exclusive) {
  const fd = openPrivate(path, import_node_fs.constants.O_WRONLY | import_node_fs.constants.O_CREAT | (exclusive ? import_node_fs.constants.O_EXCL : 0));
  try {
    (0, import_node_fs.ftruncateSync)(fd);
    (0, import_node_fs.writeFileSync)(fd, data);
  } finally {
    (0, import_node_fs.closeSync)(fd);
  }
}
function writePrivate(path, data, exclusive) {
  writeBytes(path, data, exclusive);
  if (!isWin)
    return;
  try {
    hardenPrivate(path, "file");
  } catch (e) {
    try {
      (0, import_node_fs.unlinkSync)(path);
    } catch {
    }
    throw e;
  }
}
function writeSecretFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeSecretFile(tmp, data);
    (0, import_node_fs.renameSync)(tmp, path);
  } catch (e) {
    try {
      (0, import_node_fs.unlinkSync)(tmp);
    } catch {
    }
    throw e;
  }
}
function mkSecretDir(path) {
  (0, import_node_fs.mkdirSync)(path, { recursive: true, mode: 448 });
  hardenPrivate(path, "dir");
}

// ../connector-core/dist/session-env.js
function hasIdentity(env = process.env) {
  return Boolean(env.COTAL_NAME?.trim() || env.COTAL_LINK?.trim() || env.COTAL_AGENT_FILE?.trim());
}

// ../connector-core/dist/control.js
var MAX_FRAME_BYTES = 1 << 20;

// src/wake-feed.ts
var import_node_fs2 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");

// src/native-deliveries.ts
var ID = /^[A-Za-z0-9_-]{1,128}$/;
var INLINE_FRAME_LIMIT = 4096;
function isNativeInlineFrame(value) {
  if (!value || typeof value !== "object") return false;
  const frame = value;
  const item = frame.inline;
  return typeof frame.id === "string" && ID.test(frame.id) && typeof frame.route === "string" && !!item && item.v === 1 && typeof item.receipt === "string" && ID.test(item.receipt) && typeof item.session === "string" && ID.test(item.session) && typeof item.text === "string" && item.text.startsWith(`Cotal: inline messages for connection_id ${frame.id}.
`) && Number.isInteger(item.count) && item.count > 0 && item.count <= 8 && Number.isInteger(item.remaining) && item.remaining >= 0 && JSON.stringify(frame).length <= INLINE_FRAME_LIMIT;
}

// src/wake-feed.ts
var WAKE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var WIN_PIPES = "\\\\.\\pipe\\";
var WIN_PREFIX = "cotal-claude-wake-";
function wakeDir() {
  if (process.platform === "win32") return WIN_PIPES;
  const uid = process.getuid();
  const dir = (0, import_node_path2.join)((0, import_node_os.tmpdir)(), `cotal-claude-wake-${uid}`);
  (0, import_node_fs2.mkdirSync)(dir, { recursive: true, mode: 448 });
  const st = (0, import_node_fs2.lstatSync)(dir);
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
  return process.platform === "win32" ? `${dir}${entryName(claudePid, serverPid)}` : (0, import_node_path2.join)(dir, entryName(claudePid, serverPid));
}
function wakeSockets(claudePid) {
  const dir = wakeDir();
  return (0, import_node_fs2.readdirSync)(dir).flatMap((name) => {
    const m = ENTRY.exec(name);
    return m?.[1] === String(claudePid) && alive(Number(m[2])) ? [wakeSocketPath(claudePid, Number(m[2]))] : [];
  });
}
function nativeSocketPath(feed) {
  return `${feed}.native`;
}

// src/native-binding.ts
var import_node_fs3 = require("node:fs");
var import_node_net = require("node:net");
var import_node_os2 = require("node:os");
var import_node_path3 = require("node:path");
function stateFile(session) {
  if (!WAKE_ID.test(session)) throw new Error("invalid native session identity");
  const root = (0, import_node_path3.join)((0, import_node_os2.tmpdir)(), `cotal-claude-native-${process.getuid?.() ?? "local"}`);
  const st = (0, import_node_fs3.lstatSync)(root, { throwIfNoEntry: false });
  if (st && (!st.isDirectory() || process.getuid && st.uid !== process.getuid()))
    throw new Error("native session state is not this user's private directory");
  mkSecretDir(root);
  return (0, import_node_path3.join)(root, `${session}.json`);
}
function readRecord(file) {
  const st = (0, import_node_fs3.lstatSync)(file, { throwIfNoEntry: false });
  if (!st) return void 0;
  if (!st.isFile() || st.size > 16384 || process.getuid && (st.uid !== process.getuid() || (st.mode & 63) !== 0))
    throw new Error("native session state is not an owner-private bounded regular file");
  const value = JSON.parse((0, import_node_fs3.readFileSync)(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid native session state");
  return value;
}
function transcriptMatches(session, path) {
  return typeof path === "string" && (0, import_node_path3.isAbsolute)(path) && (0, import_node_path3.basename)(path) === `${session}.jsonl`;
}
function readPersonalBinding(session) {
  const event = readRecord(stateFile(session));
  if (!event || event.session_id !== session || !transcriptMatches(session, event.transcript_path))
    throw new Error("no native command-hook transcript binding for this session");
  return event;
}
async function forward(event, hostPid) {
  const paths = wakeSockets(hostPid);
  if (!paths.length) throw new Error("no local native lifecycle server");
  await Promise.all(paths.map((path) => new Promise((resolve, reject) => {
    const socket = (0, import_node_net.createConnection)(nativeSocketPath(path));
    let reply = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2e3, () => socket.destroy(new Error("native lifecycle relay timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ op: "native", event })}
`));
    socket.on("data", (data) => {
      reply += data;
      if (reply.length > 128) socket.destroy();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        if (JSON.parse(reply).ok === true) resolve();
        else reject(new Error("native lifecycle binding refused"));
      } catch {
        reject(new Error("native lifecycle binding was not confirmed"));
      }
    });
  })));
}
async function bindPersonalSession(event, hostPid) {
  const session = event.session_id;
  if (typeof session !== "string" || !Number.isInteger(hostPid) || hostPid <= 0)
    throw new Error("invalid native lifecycle binding");
  const previous = readPersonalBinding(session);
  if (previous.transcript_path !== event.transcript_path)
    throw new Error("native lifecycle binding does not match the command hook");
  writeSecretFileAtomic(`${stateFile(session)}.host`, JSON.stringify({ hostPid }));
  await forward(event, hostPid);
}

// src/monitor.ts
var SCAN_MS = 1e3;
var wakeEvent = (id) => `Cotal: a new message for connection_id ${id}. Read it with cotal_inbox.`;
var previewEvent = (id, preview) => `Cotal preview for connection_id ${id}: ${JSON.stringify(preview)}`;
async function relayNative(claude, raw) {
  const event = JSON.parse(raw);
  if (typeof event.session_id !== "string" || !WAKE_ID.test(event.session_id) || raw.length > 8192)
    throw new Error("invalid native lifecycle frame");
  await bindPersonalSession(event, claude);
}
async function relayInline(claude, session) {
  let input = "";
  for await (const piece of process.stdin) {
    input += piece;
    if (input.length > 1024) throw new Error("inline receipt is too large");
  }
  const frame = JSON.parse(input);
  if (!session || frame.session !== session || typeof frame.route !== "string" || !wakeSockets(claude).includes(frame.route) || !["claim", "commit", "defer", "reject", "retry"].includes(String(frame.action)) || typeof frame.receipt !== "string" || !WAKE_ID.test(frame.receipt) || typeof frame.id !== "string" || !WAKE_ID.test(frame.id)) throw new Error("invalid inline receipt");
  const reply = await new Promise((resolve, reject) => {
    const socket = (0, import_node_net2.createConnection)(nativeSocketPath(frame.route));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2e3, () => socket.destroy(new Error("inline receipt timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...frame, op: "inline" })}
`));
    socket.on("data", (piece) => {
      buffer += piece;
      if (buffer.length > INLINE_FRAME_LIMIT + 64) socket.destroy(new Error("inline reply is too large"));
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(buffer));
  });
  const result = JSON.parse(reply);
  if (result.ok !== true && result.ok !== false || result.frame !== void 0 && !isNativeInlineFrame(result.frame))
    throw new Error("invalid inline reply");
  process.stdout.write(`${JSON.stringify(result)}
`);
}
function main() {
  if (hasIdentity()) return;
  const claude = process.argv.includes("--native") ? process.ppid : Number(process.env.CLAUDE_PID);
  if (!Number.isInteger(claude) || claude <= 0) {
    process.stderr.write("[cotal-monitor] no CLAUDE_PID, so this is not a Claude Code session\n");
    process.exitCode = 1;
    return;
  }
  const bindingAt = process.argv.indexOf("--native-binding");
  if (bindingAt >= 0) {
    try {
      process.stdout.write(`${JSON.stringify(readPersonalBinding(process.argv[bindingAt + 1] ?? ""))}
`);
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  const eventAt = process.argv.indexOf("--native-event");
  if (eventAt >= 0) {
    void relayNative(claude, process.argv[eventAt + 1] ?? "").catch(() => {
      process.stderr.write("[cotal-monitor] native lifecycle binding was not confirmed\n");
      process.exitCode = 1;
    });
    return;
  }
  const sessionAt = process.argv.indexOf("--session");
  const session = sessionAt >= 0 ? process.argv[sessionAt + 1] : void 0;
  if (session !== void 0 && !WAKE_ID.test(session)) throw new Error("invalid native session identity");
  if (process.argv.includes("--native-delivery")) {
    void relayInline(claude, session).catch(() => {
      process.exitCode = 1;
    });
    return;
  }
  const reading = /* @__PURE__ */ new Set();
  const read = (path) => {
    reading.add(path);
    let buf = "";
    const s = (0, import_node_net2.createConnection)(path);
    s.setEncoding("utf8");
    if (session) s.on("connect", () => s.write(`${JSON.stringify({ op: "watch", session, inline: 1 })}
`));
    s.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          if (line.length > INLINE_FRAME_LIMIT) continue;
          const frame = JSON.parse(line);
          if (isNativeInlineFrame(frame)) {
            if (frame.inline.session === session && frame.route === path)
              process.stdout.write(`Cotal inline delivery: ${JSON.stringify(frame)}
`);
            continue;
          }
          if (typeof frame.id !== "string" || !WAKE_ID.test(frame.id)) continue;
          const preview = frame.preview;
          if (!preview || !Number.isInteger(preview.unread) || !Array.isArray(preview.rows) || preview.rows.length > 8 || !preview.rows.every((row) => typeof row === "string" && Array.from(row).length <= 240)) continue;
          process.stdout.write(`${previewEvent(frame.id, preview)}
${wakeEvent(frame.id)}
`);
        } catch {
          if (WAKE_ID.test(line)) process.stdout.write(`${wakeEvent(line)}
`);
        }
      }
      if (buf.length > 4096) s.destroy();
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
