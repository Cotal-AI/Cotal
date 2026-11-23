/**
 * Live broker-loss regression for chat's shared native session. Runs the shipped CLI in a private
 * home against an owned loopback broker. Retains records under CHAT_TRANSPORT_EVIDENCE or a fresh
 * scratch directory. Run: pnpm smoke:chat-transport:live (build the CLI first).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isReachable, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const root = process.env.CHAT_TRANSPORT_EVIDENCE ?? mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
mkdirSync(root, { recursive: true, mode: 0o700 });
const cli = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "HOME" && !key.startsWith("XDG_")));
Object.assign(env, { HOME: join(root, "home"), COTAL_HOME: join(root, "cotal"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"), COTAL_SKIP_CONNECTOR_SEED: "1" });
for (const name of ["home", "cotal", "config", "runtime"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const space = "chat-transport";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, timeout = 15_000): Promise<void> {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > timeout) throw new Error("timed out waiting for chat output");
    await wait(20);
  }
}
function broker(tag: string) {
  const store = join(root, SMOKE_BROKER_TOKEN);
  const child = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", store], { stdio: ["ignore", "pipe", "pipe"] });
  const release = teardownOnSignal(child);
  let log = "";
  child.stdout.on("data", (b: Buffer) => { log += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { log += b.toString(); });
  return { child, async stop() {
    await killAndAwaitExit(child, "SIGKILL");
    release();
    writeFileSync(join(root, `broker-${tag}.log`), log);
  } };
}
type RecordLine = { type: string; id?: string; scope?: string; outcome?: string; error?: { code: string; message: string }; result?: { state?: string; identity?: { principal: string; lifecycleUid: string } }; message?: { text: string } };
const clients: { close(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> }[] = [];
function open(name: string, mode: "stdio" | "plain" = "stdio") {
  const child = spawn(process.execPath, [cli, "chat", "general", `--${mode}`, "--space", space, "--name", name], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const records: { at: number; record: RecordLine }[] = [];
  let out = "", err = "", pending = "";
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stdout.on("data", (b: Buffer) => {
    out += b.toString();
    if (mode !== "stdio") return;
    pending += b.toString();
    let index: number;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line) records.push({ at: performance.now(), record: JSON.parse(line) as RecordLine });
    }
  });
  child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  let serial = 0;
  const client = { child, records, output: () => out.replace(/\x1b\[[0-9;]*m/g, ""),
    async request(type: string, fields = {}, id = `${name}-${++serial}`) {
      child.stdin.write(`${JSON.stringify({ schemaVersion: 1, type, id, ...fields })}\n`);
      await until(() => records.some(({ record }) => record.id === id));
      return records.find(({ record }) => record.id === id)!.record;
    },
    async close() {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 15_000); })]);
        clearTimeout(timer);
        await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000); })]);
        return await exited;
      } finally {
        clearTimeout(timer);
        writeFileSync(join(root, `${name}.stdout.log`), out);
        writeFileSync(join(root, `${name}.stderr.log`), err);
      }
    },
  };
  clients.push(client);
  return client;
}
const gaps = (client: ReturnType<typeof open>) => client.records.filter(({ record }) => record.type === "gap" && record.scope === "live");

async function checkSizeRefusal(chat: ReturnType<typeof open>): Promise<void> {
  const channel = "size.probe";
  const limit = 1_048_576;
  const bodyAtLimit = "é".repeat(limit / 2);
  const before = await chat.request("send", { channel, text: "before" });
  for (const text of [bodyAtLimit + "x", bodyAtLimit]) {
    const over = await chat.request("send", { channel, text });
    check(`a ${Buffer.byteLength(text)}-byte body that exceeds the limit with its envelope is refused`,
      over.outcome === "refused" && over.error?.code === "UNSUPPORTED" &&
      over.error.message.includes(`${limit}-byte message limit`) &&
      over.error.message.includes("nothing was stored") && /shorten.*split/i.test(over.error.message), over);
  }
  const after = await chat.request("send", { channel, text: "after" });
  check("chat keeps accepting valid posts after a size refusal", before.outcome === "stored" && after.outcome === "stored", { before, after });
  const history = spawnSync(process.execPath, [cli, "history", channel, "--space", space, "--json"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  const texts = history.status === 0 ? (JSON.parse(history.stdout).result.items as { text: string }[]).map(({ text }) => text) : undefined;
  check("only the valid posts appear in channel history", JSON.stringify(texts) === JSON.stringify(["before", "after"]), texts ?? history.stderr);
}

function checkPlainHistory(): void {
  const result = spawnSync(process.execPath, [cli, "chat", "--plain", "--space", space, "--name", "history-reader"], {
    cwd: root, env, encoding: "utf8", timeout: 30_000, input: "/history\n:to #general\n/history 1\n/quit\n",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  check("plain /history gives the :to remedy and reads the stored post after selecting a channel",
    result.status === 0 && output.includes("/history denied (USAGE_INVALID): enter :to #<channel>, then retry /history")
      && !output.includes("(Tab)") && /^\d[^\n]* #general [^\n]*: healthy-control$/m.test(output), output);
}

let srv = broker("initial");
const observations: unknown[] = [];
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: server, space });
  const added = spawnSync(process.execPath, [cli, "meshes", "add", space, "--server", server, "--mode", "open", "--root", root], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  writeFileSync(join(root, "meshes-add.log"), added.stdout + added.stderr);
  if (added.status !== 0) throw new Error(`mesh registration failed: ${added.status}`);
  const chat = open("outage-check");
  const peer = open("peer-listener");
  const initial = await chat.request("connection");
  check("positive control: both shipped sessions report connected", initial.result?.state === "connected" && (await peer.request("connection")).result?.state === "connected");
  const spaced = await chat.request("connection", {}, "request 1");
  check("a shipped session echoes the exact ID containing an ASCII space", spaced.type === "result" && spaced.id === "request 1"
    && spaced.outcome === "ok" && spaced.result?.state === "connected", spaced);
  const fromBoundary = chat.records.length;
  const cases = [["limit-lf", "\n"], ["limit-crlf", "\r\n"]] as const;
  for (const [id, eol] of cases) {
    const request = JSON.stringify({ schemaVersion: 1, type: "connection", id });
    chat.child.stdin.write(request.padEnd(1_048_576) + eol);
  }
  const afterBoundary = await chat.request("connection");
  const boundary = chat.records.slice(fromBoundary).map(({ record }) => record)
    .filter((r) => r !== afterBoundary && (r.type === "result" || r.type === "error"));
  check("a shipped session accepts requests at the line limit with LF and CRLF", boundary.length === 2
    && boundary.every((r, i) => r.type === "result" && r.id === cases[i]?.[0] && r.outcome === "ok"), boundary);
  const sent = await peer.request("send", { channel: "general", text: "healthy-control" });
  await until(() => chat.records.some(({ record }) => record.message?.text === "healthy-control"));
  await wait(1_000);
  check("positive control: a stored post arrives without a live gap", sent.outcome === "stored" && gaps(chat).length === 0);
  checkPlainHistory();
  await checkSizeRefusal(chat);

  for (const [tag, duration] of [["short", 5_000], ["sustained", 23_000]] as const) {
    const before = chat.records.length;
    const started = performance.now();
    await srv.stop();
    const states: string[] = [];
    while (performance.now() - started < duration) {
      states.push((await chat.request("connection")).result?.state ?? "missing");
      await wait(250);
    }
    const loss = chat.records.slice(before).filter(({ record }) => record.type === "gap" && record.scope === "live");
    const gapMs = loss[0] ? Math.round(loss[0].at - started) : null;
    const firstDown = states.findIndex((state) => state !== "connected");
    const observation = { tag, states, gapMs, gaps: loss.length, firstDownPoll: firstDown };
    observations.push(observation);
    console.log(JSON.stringify(observation));
    check(`${tag}: broker loss promptly reports disconnected and one live gap`, firstDown >= 0 && firstDown <= 4 && gapMs !== null && gapMs < 2_000 && loss.length === 1, observation);
    check(`${tag}: no connected report after observing the outage`, firstDown >= 0 && states.slice(firstDown).every((state) => state === "disconnected"), states);
    srv = broker(tag);
    await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
    let restored: RecordLine | undefined;
    for (let i = 0; i < 80; i++) {
      restored = await chat.request("connection");
      if (restored.result?.state === "connected" && (await peer.request("connection")).result?.state === "connected") break;
      await wait(250);
    }
    check(`${tag}: reconnect restores the same principal and lifecycle`, restored?.result?.state === "connected" && JSON.stringify(restored.result.identity) === JSON.stringify(initial.result?.identity), restored);
    const text = `after-${tag}`;
    const post = await peer.request("send", { channel: "general", text });
    await until(() => chat.records.some(({ record }) => record.message?.text === text));
    check(`${tag}: delivery resumes without another outage gap`, post.outcome === "stored" && gaps(chat).length === (tag === "short" ? 1 : 2));
  }
  const plain = open("manual", "plain");
  await until(() => plain.output().includes("] type a message"));
  const from = plain.output().length;
  plain.child.stdin.write("/reconnect\n");
  await until(() => plain.output().slice(from).includes("reconnected as the same session"));
  check("explicit reconnect still reports its outage once", (plain.output().slice(from).match(/gap: live:/g) ?? []).length === 1, plain.output().slice(from));
} finally {
  const exits = await Promise.all(clients.map((client) => client.close()));
  await srv.stop();
  writeFileSync(join(root, "summary.json"), JSON.stringify({ observations, exits }, null, 2) + "\n");
  check("all owned clients exit cleanly", exits.every(({ code }) => code === 0), exits);
  console.log(`Retained evidence: ${root}`);
}
finish();
