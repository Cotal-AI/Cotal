/**
 * The standalone I/O helpers of the OpenCode 1.x plugin (`plugin.ts`): the retired-session WAL reap,
 * the authenticated OpenCode HTTP client, and the two `session.error` readers. They close over only
 * values `cotal` fixes before it builds them, so they live here behind an explicit deps object.
 */
import { EventWal, eventWalLocation, resolveEventsStateRoot, type AgentConfig, type MeshAgent } from "@cotal-ai/connector-core";
import { principalKey } from "@cotal-ai/core";
import { rm, rmdir } from "node:fs/promises";
import { log, WAL_REAPED, WAL_KEPT } from "./plugin-seams.js";

/** What the helpers read from `cotal`: all four are fixed before `pluginIo` is called and never rebound. */
export interface PluginIoDeps {
  agent: MeshAgent;
  config: AgentConfig;
  serverUrl: string;
  serverAuth: string;
}

export interface PluginIo {
  reapRetiredWal(threadId: string, drained: boolean): Promise<void>;
  /** An answer that is not 2xx throws an Error carrying the HTTP `status`. */
  opencodeApi<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T>;
  isMessageAbortedError(error: unknown): boolean;
  runErrorOf(error: unknown): { message: string; code?: string };
}

export function pluginIo(deps: PluginIoDeps): PluginIo {
  const { agent, config, serverUrl, serverAuth } = deps;

  /**
   * REAP A RETIRED SESSION'S WRITE-AHEAD LOG, AND THE LIFETIME IS THE DECISION HERE, not the two
   * unlinks that carry it out.
   *
   * A log exists so a later start can recover what its thread had NOT yet published: the one frame
   * it froze before publishing, and the position it had reached. Removing it while either still
   * matters destroys exactly what it is for, which is why the rule is a property of the log rather
   * than a step in the swap:
   *
   *   a thread's log may be removed once (a) this connector has closed that thread's run on the wire
   *   and the drain that did it SETTLED rather than spending its bound, and (b) the log on disk holds
   *   no pending frame.
   *
   * (a) is the connector's half. An abandoned drain is uncancelled work that may still write here,
   * and a directory removed out from under it turns a bounded delay into a lost frame. (b) is the
   * log's own half and is the half that is actually about recovery: a pending frame is one whose
   * fate the broker never confirmed, and only a start that reads this file can settle it.
   *
   * WHAT IS DELIBERATELY NOT REAPED, so the claim is not read wider than it is. The LIVE thread's
   * directory survives teardown: a process leaves exactly ONE behind rather than one per `/new`,
   * which is the accumulation #599 names, and that one is kept because a teardown is not a
   * retirement, since no observer has been told the thread ended, and a start that adopts it again is
   * precisely the case the log is for. The principal's own `subject.json` and `.lock` sit one level
   * up, are shared by every thread, and are not this directory's to remove.
   *
   * The log is read back FROM DISK rather than from the retired emitter's object, because the
   * emitter has been released by this point and the file is the only authority on what it left. A
   * log that cannot be read is KEPT: this is a cleanup and never a repair.
   */
  async function reapRetiredWal(threadId: string, drained: boolean): Promise<void> {
    // (a), AND IT IS FIRST BECAUSE IT IS THE CHEAPEST WAY TO BE WRONG. An abandoned drain is
    // uncancelled work that may still write into this directory, so removing it turns a bounded
    // delay into a lost frame. The decision lives here, next to the lifetime it belongs to, rather
    // than at the call site: a caller holding half the rule is how the easy half gets shipped alone.
    if (!drained) {
      log(`${WAL_KEPT} ${threadId}: its drain spent the bound, so it may still be writing`);
      return;
    }
    const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
    const { threadDir, walPath, deltaJournalPath } = eventWalLocation({
      workspaceRoot: resolveEventsStateRoot(process.env),
      space: config.space,
      principal,
      threadId,
    });
    try {
      const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
      // (b), AND THIS IS THE HALF THAT IS ACTUALLY ABOUT RECOVERY. A pending frame is one whose fate
      // the broker never confirmed, and only a start that reads this file can settle it.
      if (wal.pending !== null) {
        log(`${WAL_KEPT} ${threadId}: a frame is still pending, which is the one thing a later start recovers`);
        return;
      }
    } catch (e) {
      log(`${WAL_KEPT} ${threadId}: its log could not be read (${(e as Error).message})`);
      return;
    }
    // NEVER A RECURSIVE REMOVE. `rm` here is `force` but NOT `recursive`, so it can only ever unlink
    // the two files this layout puts in the directory, the WAL and the delta journal that lives and
    // dies with it, and `rmdir` then refuses outright if anything else is in there. A computed path
    // plus a recursive delete is one wrong component away from taking a tree with it, and the
    // components here are hashes of values from outside this process.
    try {
      await rm(walPath, { force: true });
      await rm(deltaJournalPath, { force: true });
      await rmdir(threadDir);
      log(`${WAL_REAPED} ${threadId}`);
    } catch (e) {
      log(`${WAL_KEPT} ${threadId}: ${(e as Error).message}`);
    }
  }

  async function opencodeApi<T>(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
    const res = await fetch(`${serverUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: serverAuth,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw Object.assign(new Error(`OpenCode HTTP ${res.status} ${res.statusText} for ${path}`), { status: res.status });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  function isMessageAbortedError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "MessageAbortedError";
  }

  /**
   * The failure a `session.error` reports, in the shape `RUN_ERROR` takes.
   *
   * OpenCode's error is a TAGGED UNION — `ProviderAuthError`, `APIError`, `MessageOutputLengthError`,
   * `UnknownError`, `MessageAbortedError` — with the tag on `name` and the human-readable reason on
   * `data.message`. The tag is published as the code and the reason as the message, both verbatim:
   * this connector does not rank one failure kind above another, it names the one OpenCode named.
   *
   * `error` is OPTIONAL on the bus event, and an error-less `session.error` is still a failed turn —
   * it just cannot say which kind, so it gets a message and no code rather than being demoted to a
   * finish. `MessageOutputLengthError` carries no `message` either and lands on the same fallback.
   */
  function runErrorOf(error: unknown): { message: string; code?: string } {
    const e = (typeof error === "object" && error !== null ? error : {}) as {
      name?: unknown;
      data?: { message?: unknown };
    };
    const code = typeof e.name === "string" && e.name ? e.name : undefined;
    const message = typeof e.data?.message === "string" && e.data.message ? e.data.message : undefined;
    return {
      message: message ?? `opencode turn failed${code ? `: ${code}` : ""}`,
      ...(code ? { code } : {}),
    };
  }

  return { reapRetiredWal, opencodeApi, isMessageAbortedError, runErrorOf };
}
