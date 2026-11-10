/**
 * LIVE: two shipped `cotal chat` terminal views on an isolated static stack.
 * A slash command is local, :to refuses without posting it or the following private line, and
 * the existing Tab picker still selects DMs and channels. Retains terminal output and history.
 * Run: pnpm smoke:chat-recipient:live
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Socket } from "node:net";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { clean, COTAL, cotalPty, repoRoot, wait, type Pty } from "./_console-pty.js";

const home = mkdtempSync(join(tmpdir(), "cotal-chat-recipient-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-chat-recipient-root-"));
const configDir = join(home, "xdg");
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const evidence = process.env.CHAT_RECIPIENT_EVIDENCE ?? join(home, "evidence");
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, "sandbox.json"), JSON.stringify({ home, root }));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_")) env[key] = value;
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", TERM: "xterm-256color", FORCE_COLOR: "0" });
const { check, finish } = createSuite();
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), COTAL, ...args], options);
};
async function until(done: () => boolean, ms = 30_000): Promise<boolean> {
  for (const start = Date.now(); Date.now() - start < ms; await wait(100)) if (done()) return true;
  return done();
}
const sessions: { name: string; pty: Pty; raw: string; exit: number | undefined }[] = [];
function open(name: string, server?: string) {
  const pty = cotalPty(["chat", "general", "--name", name, ...(server ? ["--server", server] : [])], { cwd: root, env, cols: 120, rows: 40 });
  const session = { name, pty, raw: "", exit: undefined as number | undefined };
  pty.onData((data) => { session.raw += data; });
  pty.onExit(({ exitCode }) => { session.exit = exitCode; });
  sessions.push(session);
  return session;
}
// Delay only broker replies, so the real publisher remains in flight while the composer changes.
let holdReplies = false;
const held: { socket: Socket; data: Buffer }[] = [];
const sockets = new Set<Socket>();
let relay: ReturnType<typeof createServer> | undefined;
function release(): void {
  holdReplies = false;
  for (const { socket, data } of held.splice(0)) if (!socket.destroyed) socket.write(data);
}
async function line(session: ReturnType<typeof open>, text: string): Promise<void> {
  const from = session.raw.length;
  session.pty.write(text);
  if (!await until(() => clean(session.raw.slice(from)).includes(text))) throw new Error(`composer did not paint ${JSON.stringify(text)}`);
  session.pty.write("\r");
  await wait(1000);
}
function history(label: string, ...args: string[]): string {
  const result = cli("history", ...args, "--plain");
  writeFileSync(join(evidence, `${label}.txt`), `status=${result.status}\n${result.stdout}\n${result.stderr}`);
  check(`${label} history read succeeds`, result.status === 0, result.stderr);
  return clean(result.stdout);
}

try {
  const port = await freePort();
  const up = cli("up", "--detach", "--server", `nats://127.0.0.1:${port}`);
  writeFileSync(join(evidence, "up.txt"), `status=${up.status}\n${up.stdout}\n${up.stderr}`);
  if (up.status !== 0) throw new Error(`isolated stack failed: ${up.stderr}`);
  if (!await until(() => cli("ps").status === 0)) throw new Error("isolated manager did not answer");
  const ana = open("ana");
  const bo = open("bo");
  for (const session of sessions) {
    if (!await until(() => clean(session.raw).includes("Enter send"))) throw new Error(`${session.name} did not open the terminal composer`);
  }
  await wait(2000);
  await line(bo, "/who");
  check("positive control: /who runs locally and lists ana", clean(bo.raw).includes("ana"), clean(bo.raw).slice(-1500));
  const control = history("control-general", "general");
  check("positive control: /who stores no channel message", /0 messages/.test(control), control);

  await line(bo, ":to @ana");
  await line(bo, "private hi ana");
  const channel = history("private-general", "general");
  const directed = history("private-dms", "--dms");
  check(":to and the private line never enter channel history", !channel.includes(":to @ana") && !channel.includes("private hi ana"), channel);
  check("the refused command and following line store no message", /0 messages/.test(directed), directed);
  check("the terminal explains :to is refused", clean(bo.raw).includes(":to is only available in --plain"), clean(bo.raw).slice(-2000));

  // Cancel the picker after the refused line. It must not restore the previous channel.
  bo.pty.write("\x1b");
  await wait(400);
  await line(bo, "still private");
  const cancelled = history("cancelled-general", "general");
  check("cancelling the picker does not restore the previous destination", /0 messages/.test(cancelled), cancelled);
  // Choose a real DM through the existing picker. The held draft is sent only after that choice.
  await line(bo, "@ana");
  bo.pty.write("\r");
  await until(() => clean(ana.raw).includes("still private"));
  const dm = history("selected-dms", "--dms");
  check("choosing @ana sends the held draft as a DM", /DM[^\n]*still private/.test(dm), dm);
  check("ana receives the chosen DM", /DM[^\n]*still private/.test(clean(ana.raw)), clean(ana.raw).slice(-2000));

  bo.pty.write("\t");
  await wait(400);
  await line(bo, "#general");
  await line(bo, "public hello");
  await until(() => clean(ana.raw).includes("public hello"));
  const publicHistory = history("public-general", "general");
  check("switching back posts only the public line", publicHistory.includes("public hello") && !publicHistory.includes(":to ") && !publicHistory.includes("private hi ana") && !publicHistory.includes("still private"), publicHistory);

  relay = createServer((client) => {
    const upstream = connect(port, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (data) => upstream.write(data));
    upstream.on("data", (data: Buffer) => {
      if (holdReplies) held.push({ socket: client, data: Buffer.from(data) });
      else client.write(data);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => { upstream.destroy(); sockets.delete(client); });
    upstream.on("close", () => { client.destroy(); sockets.delete(upstream); });
  });
  await new Promise<void>((resolve, reject) => {
    relay!.once("error", reject);
    relay!.listen(0, "127.0.0.1", resolve);
  });
  const address = relay.address();
  if (!address || typeof address === "string") throw new Error("relay did not bind a loopback port");
  const delayed = open("delayed", `nats://127.0.0.1:${address.port}`);
  if (!await until(() => clean(delayed.raw).includes("Enter send"))) throw new Error("delayed chat did not open");
  holdReplies = true;
  await line(delayed, "public before switch");
  if (!await until(() => held.length > 0 && clean(ana.raw).includes("public before switch"))) throw new Error("publish did not reach broker with its reply held");
  // Each backspace must be a key, not one pasted burst of control bytes.
  for (let i = 0; i < "public before switch".length; i++) { delayed.pty.write("\x7f"); await wait(70); }
  await line(delayed, ":to @ana");
  check("a pending publish does not prevent immediate :to refusal", clean(delayed.raw).includes(":to is only available in --plain"));
  writeFileSync(join(evidence, "before-release-screen.txt"), clean(delayed.raw));
  release();
  if (!await until(() => /you[^\n]*\[stored\]: public before switch/.test(clean(delayed.raw)))) throw new Error("delayed publish did not settle");
  writeFileSync(join(evidence, "after-release-screen.txt"), clean(delayed.raw));
  delayed.pty.write("\x1b");
  await wait(400);
  await line(delayed, "private after delayed publish");
  const concurrent = history("delayed-general", "general");
  check("a delayed publish completion cannot restore the previous channel", !concurrent.includes("private after delayed publish"), concurrent);
  // Explicit choice still delivers the draft held after completion.
  await line(delayed, "@ana");
  delayed.pty.write("\r");
  if (!await until(() => clean(ana.raw).includes("private after delayed publish"))) throw new Error("held draft was not delivered after explicit DM choice");
  const recovered = history("delayed-dms", "--dms");
  check("explicit DM choice recovers after delayed publish", /DM[^\n]*private after delayed publish/.test(recovered), recovered);

  delayed.pty.write("\t");
  await wait(400);
  await line(delayed, "#general");
  holdReplies = true;
  await line(delayed, "/status waiting");
  if (!await until(() => held.length > 0)) throw new Error("slash command did not await a broker reply");
  await line(delayed, ":to @ana");
  if (!clean(delayed.raw).includes(":to is only available in --plain")) throw new Error("slash-crossing refusal did not run");
  delayed.pty.write("\x1b");
  await wait(400);
  await line(delayed, "private during command");
  release();
  if (!await until(() => clean(delayed.raw).includes("/status done"))) throw new Error("delayed slash command did not settle");
  // The no-recipient Enter reopened the picker. Cancel and submit the held draft again.
  delayed.pty.write("\x1b");
  await wait(400);
  delayed.pty.write("\r");
  await wait(700);
  const slashHistory = history("delayed-slash-general", "general");
  check("a delayed command completion cannot restore the previous channel", !slashHistory.includes("private during command"), slashHistory);
  await line(delayed, "@ana");
  delayed.pty.write("\r");
  if (!await until(() => clean(ana.raw).includes("private during command"))) throw new Error("command completion lost the held draft");
  const slashDm = history("delayed-slash-dms", "--dms");
  check("a delayed command preserves the held draft for explicit DM choice", /DM[^\n]*private during command/.test(slashDm), slashDm);
} finally {
  release();
  for (const session of sessions) {
    if (session.exit === undefined) {
      session.pty.write("\x03");
      await wait(300);
      if (session.exit === undefined) session.pty.write("\x03");
      if (!await until(() => session.exit !== undefined)) {
        session.pty.kill();
        if (!await until(() => session.exit !== undefined)) throw new Error(`${session.name} did not exit`);
      }
    }
    writeFileSync(join(evidence, `${session.name}-screen.txt`), clean(session.raw));
    check(`${session.name} exits cleanly`, session.exit === 0, session.exit);
  }
  for (const socket of sockets) socket.destroy();
  if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
  const down = cli("down", "--yes");
  writeFileSync(join(evidence, "down.txt"), `status=${down.status}\n${down.stdout}\n${down.stderr}`);
  check("only the isolated stack is stopped", down.status === 0, down.stderr);
  console.log(`Evidence: ${evidence}`);
}
finish();
