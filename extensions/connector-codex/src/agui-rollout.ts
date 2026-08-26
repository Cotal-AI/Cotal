/**
 * Resolve a Codex thread's rollout file inside the agent's own `CODEX_HOME`.
 *
 * MEASURED against a real app-server thread, not assumed: the file lands at
 * `<codexHome>/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-ish stamp>-<thread id>.jsonl`, and the
 * `thread/start` id, `session_meta.payload.id` and this filename key are all the same value.
 *
 * The search is rooted at the AGENT's home, never at `~/.codex`. Those are different populations:
 * the operator's own sessions carry a different `originator` and, on this laptop, 13 per-agent
 * homes existed holding zero of them.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Walk `<root>/sessions` for the one file whose name ends `-<threadId>.jsonl`.
 *
 *  Returns `undefined` rather than throwing when nothing matches: `thread/start` writes NOTHING to
 *  disk on its own, and the host's primer inject is what materializes the file, so a caller that
 *  arrives in that window has to be able to wait rather than fail. */
export function findRollout(codexHome: string, threadId: string): string | undefined {
  const suffix = `-${threadId}.jsonl`;
  // THE HOME ITSELF IS TESTED FIRST. Everything below is reached THROUGH this path, so a link here
  // redirects the whole walk in one move and no test on an entry the walk discovers can see it. The
  // launch refuses a linked home when it prepares one, and this is the same refusal at the moment
  // the bytes are chosen, because the time between those two moments belongs to whatever can write
  // in the workspace.
  try {
    if (lstatSync(codexHome).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const sessions = join(codexHome, "sessions");
  // THE ROOT OF THE WALK GETS THE SAME TEST EVERY ENTRY BELOW IT GETS, and it has to be here rather
  // than in the loop: entries are checked as they are discovered, so the one directory nobody
  // discovers is the one the walk starts from. A link test that ran only inside the loop would
  // refuse a linked subdirectory and follow a linked `sessions`, which is the easier link to plant.
  try {
    if (lstatSync(sessions).isSymbolicLink()) return undefined;
  } catch {
    return undefined; // no sessions tree yet: "not yet", the same answer the loop gives
  }
  const stack = [sessions];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // the tree is built lazily by codex; a missing level is "not yet", not an error
    }
    for (const name of names) {
      const p = join(dir, name);
      let entry: ReturnType<typeof lstatSync>;
      try {
        entry = lstatSync(p);
      } catch {
        continue;
      }
      // A LINK IS REFUSED, NOT FOLLOWED, and it is `lstat` rather than `stat` that makes that
      // possible. `prepareCodexHome` already refuses a symlinked `.cotal`, `.cotal/codex` or agent
      // home; a walk that followed one would let a link planted anywhere under `sessions` decide
      // which bytes this emitter publishes, so the two would be enforcing different rules over the
      // same tree. Refusing costs nothing real: codex writes regular files and regular directories.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(p);
      else if (name.startsWith("rollout-") && name.endsWith(suffix)) return p;
    }
  }
  return undefined;
}

/** {@link findRollout}, retried until the primer has materialized the file.
 *
 *  Bounded and loud: a thread whose rollout never appears is a real fault (the emitter would have
 *  no durable source at all), so this returns `undefined` after the budget rather than waiting
 *  forever behind a caller that cannot see it is stuck. */
export async function waitForRollout(
  codexHome: string,
  threadId: string,
  opts?: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<string | undefined> {
  const attempts = opts?.attempts ?? 40;
  const intervalMs = opts?.intervalMs ?? 250;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    const hit = findRollout(codexHome, threadId);
    if (hit !== undefined) return hit;
    // BETWEEN attempts, not after the last one. A trailing sleep buys nothing and costs the caller
    // a macrotask it may be holding a lock across: with `attempts` of 1 this function then resolves
    // on the microtask queue, so a caller that sets a one-at-a-time flag around it releases the flag
    // before the next event can arrive, instead of racing it.
    if (i + 1 < attempts) await sleep(intervalMs);
  }
  return undefined;
}
