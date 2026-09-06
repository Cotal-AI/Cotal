import { SeatClient } from "./client.js";
import type { SeatRecord } from "./record.js";

export interface SeatAttachSession {
  readonly cols: number;
  readonly rows: number;
  backlog(): Promise<Buffer>;
  onData(fn: (chunk: Buffer) => void): () => void;
  onExit(fn: () => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

export interface SeatHandle {
  readonly name: string;
  readonly kind: "pty";
  readonly reference: { kind: "pty"; id: string };
  readonly pid: number;
  readonly record: SeatRecord;
  status(): "running" | "exited";
  exitInfo(): { code?: number; signal?: number } | undefined;
  stop(opts?: { graceful?: boolean }): void;
  waitForExit(): Promise<void>;
  interrupt(): void;
  write(data: string): void;
  attach(): SeatAttachSession;
  close(): void;
}

export function adoptSeatSync(record: SeatRecord): SeatHandle {
  const client = new SeatClient(record);
  const ready = client.connect();
  let status: "running" | "exited" = "running";
  let exit: { code?: number; signal?: number } | undefined;
  let cols = 120;
  let rows = 32;
  let helloGeometryApplied = false;
  const liveUnsubs = new Set<() => void>();

  const whenReady = (): Promise<SeatClient> =>
    ready.then((hello) => {
      // Hello reports spawn size. Re-applying it on every later() overwrites a
      // resize that already updated these fields (mesh-attach-plane resize cell).
      if (!helloGeometryApplied) {
        cols = hello.cols;
        rows = hello.rows;
        helloGeometryApplied = true;
      }
      status = hello.status;
      exit = hello.exit;
      return client;
    });
  const later = (fn: (c: SeatClient) => Promise<unknown> | unknown): void => {
    void whenReady()
      .then(fn)
      .catch(() => undefined);
  };

  later((c) => {
    c.onExit(() => {
      status = "exited";
    });
  });

  return {
    name: record.name,
    kind: "pty",
    reference: { kind: "pty", id: record.id },
    pid: record.childPid,
    record,
    status: () => status,
    exitInfo: () => exit,
    stop: (opts) => {
      later((c) => c.stop(opts?.graceful === false ? "hard" : "graceful"));
    },
    waitForExit: async () => {
      try {
        const c = await whenReady();
        if (status !== "exited") {
          const info = await c.waitExit();
          status = "exited";
          if (info) exit = info;
        }
      } catch (e) {
        if (status !== "exited") throw e;
      } finally {
        client.close();
      }
    },
    interrupt: () => {
      later((c) => c.interrupt());
    },
    write: (data) => {
      later((c) => c.write(data));
    },
    attach: () => {
      const sessionUnsubs = new Set<() => void>();
      // Fast-exit children print and die before hello. onData must replay the
      // screen, and onExit must wait for that replay so a dump-then-exit spawn
      // is not observed as an empty attach (env-isolate printenv).
      let pendingOutput = Promise.resolve();
      return {
        get cols() {
          return cols;
        },
        get rows() {
          return rows;
        },
        backlog: async () => {
          const c = await whenReady();
          const snap = await c.snapshot();
          cols = snap.cols;
          rows = snap.rows;
          return Buffer.from(snap.data, "utf8");
        },
        onData: (fn) => {
          let unsub: () => void = () => {};
          let cancelled = false;
          let releaseOutput = (): void => {};
          const outputReady = new Promise<void>((resolve) => {
            releaseOutput = resolve;
          });
          pendingOutput = pendingOutput.then(() => outputReady);
          later(async (c) => {
            try {
              const u = await c.subscribeOutput(fn);
              unsub = u;
              if (cancelled) {
                u();
                return;
              }
              sessionUnsubs.add(u);
              liveUnsubs.add(u);
            } finally {
              releaseOutput();
            }
          });
          return () => {
            cancelled = true;
            unsub();
            sessionUnsubs.delete(unsub);
            liveUnsubs.delete(unsub);
          };
        },
        onExit: (fn) => {
          let unsub: () => void = () => {};
          let cancelled = false;
          later(async (c) => {
            await pendingOutput;
            if (cancelled) return;
            unsub = c.onExit(fn);
            sessionUnsubs.add(unsub);
            liveUnsubs.add(unsub);
          });
          return () => {
            cancelled = true;
            unsub();
            sessionUnsubs.delete(unsub);
            liveUnsubs.delete(unsub);
          };
        },
        write: (data) => {
          later((c) => c.write(data));
        },
        resize: (c, r) => {
          if (c <= 0 || r <= 0) return;
          cols = c;
          rows = r;
          helloGeometryApplied = true;
          later((cli) => cli.resize(c, r));
        },
      };
    },
    close: () => {
      for (const u of liveUnsubs) u();
      liveUnsubs.clear();
      client.close();
    },
  };
}

export async function adoptSeat(record: SeatRecord): Promise<SeatHandle> {
  const handle = adoptSeatSync(record);
  await handle.attach().backlog();
  return handle;
}
