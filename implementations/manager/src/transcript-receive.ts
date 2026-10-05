/**
 * `transcript-receive` (docs/design/resume-transfer.md section 5): this manager instance's side of a
 * resume transcript carried from another host. It keeps the instance's transfer bucket swept, stages a
 * committed object into a private copy, removes the broker object, and hands the caller a one-time claim
 * that `spawn` consumes.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { ensureTransferStore, fetchTransfer, listTransfers, objectStoreStream, removeTransfer, transferBucket } from "@cotal-ai/core";

/** A transfer whose last write is older than this is abandoned, and so is a claim. */
const TRANSFER_IDLE_MS = 10 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

export interface TranscriptReceiveInput {
  sha256: string;
  size: number;
  source: string;
  sourceHost: string;
  title?: string;
}

export type TranscriptReceiveAnswer = { state: "upload" } | { state: "staged"; claim: string; fetched: boolean };

/** What a claim binds: the carried bytes, where they came from, and when they were staged. */
export interface TranscriptClaim {
  sha256: string;
  source: string;
  sourceHost: string;
  title?: string;
  stagedAt: string;
  /** The staged copy the seat's home is filled from. */
  path: string;
}

export class TranscriptReceiver {
  private readonly claims = new Map<string, TranscriptClaim & { expires: number }>();
  /** One receive or sweep at a time, so two receives of one digest never fetch, stage or remove it
   *  together: the second takes the staged hit. */
  private queue: Promise<unknown> = Promise.resolve();
  private deadline?: { at: number; timer: NodeJS.Timeout };
  private readonly bucket: string;
  private readonly dir: string;

  constructor(private readonly o: {
    space: string;
    instanceId: string;
    workspaceRoot: string;
    /** A connection holding this instance's transfer reader grants (design section 6). */
    withReader: <T>(fn: (nc: NatsConnection) => Promise<T>) => Promise<T>;
    log: (line: string) => void;
  }) {
    this.bucket = transferBucket(o.space, o.instanceId);
    this.dir = join(o.workspaceRoot, ".cotal", "transcripts");
  }

  /** At start: remove this instance's own leftover temporary files (managers of two spaces can share a
   *  root, and another instance's fetch may be in flight), then sweep a bucket that already exists. */
  async start(): Promise<void> {
    const mine = `.${this.o.instanceId}.`;
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const name of names) if (name.includes(mine) && name.endsWith(".part")) rmSync(join(this.dir, name), { force: true });
    await this.serial(() => this.o.withReader(async (nc) => {
      const jsm = await jetstreamManager(nc);
      try {
        await jsm.streams.info(objectStoreStream(this.bucket));
      } catch (e) {
        if ((e as { code?: unknown }).code === 10059) return; // stream not found: nothing was ever carried here
        throw e;
      }
      await this.sweep(nc);
    }));
  }

  stop(): void {
    if (this.deadline) clearTimeout(this.deadline.timer);
    this.deadline = undefined;
  }

  receive(input: TranscriptReceiveInput): Promise<TranscriptReceiveAnswer> {
    if (!HEX64.test(input.sha256)) throw new Error("sha256: expected 64 lowercase hex characters");
    return this.serial(() => this.o.withReader(async (nc) => {
      await ensureTransferStore(nc, this.o.space, this.o.instanceId);
      await this.sweep(nc);
      const staged = this.stagedSize(input.sha256);
      if (staged !== undefined && staged.size === input.size)
        return { state: "staged", claim: this.issue(input, staged.mtime), fetched: false };
      const got = await fetchTransfer(nc, this.bucket, input.sha256);
      if (got.state === "fetched") {
        this.stage(input.sha256, got.bytes);
        await removeTransfer(nc, this.bucket, input.sha256);
        return { state: "staged", claim: this.issue(input, new Date()), fetched: true };
      }
      if (got.state === "invalid") {
        this.o.log(`transcript-receive: removed sha256:${input.sha256} from ${this.bucket}: ${got.reason}`);
        await removeTransfer(nc, this.bucket, input.sha256);
      }
      this.arm(Date.now() + TRANSFER_IDLE_MS);
      return { state: "upload" };
    }));
  }

  /** Look a claim up without spending it, so a launch can be refused before the claim is consumed.
   *  Refuses an unknown, expired or used claim, and one bound to another session. */
  peek(claim: string, source: string): TranscriptClaim {
    const c = this.claims.get(claim);
    if (!c || c.expires <= Date.now())
      throw new Error("resumeClaim: no outstanding claim by that value (unknown, expired or already used); carry the session again");
    if (c.source !== source) throw new Error(`resumeClaim: the claim carries session ${c.source}, not ${source}`);
    const { expires: _expires, ...bound } = c;
    return bound;
  }

  consume(claim: string, source: string): TranscriptClaim {
    const bound = this.peek(claim, source);
    this.claims.delete(claim);
    return bound;
  }

  private issue(input: TranscriptReceiveInput, stagedAt: Date): string {
    for (const [k, c] of this.claims) if (c.expires <= Date.now()) this.claims.delete(k);
    const claim = randomBytes(16).toString("hex");
    this.claims.set(claim, {
      sha256: input.sha256,
      source: input.source,
      sourceHost: input.sourceHost,
      ...(input.title ? { title: input.title } : {}),
      stagedAt: stagedAt.toISOString(),
      path: join(this.dir, input.sha256),
      expires: Date.now() + TRANSFER_IDLE_MS,
    });
    return claim;
  }

  private stagedSize(hex: string): { size: number; mtime: Date } | undefined {
    try {
      const st = statSync(join(this.dir, hex));
      return st.isFile() ? { size: st.size, mtime: st.mtime } : undefined;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** Write a temporary file unique to this fetch, check it, and rename it into place. A rename over an
   *  existing copy replaces it with the same verified bytes. */
  private stage(hex: string, bytes: Uint8Array): void {
    if (createHash("sha256").update(bytes).digest("hex") !== hex) throw new Error(`transcript-receive: fetched bytes do not hash to sha256:${hex}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const part = join(this.dir, `${hex}.${this.o.instanceId}.${randomBytes(8).toString("hex")}.part`);
    try {
      writeFileSync(part, bytes, { mode: 0o600, flag: "wx" });
      renameSync(part, join(this.dir, hex));
    } finally {
      rmSync(part, { force: true });
    }
  }

  /** Design 4.5: remove a transfer whole when its bytes are already staged or its last write is older
   *  than the idle limit, and set the next deadline for any transfer left in place. */
  private async sweep(nc: NatsConnection): Promise<void> {
    const now = Date.now();
    let next: number | undefined;
    for (const t of await listTransfers(nc, this.bucket)) {
      const idleAt = t.lastWrite.getTime() + TRANSFER_IDLE_MS;
      if (this.stagedSize(t.hex) !== undefined || idleAt <= now) await removeTransfer(nc, this.bucket, t.hex);
      else next = next === undefined ? idleAt : Math.min(next, idleAt);
    }
    if (next !== undefined) this.arm(next);
  }

  private arm(at: number): void {
    if (this.deadline && this.deadline.at <= at) return;
    if (this.deadline) clearTimeout(this.deadline.timer);
    const timer = setTimeout(() => {
      this.deadline = undefined;
      this.serial(() => this.o.withReader((nc) => this.sweep(nc)))
        .catch((e) => this.o.log(`transcript-receive: sweep of ${this.bucket} failed: ${(e as Error).message}`));
    }, Math.max(0, at - Date.now()));
    timer.unref();
    this.deadline = { at, timer };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
