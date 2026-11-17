/**
 * The terminal app's remembered chat sessions: one private file per session under the Cotal home, read
 * back newest first for one space and broker, bounded per space, safe for app runs that write at once,
 * and removed by forget.
 *
 * A session is remembered as a 0600 file in 0700 folders and holds no credential. A space keeps its
 * newest 20. Three processes remembering sessions in one space at once leave 20 whole records and no
 * temporary file. A record that does not parse, one of a newer version, or one whose file is not
 * private is skipped with why, and the others still read. A folder another account could write, or
 * a link in its place, refuses the read. Forget removes one space's records and leaves the others.
 *
 * Run: pnpm smoke:chat-remembered   (no broker)
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mintLifecycleUid } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import type { SessionIdentity } from "../src/chat/session.js";

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-remembered-"));
process.env.COTAL_HOME = home;
const source = pathToFileURL(join(import.meta.dirname, "../src/chat/remembered.ts")).href;
const { REMEMBERED_CHAT_SESSIONS, forgetChatSessions, rememberChatSession, rememberedChatSessions } = await import(source) as typeof import("../src/chat/remembered.js");
const { spaceSegment } = await import(pathToFileURL(join(import.meta.dirname, "../src/auth-paths.ts")).href) as typeof import("../src/auth-paths.js");

const SERVER = "nats://127.0.0.1:4222";
const target = { space: "alpha", server: SERVER };
const identity = (n: number): SessionIdentity => ({
  mode: "open", space: target.space, principal: `local.actor${n}`, lifecycleUid: mintLifecycleUid(), label: `lead${n}`, allowSubscribe: [], allowPublish: [],
});
const folder = (space: string) => join(home, "chat-sessions", spaceSegment(space));
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const first = identity(0);
  rememberChatSession(target, first);
  const file = join(folder("alpha"), `${first.lifecycleUid}.json`);
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  check("a session is one 0600 file named by its lifecycle UID, in 0700 folders",
    mode(file) === "600" && mode(folder("alpha")) === "700" && mode(join(home, "chat-sessions")) === "700",
    { file: mode(file), space: mode(folder("alpha")), sessions: mode(join(home, "chat-sessions")) });
  check("the record holds the session's principal, uid, name, space, broker and time, and nothing else",
    JSON.stringify(Object.keys(saved).sort()) === JSON.stringify(["label", "lifecycleUid", "openedAt", "principal", "server", "space", "v"]) && saved.principal === first.principal && saved.label === "lead0",
    saved);
  const read = rememberedChatSessions(target);
  check("it reads back for the space at its broker", read.sessions.length === 1 && read.sessions[0]!.principal === first.principal && read.skipped.length === 0, read);
  check("a space of the same name at another broker reads none of it", rememberedChatSessions({ space: "alpha", server: "nats://127.0.0.1:4333" }).sessions.length === 0);
  check("another space reads none of it", rememberedChatSessions({ space: "beta", server: SERVER }).sessions.length === 0);

  const written = [first];
  for (let n = 1; n < REMEMBERED_CHAT_SESSIONS + 5; n++) {
    await sleep(2);
    written.push(identity(n));
    rememberChatSession(target, written.at(-1)!);
  }
  const kept = rememberedChatSessions(target).sessions;
  check(`a space keeps its newest ${REMEMBERED_CHAT_SESSIONS}, newest first`,
    JSON.stringify(kept.map((s) => s.lifecycleUid)) === JSON.stringify(written.slice(-REMEMBERED_CHAT_SESSIONS).reverse().map((s) => s.lifecycleUid)),
    { kept: kept.map((s) => s.label) });
  check(`the folder holds ${REMEMBERED_CHAT_SESSIONS} files`, readdirSync(folder("alpha")).length === REMEMBERED_CHAT_SESSIONS, readdirSync(folder("alpha")));

  // Three processes, each remembering 25 sessions in one space at once.
  rmSync(folder("alpha"), { recursive: true });
  const worker = (n: number) => new Promise<{ code: number | null; err: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { mintLifecycleUid } from "@cotal-ai/core";
      const { rememberChatSession } = await import(${JSON.stringify(source)});
      for (let i = 0; i < 25; i++) rememberChatSession(${JSON.stringify(target)}, { mode: "open", space: "alpha", principal: "local.w${n}x" + i, lifecycleUid: mintLifecycleUid(), label: "w${n}", allowSubscribe: [], allowPublish: [] });
    `], { cwd: import.meta.dirname, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, err }));
  });
  const runs = await Promise.all([0, 1, 2].map(worker));
  check("three app runs remembering at once all finish without an error", runs.every((r) => r.code === 0), runs.map((r) => r.err.trim().split("\n").at(-1)));
  const left = readdirSync(folder("alpha"));
  const after = rememberedChatSessions(target);
  check(`they leave ${REMEMBERED_CHAT_SESSIONS} whole records and no temporary file`,
    left.length === REMEMBERED_CHAT_SESSIONS && left.every((f) => f.endsWith(".json")) && after.sessions.length === REMEMBERED_CHAT_SESSIONS && after.skipped.length === 0,
    { files: left.length, stray: left.filter((f) => !f.endsWith(".json")), sessions: after.sessions.length, skipped: after.skipped });

  const torn = join(folder("alpha"), `${mintLifecycleUid()}.json`);
  writeFileSync(torn, "{\"v\":1,", { mode: 0o600 });
  const newer = join(folder("alpha"), `${mintLifecycleUid()}.json`);
  writeFileSync(newer, JSON.stringify({ v: 2, space: "alpha" }), { mode: 0o600 });
  const open = join(folder("alpha"), `${mintLifecycleUid()}.json`);
  writeFileSync(open, readFileSync(join(folder("alpha"), left[0]!), "utf8"), { mode: 0o644 });
  chmodSync(open, 0o644);
  const mixed = rememberedChatSessions(target);
  const reason = (path: string) => mixed.skipped.find((s) => s.path === path)?.reason ?? "";
  check("a record that does not parse, one of a newer version and a file that is not private are skipped, and the others still read",
    mixed.sessions.length === REMEMBERED_CHAT_SESSIONS && mixed.skipped.length === 3 && /not valid UTF-8 JSON/.test(reason(torn)) && /record version 2/.test(reason(newer)) && /not owned and private/.test(reason(open)),
    mixed.skipped);
  for (const path of [torn, newer, open]) rmSync(path);

  chmodSync(folder("alpha"), 0o777);
  let refused: string | undefined;
  try { rememberedChatSessions(target); } catch (e) { refused = (e as Error).message; }
  check("a folder every account can write refuses the read", refused?.includes("writable by every local account") === true, refused);
  chmodSync(folder("alpha"), 0o700);

  const moved = join(home, "elsewhere");
  renameSync(join(home, "chat-sessions"), moved);
  symlinkSync(moved, join(home, "chat-sessions"));
  let linked: string | undefined;
  try { rememberedChatSessions(target); } catch (e) { linked = (e as Error).message; }
  check("a link in place of the folder refuses the read", linked?.includes("symbolic link") === true, linked);
  rmSync(join(home, "chat-sessions"));
  renameSync(moved, join(home, "chat-sessions"));

  rememberChatSession({ space: "beta", server: SERVER }, { ...identity(99), space: "beta" });
  check("forget counts the space's records and removes them", forgetChatSessions("alpha") === REMEMBERED_CHAT_SESSIONS && rememberedChatSessions(target).sessions.length === 0);
  check("forget leaves another space's records", rememberedChatSessions({ space: "beta", server: SERVER }).sessions.length === 1);
  check("forget of a space with none removes nothing", forgetChatSessions("alpha") === 0);
} finally {
  rmSync(home, { recursive: true, force: true });
}
finish();
