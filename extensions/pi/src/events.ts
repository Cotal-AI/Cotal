import { principalKey } from "@cotal-ai/core";
import { existsSync } from "node:fs";
import {
  AguiEmitter, AguiEmitterHolder, EventWal, FileSubjectFrontier, JsonlFileSource,
  ensureEventWalDir, resolveEventsStateRoot, type MeshAgent, type PrincipalLock,
} from "@cotal-ai/connector-core";
import { createPiMapper, type PiSessionEntry } from "./agui-map.js";
import { PiSessionSource } from "./agui-source.js";

/** One holder per native session. The file is the source, while hooks only wake its reader. */
export class PiEvents {
  private holder?: AguiEmitterHolder<PiSessionEntry>;
  private lock?: PrincipalLock;
  private sessionId?: string;
  private path?: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly mesh: MeshAgent, private readonly space: string) {}

  async start(sessionId: string, path: string | undefined): Promise<void> {
    if (!path) throw new Error("Pi AG-UI: persistent native session file is required");
    const existedAtHook = existsSync(path);
    const step = this.pending.then(async () => {
      if (this.sessionId === sessionId && this.path === path) return; // reload of the same native session
      await this.release();
      this.sessionId = sessionId;
      this.path = path;
      const existed = existedAtHook;
      const holder = this.newHolder(sessionId, path, !existed);
      this.holder = holder;
      holder.adopt(path);
      await holder.settled();
      if (holder.failure) throw holder.failure;
    });
    this.pending = step.catch((error: Error) => this.fail(error));
    await step;
  }

  async flush(sessionId: string, path: string | undefined): Promise<void> {
    if (!path) throw new Error("Pi AG-UI: persistent native session file is required");
    const step = this.pending.then(async () => {
      if (this.sessionId !== sessionId || this.path !== path) throw new Error("Pi AG-UI: turn belongs to an unadopted session");
      if (!this.holder) throw new Error("Pi AG-UI: no emitter was adopted before the turn");
      this.holder.flush(path);
      await this.holder.settled();
      if (this.holder.failure) throw this.holder.failure;
    });
    this.pending = step.catch((error: Error) => this.fail(error));
    await step;
  }

  async shutdown(): Promise<void> {
    await this.pending;
    await this.release();
  }

  private async release(): Promise<void> {
    const holder = this.holder;
    this.holder = undefined;
    if (holder) await holder.close();
    const lock = this.lock;
    this.lock = undefined;
    if (lock) await lock.release();
    this.sessionId = undefined;
    this.path = undefined;
  }

  private newHolder(sessionId: string, path: string, freshFile: boolean): AguiEmitterHolder<PiSessionEntry> {
    return new AguiEmitterHolder<PiSessionEntry>(async () => {
      await this.mesh.waitUntilConnected();
      const workspaceRoot = resolveEventsStateRoot(process.env);
      const principal = principalKey(this.mesh.ep.principal.owner, this.mesh.ep.principal.actor).key;
      const { walPath, subjectPath, lock } = await ensureEventWalDir({ workspaceRoot, space: this.space, principal, threadId: sessionId });
      this.lock = lock;
      const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: this.space, principal });
      const wal = await EventWal.open(walPath, { space: this.space, principal, threadId: sessionId, subjectMayExist: false });
      if (freshFile && wal.frontier.sourceCursor !== undefined && wal.frontier.sourceCursor !== "pi:first-file")
        throw new Error("Pi AG-UI: native session file vanished after an event cursor was acknowledged");
      // For an existing transcript, capture its boundary before subsequent turns. A restart keeps
      // its acknowledged cursor. A new file is read from its beginning to retain the first turn.
      if (wal.frontier.sourceCursor === undefined) {
        if (freshFile) await wal.advanceCursorOnly("pi:first-file");
        else {
          const boundary = await new JsonlFileSource(path).read(undefined);
          await wal.advanceCursorOnly(boundary.cursor);
        }
      }
      return AguiEmitter.start({
        endpoint: this.mesh.ep, wal, subjectFrontier,
        source: new PiSessionSource(path),
        map: createPiMapper(sessionId, wal.brackets?.run),
      });
    }, (error) => this.fail(error));
  }

  private fail(error: Error): void {
    console.error(`Pi AG-UI emitter stopped: ${error.message}`);
  }
}
