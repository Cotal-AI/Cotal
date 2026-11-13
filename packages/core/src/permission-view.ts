/**
 * The permission watch's core (SPEC §8.2): one reducer over what an interactive principal's reader
 * consumer delivers. `CotalEndpoint.watchPermissions` runs the opener and the fetch loop and applies
 * the effects. Not exported from the package.
 *
 * The reader consumer is AckNone, so a lost delivery is healed by opening the reader again, which
 * deletes and recreates it and replays the bucket's current state. A pass replaces the view only once
 * it is complete, so a reader never shows half a view.
 */
import type { PermissionRecord, PermissionWatchFailure } from "./permissions.js";

/** The owner's records, keyed as stored (`<owner>.<actor>.<id>`). The map belongs to the state that
 *  carries it, and a step may update it in place, so a pass of N records costs O(N). */
export type PermissionView = Map<string, PermissionRecord>;

/** What one delivery says about its key. `dropped` is a value that is not a record of its key. */
export type PermissionViewChange =
  | { readonly kind: "put"; readonly record: PermissionRecord }
  | { readonly kind: "removed" }
  | { readonly kind: "dropped" };

/** `gen` numbers the opens: an event of an older open is ignored. `retried` means the reader already
 *  failed once since the last complete pass. `ready` means the first pass completed. */
export type PermissionViewState =
  | { readonly kind: "opening"; readonly gen: number; readonly retried: boolean; readonly ready: boolean; readonly view: PermissionView }
  | {
      readonly kind: "passing"; readonly gen: number; readonly retried: boolean; readonly ready: boolean; readonly view: PermissionView;
      readonly expected: number; readonly handled: number; readonly nextDseq: number; readonly next: PermissionView;
    }
  | { readonly kind: "live"; readonly gen: number; readonly view: PermissionView; readonly nextDseq: number }
  | { readonly kind: "failed"; readonly failure: PermissionWatchFailure; readonly view: PermissionView };

/**
 * - `opened`: the opener returned and the reader reported `pending` records to replay.
 * - `delivered`: one delivery, with its delivery sequence and the records still pending after it.
 * - `fetch-failed`: the reader is not ours right now: deleted, busy, or a fetch that died.
 * - `reconnected`: the endpoint's connection was replaced, so a delivery may have been lost.
 */
export type PermissionViewEvent =
  | { readonly kind: "opened"; readonly gen: number; readonly pending: number }
  | { readonly kind: "delivered"; readonly gen: number; readonly dseq: number; readonly pending: number; readonly key: string; readonly change: PermissionViewChange }
  | { readonly kind: "fetch-failed"; readonly gen: number }
  | { readonly kind: "open-failed"; readonly gen: number; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "reconnected" }
  | { readonly kind: "stop" };

export type PermissionViewEffect =
  | { readonly kind: "open"; readonly gen: number }
  | { readonly kind: "changed" }
  | { readonly kind: "ready" }
  | { readonly kind: "fail"; readonly failure: PermissionWatchFailure };

export interface PermissionViewStep {
  readonly state: PermissionViewState;
  readonly effects: readonly PermissionViewEffect[];
}

/** A watch starts by opening its reader. */
export function startPermissionView(): PermissionViewStep {
  return { state: { kind: "opening", gen: 1, retried: false, ready: false, view: new Map() }, effects: [{ kind: "open", gen: 1 }] };
}

type Running = Exclude<PermissionViewState, { kind: "failed" }>;

const stay = (state: PermissionViewState): PermissionViewStep => ({ state, effects: [] });

function fail(state: Running, failure: PermissionWatchFailure): PermissionViewStep {
  return { state: { kind: "failed", failure, view: state.view }, effects: [{ kind: "fail", failure }] };
}

/** Open the reader again. A second failure before a pass completes is contention, as when two
 *  watchers share one lifecycle's reader; a replaced connection never counts as one. */
function reopen(state: Running, contention: boolean): PermissionViewStep {
  const retried = state.kind === "live" ? false : state.retried;
  if (contention && retried) return fail(state, { kind: "contended" });
  const gen = state.gen + 1;
  return {
    state: { kind: "opening", gen, retried: contention, ready: state.kind === "live" || state.ready, view: state.view },
    effects: [{ kind: "open", gen }],
  };
}

function apply(view: PermissionView, key: string, change: PermissionViewChange): void {
  if (change.kind === "put") view.set(key, change.record);
  else if (change.kind === "removed") view.delete(key);
}

function complete(state: Extract<PermissionViewState, { kind: "opening" | "passing" }>, view: PermissionView, nextDseq: number): PermissionViewStep {
  return {
    state: { kind: "live", gen: state.gen, view, nextDseq },
    effects: state.ready ? [{ kind: "changed" }] : [{ kind: "changed" }, { kind: "ready" }],
  };
}

/** One event applied to one state. A failed watch takes no more events. */
export function stepPermissionView(state: PermissionViewState, event: PermissionViewEvent): PermissionViewStep {
  if (state.kind === "failed") return stay(state);
  switch (event.kind) {
    case "stop":
      return fail(state, { kind: "stopped" });
    case "refused":
      return fail(state, { kind: "refused", reason: event.reason });
    case "reconnected":
      return reopen(state, false);
    case "open-failed":
      return state.kind === "opening" && event.gen === state.gen ? fail(state, { kind: "open-failed", reason: event.reason }) : stay(state);
    case "fetch-failed":
      return event.gen === state.gen ? reopen(state, true) : stay(state);
    case "opened":
      if (state.kind !== "opening" || event.gen !== state.gen) return stay(state);
      if (event.pending === 0) return complete(state, new Map(), 1);
      return {
        state: { kind: "passing", gen: state.gen, retried: state.retried, ready: state.ready, view: state.view, expected: event.pending, handled: 0, nextDseq: 1, next: new Map() },
        effects: [],
      };
    case "delivered": {
      if (state.kind === "opening" || event.gen !== state.gen) return stay(state);
      // AckNone: a skipped delivery sequence is a delivery this watch never saw.
      if (event.dseq !== state.nextDseq) return reopen(state, true);
      if (state.kind === "passing") {
        apply(state.next, event.key, event.change);
        const handled = state.handled + 1;
        // The count covers a record overwritten during the pass, whose replacement is delivered in
        // its place. `pending` 0 covers a record that aged out before it was delivered.
        if (handled >= state.expected || event.pending === 0) return complete(state, state.next, event.dseq + 1);
        return { state: { ...state, handled, nextDseq: event.dseq + 1 }, effects: [] };
      }
      apply(state.view, event.key, event.change);
      return { state: { ...state, nextDseq: event.dseq + 1 }, effects: event.change.kind === "dropped" ? [] : [{ kind: "changed" }] };
    }
  }
}
