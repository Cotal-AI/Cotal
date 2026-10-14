import { useSyncExternalStore } from "react";
import type { Store } from "./store.js";

/** Subscribe a component to one slice of the store. `select` must return a value that is
 *  reference-stable while its inputs are unchanged (a field, not a fresh object or array). */
export function useStore<S, T>(store: Store<S>, select: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
