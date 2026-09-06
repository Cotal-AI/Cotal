import type { RunHostPlanes } from "@cotal-ai/core";
import { digest, type EffectContext, type EffectHandler, type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, type MeshHandlerBinding } from "./mesh-handler.js";
import { createRunPauseHost } from "./run-pause-host.js";
import { createRunWaitHost } from "./run-wait-host.js";
import { RunScopeAuthority } from "./run-scope-authority.js";

export interface RunEffectHost extends EffectHandler {
  adopted(entries: readonly JournalEntry[]): Promise<string[]>;
  discharge(entries: readonly JournalEntry[]): Promise<void>;
  restoreMigratedSeats(entries: readonly JournalEntry[]): Promise<void>;
}

/** Constructed by the trusted hosting process. The driver receives only the frozen effect
 *  methods below. The broker-backed handler and its connections remain inside the closure. */
export function createRunEffectHost(
  broker: RunHostPlanes,
  binding: MeshHandlerBinding,
  authority: RunScopeAuthority,
): RunEffectHost {
  const pinned = structuredClone(binding);
  const pauses = createRunPauseHost(broker, pinned, authority);
  const waits = createRunWaitHost(broker, authority);
  const handler = new MeshHandler(broker.nc, broker.kv, broker.js, broker.jsm, pinned, {
    async awaitSettle(ref) {
      for (;;) {
        const settled = await pauses.readSettle(ref.token);
        if (settled !== undefined) return settled;
        await new Promise((resolve) => setTimeout(resolve, 2_000).unref());
      }
    },
  }, Date.now, { pauses, waits, authority });

  async function dispatch<R, T>(kind: string, req: R, ctx: EffectContext, call: (request: R, context: EffectContext) => Promise<T>): Promise<T> {
    const request = structuredClone(req);
    const key = structuredClone(ctx.key);
    const captured = { ...ctx, key };
    const entry = await authority.effect(kind, captured);
    const context: EffectContext = {
      ...captured,
      resume: entry.external,
      async bind(external) {
        const snapshot = structuredClone(external);
        await ctx.bind(snapshot);
        const recorded = await authority.effect(kind, captured);
        if (digest(recorded.external ?? null) !== digest(snapshot))
          throw new Error(`run ${pinned.runId} did not persist the binding for ${captured.requestId}`);
      },
    };
    return call(request, context);
  }

  return Object.freeze({
    now: () => handler.now(),
    spawn: (req, ctx) => dispatch("spawn", req, ctx, (request, current) => handler.spawn(request, current)),
    turn: (req, ctx) => dispatch("turn", req, ctx, (request, current) => handler.turn(request, current)),
    ask: (req, ctx) => dispatch("ask", req, ctx, (request, current) => handler.ask(request, current)),
    checkpoint: (req, ctx) => dispatch("checkpoint", req, ctx, (request, current) => handler.checkpoint(request, current)),
    sleep: (req, ctx) => dispatch("sleep", req, ctx, (request, current) => handler.sleep(request, current)),
    wait: (req, ctx) => dispatch("wait", req, ctx, (request, current) => handler.wait(request, current)),
    notify: (req, ctx) => dispatch("notify", req, ctx, (request, current) => handler.notify(request, current)),
    monitor: (req, ctx) => dispatch("monitor", req, ctx, (request, current) => handler.monitor(request, current)),
    openConclave: (req, ctx) => dispatch("conclave", req, ctx, (request, current) => handler.openConclave(request, current)),
    closeConclave: (req, ctx) => dispatch("conclave", req, ctx, (request, current) => handler.closeConclave(request, current)),
    adopted: (entries) => handler.adopted(entries),
    discharge: (entries) => handler.discharge(entries),
    restoreMigratedSeats: (entries) => handler.restoreMigratedSeats(entries),
  } satisfies RunEffectHost);
}
