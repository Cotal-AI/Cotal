/** Personal lifecycle capture uses ordinary command hooks. The native security guard intentionally
 * keeps classic.* out of user modules; it still permits these unchanged command-hook events. */
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core/secret-fs";
import { nativeSocketPath, WAKE_ID, wakeSockets } from "./wake-feed.js";

function stateFile(session: string): string {
  if (!WAKE_ID.test(session)) throw new Error("invalid native session identity");
  const root = join(tmpdir(), `cotal-claude-native-${process.getuid?.() ?? "local"}`);
  const st = lstatSync(root, { throwIfNoEntry: false });
  if (st && (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())))
    throw new Error("native session state is not this user's private directory");
  mkSecretDir(root);
  return join(root, `${session}.json`);
}

function readRecord(file: string): Record<string, unknown> | undefined {
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (!st.isFile() || st.size > 16_384 || (process.getuid && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)))
    throw new Error("native session state is not an owner-private bounded regular file");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid native session state");
  return value as Record<string, unknown>;
}

function transcriptMatches(session: string, path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && basename(path) === `${session}.jsonl`;
}

export function readPersonalBinding(session: string): Record<string, unknown> {
  const event = readRecord(stateFile(session));
  if (!event || event.session_id !== session || !transcriptMatches(session, event.transcript_path))
    throw new Error("no native command-hook transcript binding for this session");
  return event;
}

async function forward(event: Record<string, unknown>, hostPid: number): Promise<void> {
  const paths = wakeSockets(hostPid);
  if (!paths.length) throw new Error("no local native lifecycle server");
  await Promise.all(paths.map((path) => new Promise<void>((resolve, reject) => {
    const socket = createConnection(nativeSocketPath(path));
    let reply = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("native lifecycle relay timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ op: "native", event })}\n`));
    socket.on("data", (data: string) => { reply += data; if (reply.length > 128) socket.destroy(); });
    socket.on("error", reject);
    socket.on("close", () => {
      try { if (JSON.parse(reply).ok === true) resolve(); else reject(new Error("native lifecycle binding refused")); }
      catch { reject(new Error("native lifecycle binding was not confirmed")); }
    });
  })));
}

/** The native module supplies its host pid. Keep it separate so simultaneous command hooks cannot
 * overwrite the route while saving newer metadata. No identity is inferred from a lone server. */
export async function bindPersonalSession(event: Record<string, unknown>, hostPid: number): Promise<void> {
  const session = event.session_id;
  if (typeof session !== "string" || !Number.isInteger(hostPid) || hostPid <= 0)
    throw new Error("invalid native lifecycle binding");
  const previous = readPersonalBinding(session);
  if (previous.transcript_path !== event.transcript_path)
    throw new Error("native lifecycle binding does not match the command hook");
  writeSecretFileAtomic(`${stateFile(session)}.host`, JSON.stringify({ hostPid }));
  await forward(event, hostPid);
}

/** Only bounded metadata crosses this pipe. Prompts, arguments, results and error details do not. */
export async function observePersonalHook(value: unknown): Promise<void> {
  if (!value || typeof value !== "object") return;
  const event = value as Record<string, unknown>;
  if (event.agent_id !== undefined || typeof event.session_id !== "string" || !WAKE_ID.test(event.session_id) ||
      !transcriptMatches(event.session_id, event.transcript_path) || typeof event.hook_event_name !== "string") return;
  if (!["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolBatch", "Notification", "Stop", "StopFailure", "SessionEnd"].includes(event.hook_event_name)) return;
  const file = stateFile(event.session_id);
  const previous = readRecord(file);
  if (previous && previous.transcript_path !== event.transcript_path)
    throw new Error("native command hook changed its session transcript");
  const safe: Record<string, string> = {};
  for (const key of ["hook_event_name", "session_id", "transcript_path", "cwd", "source", "notification_type", "error", "model"])
    if (typeof event[key] === "string" && event[key].length <= 4_096) safe[key] = event[key];
  if (JSON.stringify(safe).length > 8_192) throw new Error("native command-hook metadata is too large");
  writeSecretFileAtomic(file, JSON.stringify(safe));
  const target = readRecord(`${file}.host`);
  if (target) {
    if (!Number.isInteger(target.hostPid) || (target.hostPid as number) <= 0) throw new Error("invalid native lifecycle host");
    await forward(safe, target.hostPid as number);
  }
  if (event.hook_event_name === "SessionEnd") {
    unlinkSync(file);
    if (target) unlinkSync(`${file}.host`);
  }
}
