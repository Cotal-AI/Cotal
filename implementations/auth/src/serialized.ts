/**
 * Run `fn` after every earlier call on `key` in `chains` has settled, whatever it settled to. Each
 * critical section passes its own module-level map, so separate sections never wait on each other.
 * The last call off a key's chain removes the key, so a map keyed per agent or per space holds only
 * the keys with work still queued.
 */
export function serializedFor<T>(chains: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}
