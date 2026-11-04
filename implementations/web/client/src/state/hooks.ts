import { useSyncExternalStore } from "react";
import type { Store } from "./store.js";

/** Subscribe a component to one slice of the store. `select` must return a value that is
 *  reference-stable while its inputs are unchanged (a field, not a fresh object or array). The same
 *  read serves a server render, so a component draws from the store's current state there too. */
export function useStore<S, T>(store: Store<S>, select: (s: S) => T): T {
  const read = () => select(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
