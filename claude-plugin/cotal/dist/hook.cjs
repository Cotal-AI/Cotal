"use strict";

// ../connector-core/dist/relay.js
var import_node_net = require("node:net");

// ../../packages/core/dist/launch-material.js
var import_node_fs2 = require("node:fs");

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

// ../../packages/core/dist/launch-material.js
var LAUNCH_MATERIAL_ENV = "COTAL_LAUNCH_MATERIAL";
function readLaunchMaterial(path) {
  let raw;
  try {
    if (process.platform !== "win32") {
      const mode = (0, import_node_fs2.statSync)(path).mode & 511;
      if (mode & 63)
        throw new Error(`is readable beyond its owner (mode ${mode.toString(8)}) - refusing to read connection material out of a file other local users can open`);
    }
    raw = (0, import_node_fs2.readFileSync)(path, "utf8");
  } catch (e) {
    throw new Error(`launch material: cannot read ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`launch material: ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`launch material: ${path} must contain a JSON object`);
  return validate(parsed, path);
}
function validate(raw, path) {
  const material = {};
  const str = (key) => {
    const v = raw[key];
    if (v === void 0)
      return;
    if (typeof v !== "string" || !v.trim())
      throw new Error(`launch material: ${path} has a ${key} that is not a non-empty string`);
    material[key] = v;
  };
  str("servers");
  str("creds");
  str("token");
  str("controlToken");
  if (raw.eventsRequired !== void 0) {
    if (raw.eventsRequired !== true)
      throw new Error(`launch material: ${path} has eventsRequired that is not exactly true`);
    material.eventsRequired = true;
  }
  if (raw.userAuth !== void 0) {
    const u = raw.userAuth;
    if (typeof u !== "object" || u === null || Array.isArray(u))
      throw new Error(`launch material: ${path} has a userAuth that is not an object`);
    const { owner: owner2, actor, sentinelCredsPath, bearerCmd } = u;
    const named = { owner: owner2, actor, sentinelCredsPath };
    for (const [k, v] of Object.entries(named))
      if (typeof v !== "string" || !v.trim())
        throw new Error(`launch material: ${path} has a userAuth.${k} that is not a non-empty string`);
    if (!Array.isArray(bearerCmd) || bearerCmd.length === 0 || !bearerCmd.every((a) => typeof a === "string" && a))
      throw new Error(`launch material: ${path} has a userAuth.bearerCmd that is not a non-empty array of strings`);
    material.userAuth = {
      owner: owner2,
      actor,
      sentinelCredsPath,
      bearerCmd
    };
  }
  if (Object.keys(material).length === 0)
    throw new Error(`launch material: ${path} carries nothing this reader recognises. A launch that references material and supplies none is a broken launcher, not an open-mode launch, so it is refused rather than defaulted.`);
  return material;
}

// ../connector-core/dist/session-env.js
var DIRECT_MATERIAL_VARS = [
  "COTAL_CREDS",
  "COTAL_SERVERS",
  "COTAL_TOKEN",
  "COTAL_OWNER",
  "COTAL_ACTOR",
  "COTAL_SENTINEL_CREDS",
  "COTAL_BEARER_CMD",
  "COTAL_EVENTS_REQUIRED",
  // The control token belongs here for a reason that is not symmetry. Once a launcher-spawned seat
  // carries a material pointer in its environment, anything that INHERITS that environment and then
  // sets COTAL_CONTROL_TOKEN by hand has two answers for one question, and controlFromEnv would
  // silently prefer the inherited one - handing a process the OUTER seat's control endpoint while
  // its own explicit token sat unused. That is not hypothetical: it is what a test harness spreading
  // `...process.env` does, and this whole change exists because that spread used to be invisible.
  "COTAL_CONTROL_TOKEN",
  // A join link is connection material in one string: it carries the server, the auth and the space.
  // Left off this list, a launch with both a material file and a link resolved the conflict by
  // precedence and said nothing, which is the same silent answer to "who is this session" that the
  // credential pair is refused for.
  "COTAL_LINK"
];
function readMaterial(env) {
  const path = env[LAUNCH_MATERIAL_ENV]?.trim();
  if (!path)
    return void 0;
  const direct = DIRECT_MATERIAL_VARS.filter((k) => env[k]?.trim());
  if (direct.length)
    throw new Error(`COTAL config: this launch carries connection material BOTH as ${LAUNCH_MATERIAL_ENV} and as ${direct.join(", ")}. One launch carries one identity plane - drop the direct variables, or drop the material file.`);
  return readLaunchMaterial(path);
}
function controlFromEnv(env = process.env) {
  const path = env.COTAL_CONTROL_SOCKET?.trim();
  const token = readMaterial(env)?.controlToken ?? env.COTAL_CONTROL_TOKEN?.trim();
  if (path && token)
    return { path, token };
  if (!path && !token)
    return void 0;
  if (path)
    throw new Error("COTAL config: COTAL_CONTROL_SOCKET is set but no control token could be resolved - neither the launch material nor COTAL_CONTROL_TOKEN carries one. Half a pair is not a control endpoint, so this launch is refused rather than started without the control plane it was configured to have.");
  throw new Error("COTAL config: a control token was supplied but COTAL_CONTROL_SOCKET is unset, so there is no socket to authenticate against. Half a pair is not a control endpoint, so this launch is refused rather than started without the control plane it was configured to have.");
}
function hasIdentity(env = process.env) {
  return Boolean(env.COTAL_NAME?.trim() || env.COTAL_LINK?.trim() || env.COTAL_AGENT_FILE?.trim());
}

// ../connector-core/dist/control.js
var HANDOFF_RECEIPT = '{"handoff":"ok"}\n';
var MAX_FRAME_BYTES = 1 << 20;

// ../connector-core/dist/relay.js
var TIMEOUT_MS = 2e3;
var CONNECT_RETRY_INITIAL_MS = 25;
var CONNECT_RETRY_MAX_MS = 250;
var isRetryableConnectError = (error) => {
  const code = error instanceof Error ? error.code : void 0;
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EAGAIN", "EBUSY"].includes(code ?? "");
};
var isSessionStart = (event) => event !== null && typeof event === "object" && event.hook_event_name === "SessionStart";
var warned = false;
function warnOnce(message) {
  if (warned)
    return;
  warned = true;
  try {
    process.stderr.write(`[cotal-connector] ${message}
`);
  } catch {
  }
}
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY)
      return resolve("");
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => d += c);
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(d));
  });
}
function done(out, confirm) {
  const exit = () => process.exit(0);
  const t = out.trim();
  if (!t)
    return exit();
  process.stdout.on("error", () => exit());
  process.stdout.write(t + "\n", (err) => {
    if (err || !confirm)
      return exit();
    confirm(exit);
  });
  setTimeout(exit, 1e3);
}
async function runHookRelay(answer, observe) {
  const managed = hasIdentity();
  if (!managed && !answer && !observe)
    return done("");
  const raw = (await readStdin()).trim() || "{}";
  let event = {};
  try {
    event = JSON.parse(raw);
  } catch {
  }
  let local;
  try {
    local = answer?.(event, { managed });
  } catch {
  }
  if (local)
    return done(JSON.stringify(local));
  try {
    await observe?.(event, { managed });
  } catch {
  }
  if (!managed)
    return done("");
  let control;
  try {
    control = controlFromEnv();
  } catch {
    warnOnce("this session's control endpoint could not be resolved: the launch material is missing, unreadable, readable beyond its owner, malformed, or contradicted by direct COTAL_ variables. Lifecycle relays are disabled for this session, so presence will not advance and queued peer messages will not be injected. Check COTAL_LAUNCH_MATERIAL and COTAL_CONTROL_SOCKET.");
    return done("");
  }
  if (!control)
    return done("");
  const { path, token } = control;
  const startupCritical = isSessionStart(event);
  let sock;
  let settled = false;
  let retryDelayMs = CONNECT_RETRY_INITIAL_MS;
  const drop = (candidate = sock) => {
    try {
      candidate?.destroy();
    } catch {
    }
  };
  const settle = () => {
    if (settled)
      return false;
    settled = true;
    clearTimeout(timer);
    return true;
  };
  const finish = (out) => {
    if (!settle())
      return;
    drop();
    done(out);
  };
  const finishWithReceipt = (out, candidate) => {
    if (!settle())
      return;
    done(out, (then) => {
      try {
        candidate.write(HANDOFF_RECEIPT, () => {
          drop(candidate);
          then();
        });
      } catch {
        then();
      }
    });
  };
  const timer = setTimeout(() => finish(""), TIMEOUT_MS);
  const retryLater = () => {
    const wait = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, CONNECT_RETRY_MAX_MS);
    setTimeout(dial, wait);
  };
  const dial = () => {
    if (settled)
      return;
    const candidate = (0, import_node_net.connect)(path);
    sock = candidate;
    let connected = false;
    let reply = "";
    candidate.setEncoding("utf8");
    candidate.on("connect", () => {
      if (settled || sock !== candidate)
        return;
      connected = true;
      try {
        candidate.write(JSON.stringify({ token, event, handoff: true }) + "\n");
      } catch {
        finish("");
      }
    });
    candidate.on("data", (d) => {
      if (settled || sock !== candidate)
        return;
      reply += d;
      const nl = reply.indexOf("\n");
      if (nl >= 0)
        finishWithReceipt(reply.slice(0, nl), candidate);
    });
    candidate.on("error", (error) => {
      if (settled || sock !== candidate)
        return;
      if (!connected && startupCritical && isRetryableConnectError(error)) {
        drop(candidate);
        retryLater();
        return;
      }
      finish("");
    });
    candidate.on("end", () => {
      if (settled || sock !== candidate)
        return;
      finish(reply);
    });
  };
  dial();
}

// src/one-path.ts
var LOCAL_SERVERS = /* @__PURE__ */ new Set(["cotal", "plugin_cotal_cotal"]);
var COTAL_TOOL = /^mcp__(.+)__(cotal_[a-z0-9]+(?:_[a-z0-9]+)*)$/;
function hostedCotalTool(toolName) {
  const m = typeof toolName === "string" ? COTAL_TOOL.exec(toolName) : null;
  return m && !LOCAL_SERVERS.has(m[1]) ? m[2] : void 0;
}
var ONE_PATH_REASON = "This session is already on a Cotal mesh through its local Cotal plugin, and a session uses one Cotal path. Use the local cotal_* tools (mcp__cotal__...). To use the hosted Cotal connector, start a Claude Code session that Cotal did not launch.";
var otherCotalPath = (event, session) => {
  if (!session.managed) return void 0;
  const ev = event;
  if (ev?.hook_event_name !== "PreToolUse" || hostedCotalTool(ev.tool_name) === void 0) return void 0;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ONE_PATH_REASON
    }
  };
};

// src/connection-owner.ts
var import_node_fs3 = require("node:fs");
var import_node_path2 = require("node:path");
var CONNECTED = /^connection_id: (\S+)$/m;
var SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var FORKED_REASON = "This connection_id was opened by another Claude Code session. This session is a fork or a copy of that one, so it needs its own connection: call cotal_connect, then use the connection_id it returns.";
function connectedId(response) {
  const blocks = Array.isArray(response) ? response : [];
  for (const b of blocks) {
    const text = b?.text;
    const id = typeof text === "string" ? CONNECTED.exec(text)?.[1] : void 0;
    if (id !== void 0) return SAFE_ID.test(id) ? id : void 0;
  }
  return void 0;
}
function connectionOwner(dataDir) {
  const dir = dataDir ? (0, import_node_path2.join)(dataDir, "hosted-connections") : void 0;
  return (event, session) => {
    if (session.managed || !dir) return void 0;
    const ev = event;
    const tool = hostedCotalTool(ev?.tool_name);
    const sessionId = ev?.session_id;
    if (tool === void 0 || typeof sessionId !== "string" || !sessionId) return void 0;
    const given = ev?.tool_input?.connection_id;
    const id = typeof given === "string" && SAFE_ID.test(given) ? given : void 0;
    const owner2 = () => {
      try {
        return (0, import_node_fs3.readFileSync)((0, import_node_path2.join)(dir, id), "utf8");
      } catch {
        return void 0;
      }
    };
    if (ev?.hook_event_name === "PostToolUse" && tool === "cotal_connect") {
      const opened = connectedId(ev.tool_response);
      if (opened === void 0) return void 0;
      (0, import_node_fs3.mkdirSync)(dir, { recursive: true, mode: 448 });
      (0, import_node_fs3.writeFileSync)((0, import_node_path2.join)(dir, opened), sessionId, { mode: 384 });
      return void 0;
    }
    if (id === void 0) return void 0;
    if (ev?.hook_event_name === "PostToolUse" && tool === "cotal_disconnect") {
      if (owner2() === sessionId) (0, import_node_fs3.rmSync)((0, import_node_path2.join)(dir, id), { force: true });
      return void 0;
    }
    if (ev?.hook_event_name !== "PreToolUse") return void 0;
    const recorded = owner2();
    if (recorded === void 0 || recorded === sessionId) return void 0;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: FORKED_REASON
      }
    };
  };
}

// src/native-binding.ts
var import_node_fs5 = require("node:fs");
var import_node_net2 = require("node:net");
var import_node_os2 = require("node:os");
var import_node_path4 = require("node:path");

// src/wake-feed.ts
var import_node_fs4 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path3 = require("node:path");
var WAKE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var WIN_PIPES = "\\\\.\\pipe\\";
var WIN_PREFIX = "cotal-claude-wake-";
function wakeDir() {
  if (process.platform === "win32") return WIN_PIPES;
  const uid = process.getuid();
  const dir = (0, import_node_path3.join)((0, import_node_os.tmpdir)(), `cotal-claude-wake-${uid}`);
  (0, import_node_fs4.mkdirSync)(dir, { recursive: true, mode: 448 });
  const st = (0, import_node_fs4.lstatSync)(dir);
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
  return process.platform === "win32" ? `${dir}${entryName(claudePid, serverPid)}` : (0, import_node_path3.join)(dir, entryName(claudePid, serverPid));
}
function wakeSockets(claudePid) {
  const dir = wakeDir();
  return (0, import_node_fs4.readdirSync)(dir).flatMap((name) => {
    const m = ENTRY.exec(name);
    return m?.[1] === String(claudePid) && alive(Number(m[2])) ? [wakeSocketPath(claudePid, Number(m[2]))] : [];
  });
}
function nativeSocketPath(feed) {
  return `${feed}.native`;
}

// src/native-binding.ts
function stateFile(session) {
  if (!WAKE_ID.test(session)) throw new Error("invalid native session identity");
  const root = (0, import_node_path4.join)((0, import_node_os2.tmpdir)(), `cotal-claude-native-${process.getuid?.() ?? "local"}`);
  const st = (0, import_node_fs5.lstatSync)(root, { throwIfNoEntry: false });
  if (st && (!st.isDirectory() || process.getuid && st.uid !== process.getuid()))
    throw new Error("native session state is not this user's private directory");
  mkSecretDir(root);
  return (0, import_node_path4.join)(root, `${session}.json`);
}
function readRecord(file) {
  const st = (0, import_node_fs5.lstatSync)(file, { throwIfNoEntry: false });
  if (!st) return void 0;
  if (!st.isFile() || st.size > 16384 || process.getuid && (st.uid !== process.getuid() || (st.mode & 63) !== 0))
    throw new Error("native session state is not an owner-private bounded regular file");
  const value = JSON.parse((0, import_node_fs5.readFileSync)(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid native session state");
  return value;
}
function transcriptMatches(session, path) {
  return typeof path === "string" && (0, import_node_path4.isAbsolute)(path) && (0, import_node_path4.basename)(path) === `${session}.jsonl`;
}
async function forward(event, hostPid) {
  const paths = wakeSockets(hostPid);
  if (!paths.length) throw new Error("no local native lifecycle server");
  await Promise.all(paths.map((path) => new Promise((resolve, reject) => {
    const socket = (0, import_node_net2.createConnection)(nativeSocketPath(path));
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
async function observePersonalHook(value) {
  if (!value || typeof value !== "object") return;
  const event = value;
  if (event.agent_id !== void 0 || typeof event.session_id !== "string" || !WAKE_ID.test(event.session_id) || !transcriptMatches(event.session_id, event.transcript_path) || typeof event.hook_event_name !== "string") return;
  if (!["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolBatch", "Notification", "Stop", "StopFailure", "SessionEnd"].includes(event.hook_event_name)) return;
  const file = stateFile(event.session_id);
  const previous = readRecord(file);
  if (previous && previous.transcript_path !== event.transcript_path)
    throw new Error("native command hook changed its session transcript");
  const safe = {};
  for (const key of ["hook_event_name", "session_id", "transcript_path", "cwd", "source", "notification_type", "error", "model"])
    if (typeof event[key] === "string" && event[key].length <= 4096) safe[key] = event[key];
  if (JSON.stringify(safe).length > 8192) throw new Error("native command-hook metadata is too large");
  writeSecretFileAtomic(file, JSON.stringify(safe));
  const target = readRecord(`${file}.host`);
  if (target) {
    if (!Number.isInteger(target.hostPid) || target.hostPid <= 0) throw new Error("invalid native lifecycle host");
    await forward(safe, target.hostPid);
  }
  if (event.hook_event_name === "SessionEnd") {
    (0, import_node_fs5.unlinkSync)(file);
    if (target) (0, import_node_fs5.unlinkSync)(`${file}.host`);
  }
}

// src/hook.ts
var owner = connectionOwner(process.env.CLAUDE_PLUGIN_DATA);
void runHookRelay(
  (event, session) => otherCotalPath(event, session) ?? owner(event, session),
  async (event, session) => {
    if (!session.managed) await observePersonalHook(event);
  }
).catch(() => process.exit(0));
