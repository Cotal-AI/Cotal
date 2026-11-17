// The dashboard's one piece of shared state, read by React through `useSyncExternalStore`.

export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: () => void): () => void;
}

/** A minimal external store for `useSyncExternalStore`: `set` replaces the state object, so a
 *  selector that returns a field sees a new reference only when that field changed. */
export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
