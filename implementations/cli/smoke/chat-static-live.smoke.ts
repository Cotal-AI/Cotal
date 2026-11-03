/**
 * LIVE: a static chat session that a detached stack's manager admits, driven through `chat --plain`
 * one typed line at a time. The stack is a real `cotal up --detach` on an isolated port.
 *
 *  1. `chat general --plain` opens a session on #general.
 *  2. `/leave general` leaves it and `/join general` returns to it: the named channel is the
 *     session's read list, and leaving does not change what the session may read.
 *  3. `/leave` of a channel the session never joined says it was not on it.
 *  4. `/reconnect` reconnects and reports the one outage it causes once.
 *  5. `/quit` retires the session and exits 0.
 *  6. A `chat --stdio` session's `status` request with an activity reaches a second stdio session as
 *     one presence `updated` record carrying both, and its `attention` and `channelMode` requests,
 *     which change no row field, reach it as none.
 *  7. A session opened without --name is on the roster as the OS login, with no suffix, and a
 *     `--stdio` peer's `send` with `mentions: [<login>]` reaches it with `mentionsMe: true`.
 *  8. A second session under the same name is warned at join, naming both ways to change it.
 *  9. A name saved with `cotal config set name` replaces the OS login.
 *
 * Sandboxes COTAL_HOME and a temp project root, and stops the stack with `cotal down`; it signals
 * only the chat child it started. Needs `nats-server` on PATH.
 * Run: pnpm smoke:chat-static:live
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const PORT = await freePort();
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const home = mkdtempSync(join(tmpdir(), "cotal-chatstatic-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-chatstatic-root-"));
const configDir = join(home, "xdg");
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { check, finish } = createSuite();
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  return spawnSync(TSX, [CLI, ...args], options);
};

try {
  const up = cli("up", "--detach", "--server", `nats://127.0.0.1:${PORT}`);
  check("up --detach starts the static stack", up.status === 0, plain(up.stdout + up.stderr));
  // The detached manager may still be booting; chat needs it to admit the session.
  let answered = false;
  for (let i = 0; i < 15 && !answered; i++) {
    answered = cli("ps").status === 0;
    if (!answered) await sleep(2000);
  }
  check("the detached manager answers", answered);

  const chat = spawn(TSX, [CLI, "chat", "general", "--plain", "--name", "static-chat"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  chat.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  chat.stderr.on("data", (b: Buffer) => { out += b.toString(); });
  const prompted = /\] type a message/;
  /** Type `line` and return what the session printed up to its next prompt (30s at most). */
  const say = async (line: string): Promise<string> => {
    const from = out.length;
    chat.stdin.write(`${line}\n`);
    for (let i = 0; i < 150 && !prompted.test(out.slice(from)); i++) await sleep(200);
    return plain(out.slice(from));
  };
  try {
    for (let i = 0; i < 150 && !prompted.test(out); i++) await sleep(200);
    check("chat general --plain opens a session the manager admits", prompted.test(out), plain(out));
    const left = await say("/leave general");
    check("/leave of its own channel leaves it", left.includes("left #general"), left);
    const back = await say("/join general");
    check("/join returns to the channel it left", back.includes("joined #general") && !back.includes("denied"), back);
    const ops = await say("/leave ops");
    check("/leave of a channel it never joined says it was not on it", ops.includes("not on #ops"), ops);
    const again = await say("/reconnect");
    check("/reconnect reconnects and reports its one outage once", again.includes("reconnected as the same session") && (again.match(/^gap: /gm) ?? []).length === 1, again);
    chat.stdin.write("/quit\n");
    const code = await new Promise<number | null>((r) => {
      const t = setTimeout(() => r(null), 30_000);
      chat.once("exit", (c) => { clearTimeout(t); r(c); });
      if (chat.exitCode !== null) { clearTimeout(t); r(chat.exitCode); }
    });
    check("/quit retires the session and exits 0", code === 0, plain(out.slice(-600)));
  } finally {
    if (chat.exitCode === null && chat.signalCode === null) chat.kill("SIGTERM");
  }

  // A peer's presence records, as a second `chat --stdio` session writes them.
  const watcher = spawn(TSX, [CLI, "chat", "--stdio", "--name", "watcher"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let records = "";
  watcher.stdout.on("data", (b: Buffer) => { records += b.toString(); });
  const request = (fields: Record<string, unknown>) => `${JSON.stringify({ schemaVersion: 1, ...fields })}\n`;
  const actorRows = (change: string, name = "actor") => records.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; change?: string; row?: { name: string; status: string; activity?: string } })
    .filter((r) => r.type === "presence" && r.row?.name === name && r.change === change).map((r) => [r.row!.status, r.row!.activity ?? null]);
  try {
    watcher.stdin.write(request({ type: "connection", id: "c0" }));
    for (let i = 0; i < 150 && !records.includes('"id":"c0"'); i++) await sleep(200);
    const actor = spawnSync(TSX, [CLI, "chat", "--stdio", "--name", "actor"], { cwd: root, env, encoding: "utf8", timeout: 120_000,
      input: request({ type: "connection", id: "c0" }) + request({ type: "status", id: "s1", status: "working", activity: "reviewing" }) });
    for (let i = 0; i < 150 && actorRows("left").length === 0; i++) await sleep(200);
    check("a status request with an activity reaches a peer as one presence record carrying both",
      actor.status === 0 && actor.stdout.includes('"id":"s1","outcome":"ok"') && JSON.stringify(actorRows("updated")) === JSON.stringify([["working", "reviewing"]]), { updated: actorRows("updated"), actor: actor.stdout.slice(-600) });
    // Attention and channel modes are not in the row, so changing them changes no row.
    const moder = spawnSync(TSX, [CLI, "chat", "general", "--stdio", "--name", "moder"], { cwd: root, env, encoding: "utf8", timeout: 120_000,
      input: request({ type: "connection", id: "c0" }) + request({ type: "attention", id: "a1", mode: "dnd" }) + request({ type: "channelMode", id: "m1", channel: "general", mode: "quiet" }) });
    for (let i = 0; i < 150 && actorRows("left", "moder").length === 0; i++) await sleep(200);
    check("attention and channelMode requests reach a peer as no updated record, since its row does not change",
      moder.status === 0 && moder.stdout.includes('"id":"a1","outcome":"ok"') && moder.stdout.includes('"id":"m1","outcome":"ok"') && actorRows("joined", "moder").length === 1 && actorRows("updated", "moder").length === 0,
      { updated: actorRows("updated", "moder"), moder: moder.stdout.slice(-600) });
  } finally {
    watcher.stdin.end();
    const code = await new Promise<number | null>((r) => {
      const t = setTimeout(() => r(null), 30_000);
      watcher.once("exit", (c) => { clearTimeout(t); r(c); });
      if (watcher.exitCode !== null) { clearTimeout(t); r(watcher.exitCode); }
    });
    if (code === null) watcher.kill("SIGTERM");
  }

  // The name a session takes with no --name, and the mention that reaches it by that name.
  const login = userInfo().username.trim();
  type Line = { type: string; id?: string; outcome?: string; result?: { rows?: { name: string; sessionKind?: string }[] }; message?: { text: string; mentionsMe: boolean } };
  const session = (...args: string[]) => {
    const child = spawn(TSX, [CLI, "chat", "general", "--stdio", ...args], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    const s = { child, out: "", err: "", records: (): Line[] => s.out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Line) };
    child.stdout.on("data", (b: Buffer) => { s.out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { s.err += b.toString(); });
    return s;
  };
  const reply = async (s: ReturnType<typeof session>, id: string) => {
    for (let i = 0; i < 150 && !s.records().some((r) => r.id === id); i++) await sleep(200);
    return s.records().find((r) => r.id === id);
  };
  const named = async (peer: ReturnType<typeof session>, id: string) => ((await reply(peer, id))?.result?.rows ?? []).filter((r) => r.sessionKind === "chat").map((r) => r.name);
  const opened: ReturnType<typeof session>[] = [];
  try {
    const human = session();
    opened.push(human);
    human.child.stdin.write(request({ type: "connection", id: "c0" }));
    await reply(human, "c0");
    const peer = session("--name", "mention-peer");
    opened.push(peer);
    peer.child.stdin.write(request({ type: "roster", id: "r1" }));
    const roster = await named(peer, "r1");
    check("a session opened without --name is on the roster as the OS login, with no suffix", roster.includes(login), { login, roster, err: human.err });
    peer.child.stdin.write(request({ type: "send", id: "s1", channel: "general", text: `over to you @${login}`, mentions: [login] }));
    const mentioned = () => human.records().find((r) => r.type === "message" && r.message?.text === `over to you @${login}`);
    for (let i = 0; i < 150 && !mentioned(); i++) await sleep(200);
    check("a peer's send with mentions: [<login>] reaches it with mentionsMe: true", mentioned()?.message?.mentionsMe === true, { message: mentioned(), human: human.out.slice(-600) });

    const second = session();
    opened.push(second);
    second.child.stdin.write(request({ type: "connection", id: "c0" }));
    await reply(second, "c0");
    check("a second session under the same name is warned at join, naming both ways to change it",
      new RegExp(`cotal chat: the name "${login}" is already in use here by \\S+ \\(chat session\\); a direct message to "${login}" refuses as ambiguous while both are present, so pass another --name, or save one with \`cotal config set name <name>\`, to be reached by name`).test(plain(second.err)), plain(second.err));

    const saved = cli("config", "set", "name", "Ops Lead");
    const lead = session();
    opened.push(lead);
    lead.child.stdin.write(request({ type: "connection", id: "c0" }));
    await reply(lead, "c0");
    peer.child.stdin.write(request({ type: "roster", id: "r2" }));
    const after = await named(peer, "r2");
    check("a name saved with cotal config set name replaces the OS login", saved.status === 0 && after.includes("Ops Lead"), { after, saved: plain(saved.stdout + saved.stderr) });
  } finally {
    for (const s of opened) s.child.stdin.end();
    for (const s of opened) {
      const code = await new Promise<number | null>((r) => {
        const t = setTimeout(() => r(null), 30_000);
        s.child.once("exit", (c) => { clearTimeout(t); r(c); });
        if (s.child.exitCode !== null) { clearTimeout(t); r(s.child.exitCode); }
      });
      if (code === null) s.child.kill("SIGTERM");
    }
  }
} finally {
  const down = cli("down", "--yes");
  check("down stops the stack", down.status === 0, plain(down.stdout + down.stderr));
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  finish();
}
