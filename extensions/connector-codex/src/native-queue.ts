/**
 * How a personal Codex conversation's Cotal server reaches the conversation it serves without owning
 * it: a separate `codex app-server` over the same `CODEX_HOME`, speaking only the native thread and
 * queue methods. It never starts, resumes or steers the thread. `thread/queue/add` writes Codex's own
 * durable queue, and the process that owns the thread starts the queued turn when the thread is idle
 * (it checks the queue about every 10 s). Measured on codex-cli 0.156.1, 0.163.0 and
 * 0.166.0-alpha.6.
 *
 * Codex does not deduplicate by `clientUserMessageId`: two adds with one id start two turns. So the
 * id carries a Cotal prefix, and an add first reads the queue and adds nothing while a notice under
 * the same key waits. An add whose outcome is unknown counts as failed; the next offer reads the
 * queue again, so a notice that did land is not added twice. A duplicate notice can only point at an
 * empty inbox; a missed one is offered again on the next arrival.
 *
 * Errors carry fixed text. Nothing Codex returns is repeated, so no path or content leaks into a log
 * or a tool result.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readlinkSync, readSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { findRollout } from "./agui-rollout.js";

const RPC_MS = 15_000;
const LIST_PAGE = 100;
/** How much of a rollout's first record is read to check whose it is. */
const META_BYTES = 256 * 1024;

/** What Codex records about the thread a call came from. */
export interface CodexThreadFacts {
  id: string;
  /** The thread's rollout file, or undefined for a thread Codex does not persist. */
  path?: string;
  cwd: string;
}

interface Queued { id: string; clientUserMessageId: string }

/** The executable of the Codex process that launched this server. The plugin's server is that
 *  process's direct child, so its own binary, and so its own queue semantics, answer for it. */
export function codexParentBinary(ppid: number = process.ppid): string {
  let bin: string;
  if (process.platform === "linux") bin = readlinkSync(`/proc/${ppid}/exe`);
  else if (process.platform === "darwin") bin = execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8", timeout: 5_000 }).trim();
  else throw new Error(`Cotal cannot wake a Codex conversation on ${process.platform}`);
  if (!isAbsolute(bin) || !/^codex/.test(basename(bin))) throw new Error("this Cotal server was not started by Codex");
  return bin;
}

/** The rollout Codex named for `threadId`, accepted only when the link-refusing walk of this home
 *  finds that same file and its first record is that thread's own session record. */
function checkRollout(codexHome: string, threadId: string, reported: string): string {
  const found = findRollout(codexHome, threadId);
  if (!found || resolve(found) !== resolve(reported)) throw new Error("Codex's record of this conversation is not in its own home");
  const fd = openSync(found, "r");
  let first: string;
  try {
    const buf = Buffer.alloc(META_BYTES);
    first = buf.subarray(0, readSync(fd, buf, 0, META_BYTES, 0)).toString("utf8").split("\n")[0] ?? "";
  } finally { closeSync(fd); }
  let meta: { type?: unknown; payload?: { id?: unknown } } | undefined;
  try { meta = JSON.parse(first); } catch { meta = undefined; }
  if (meta?.type !== "session_meta" || meta.payload?.id !== threadId) throw new Error("Codex's record of this conversation names another conversation");
  return found;
}

export class CodexController {
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** One queue change per thread at a time, so a read-then-add cannot race another. */
  private readonly serial = new Map<string, Promise<unknown>>();

  constructor(private readonly o: { bin: string; env: NodeJS.ProcessEnv; codexHome: string }) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const env: NodeJS.ProcessEnv = { ...this.o.env, CODEX_HOME: this.o.codexHome };
    for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
    const child = spawn(this.o.bin, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(error); this.waiting.delete(id); }
    };
    child.on("error", () => fail(new Error("the Codex controller could not start")));
    child.on("close", () => fail(new Error("the Codex controller exited")));
    child.stdin!.on("error", () => {});
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let m: { id?: number; result?: unknown; error?: unknown };
      try { m = JSON.parse(line); } catch { return; }
      const w = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
      if (!w) return;
      this.waiting.delete(m.id!);
      clearTimeout(w.timer);
      if (m.error !== undefined) w.reject(new Error("Codex refused the request"));
      else w.resolve(m.result);
    });
    this.ready = this.send("initialize", { clientInfo: { name: "cotal", title: "Cotal", version: "1" }, capabilities: { experimentalApi: true } })
      .then(() => { child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`); });
    this.ready.catch(() => {});
    return this.ready;
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("the Codex controller is not running"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`Codex did not answer ${method}`)); }, RPC_MS);
      this.waiting.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private async call(method: string, params: unknown): Promise<Record<string, unknown>> {
    await this.start();
    try { return (await this.send(method, params)) as Record<string, unknown>; }
    catch (e) { throw new Error(`${(e as Error).message} (${method})`); }
  }

  /** The thread as Codex records it, with its rollout checked to be its own, in this home. */
  async read(threadId: string): Promise<CodexThreadFacts> {
    const thread = (await this.call("thread/read", { threadId, includeTurns: false })).thread as Record<string, unknown> | undefined;
    if (!thread || thread.id !== threadId || typeof thread.cwd !== "string" || !isAbsolute(thread.cwd))
      throw new Error("Codex returned no record of this conversation");
    const path = thread.path;
    if (path !== null && path !== undefined && typeof path !== "string") throw new Error("Codex returned no record of this conversation");
    return { id: threadId, cwd: thread.cwd, ...(typeof path === "string" ? { path: checkRollout(this.o.codexHome, threadId, path) } : {}) };
  }

  private async list(threadId: string): Promise<Queued[]> {
    const all: Queued[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.call("thread/queue/list", { threadId, limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
      for (const q of (page.data as Queued[] | undefined) ?? []) all.push(q);
      cursor = page.nextCursor as string | null | undefined;
    } while (cursor);
    return all;
  }

  private alone<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.serial.get(threadId) ?? Promise.resolve()).then(run, run);
    this.serial.set(threadId, next.catch(() => {}));
    return next;
  }

  /** Refuse unless this Codex serves the queue for the thread. */
  async supported(threadId: string): Promise<void> {
    try { await this.list(threadId); }
    catch { throw new Error("this Codex cannot queue a turn for this conversation; update Codex to a release with thread/queue/add"); }
  }

  /** Queue `text` under `key` unless a submission with that key is already waiting. True when this
   *  call queued it. */
  offer(threadId: string, key: string, text: string): Promise<boolean> {
    return this.alone(threadId, async () => {
      if ((await this.list(threadId)).some((q) => q.clientUserMessageId.startsWith(key))) return false;
      await this.call("thread/queue/add", { threadId, clientUserMessageId: `${key}${Date.now().toString(36)}`, input: [{ type: "text", text }] });
      return true;
    });
  }

  /** Remove every waiting submission whose key starts with `key` and that `keep` does not keep. */
  withdraw(threadId: string, key: string, keep: (clientUserMessageId: string) => boolean = () => false): Promise<number> {
    return this.alone(threadId, async () => {
      let removed = 0;
      for (const q of await this.list(threadId)) {
        if (!q.clientUserMessageId.startsWith(key) || keep(q.clientUserMessageId)) continue;
        if ((await this.call("thread/queue/delete", { threadId, queuedSubmissionId: q.id })).deleted === true) removed++;
      }
      return removed;
    });
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    child?.kill("SIGTERM");
  }
}
