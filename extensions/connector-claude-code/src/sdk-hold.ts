/**
 * Keeping a conversation reachable when an Agent SDK host runs it. Such a host, T3 Code among them,
 * stops an idle session's Claude Code process: T3 Code does so 30 minutes after the last turn. That
 * ends this plugin's server, the conversation's Cotal connection and its native reader, so a later
 * message wakes nothing. A host keeps a session that has a background task running, so the
 * conversation runs a silent hold (`monitor.cjs --hold <session>`) as one.
 *
 * Claude Code stops a background command at its `timeout`, 30 minutes unless the call sets a longer
 * one and 2 hours at most, and tells Claude not to restart one that had the longest. So the hold is
 * started with the longest timeout and ends by itself before it, with a line that asks Claude to
 * start the next. That is one short turn every HOLD_MS while the conversation is otherwise idle.
 *
 * Claude may still not start one. So the server marks each session it holds a connection for, the
 * hold marks itself, and the plugin's Stop hook does not let such a session end a turn without a
 * live hold ({@link holdAnswer}). Each mark names the pid that keeps it, so a mark whose process
 * ended counts as gone.
 */
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The longest `timeout` Claude Code allows a background command. */
export const HOLD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** How long one hold runs before it ends and asks for the next: inside HOLD_TIMEOUT_MS. */
export const HOLD_MS = 110 * 60 * 1000;

/** A Claude Code session id as a mark's file name may carry it. */
export const HOLD_SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/** Whether an Agent SDK host runs this session, from the entrypoint Claude Code exports. */
export function sdkHosted(env: NodeJS.ProcessEnv): boolean {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? "";
  return entrypoint.startsWith("sdk-") || entrypoint === "t3-code";
}

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The command that runs a hold for `session`, from a bundle beside `monitor.cjs`. */
export function holdCommand(node: string, bundlePath: string, session: string): string {
  return `${quote(node)} ${quote(join(dirname(bundlePath), "monitor.cjs"))} --hold ${session}`;
}

/** How to start a hold, which the advice, a hold's last line and the Stop hook all give. */
const howToRun = (command: string) =>
  `with the Bash tool, run_in_background set to true and timeout set to ${HOLD_TIMEOUT_MS}: ${command}`;

/** What `cotal_connect` adds in such a session. */
export function holdAdvice(command: string): string {
  return "This session runs under a host that stops an idle session (T3 Code does after 30 minutes), " +
    `which disconnects Cotal and stops incoming messages from waking you. To stay reachable, now run this ${howToRun(command)}\n` +
    "It prints nothing while it runs, and ends by itself after a while with a line that asks you to run it again; do so each time. " +
    "Stop it only after cotal_disconnect.";
}

/** What a hold prints when it ends, which wakes the conversation to start the next one. */
export function holdEnded(command: string): string {
  return `Cotal: this session's hold ended on schedule. To stay reachable on Cotal, run it again now ${howToRun(command)}`;
}

/** This user's private directory of marks. Windows' temporary directory is already per user. */
function markDir(): string {
  if (process.platform === "win32") {
    const dir = join(tmpdir(), "cotal-claude-hold");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const uid = process.getuid!();
  const dir = join(tmpdir(), `cotal-claude-hold-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) throw new Error(`${dir} is not a private directory of this user's`);
  return dir;
}

const markPath = (session: string, kind: "need" | "hold") => {
  if (!HOLD_SESSION.test(session)) throw new Error("invalid session id for a hold mark");
  return join(markDir(), `${session}.${kind}`);
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function marked(session: string, kind: "need" | "hold"): boolean {
  let pid: number;
  try { pid = Number(readFileSync(markPath(session, kind), "utf8")); }
  catch { return false; }
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}

/** Mark `session` as one this process holds a Cotal connection for, or clear that mark. */
export function markNeeded(session: string, needed: boolean): void {
  if (needed) writeFileSync(markPath(session, "need"), String(process.pid), { mode: 0o600 });
  else rmSync(markPath(session, "need"), { force: true });
}

/** Mark this process as `session`'s hold until it exits. */
export function markHold(session: string): void {
  const path = markPath(session, "hold");
  writeFileSync(path, String(process.pid), { mode: 0o600 });
  process.once("exit", () => {
    try { if (readFileSync(path, "utf8") === String(process.pid)) rmSync(path, { force: true }); } catch { /* already gone */ }
  });
}

/** The Stop hook's answer in such a session: a session with a Cotal connection and no live hold
 *  does not end its turn until it starts one. A Stop that a block already continued passes. */
export function holdAnswer(event: unknown, session: { managed: boolean }): Record<string, unknown> | undefined {
  if (session.managed || !sdkHosted(process.env)) return undefined;
  const ev = event as { hook_event_name?: unknown; stop_hook_active?: unknown; session_id?: unknown; agent_id?: unknown } | null;
  if (ev?.hook_event_name !== "Stop" || ev.stop_hook_active === true || ev.agent_id !== undefined) return undefined;
  const id = ev.session_id;
  if (typeof id !== "string" || !HOLD_SESSION.test(id) || !marked(id, "need") || marked(id, "hold")) return undefined;
  return { decision: "block", reason: holdAdvice(holdCommand(process.execPath, process.argv[1] ?? "", id)) };
}
