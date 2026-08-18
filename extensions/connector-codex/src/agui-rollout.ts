/**
 * Resolve a Codex thread's rollout file inside the agent's own `CODEX_HOME`.
 *
 * MEASURED against a real app-server thread (`.internal` 3.3b), not assumed: the file lands at
 * `<codexHome>/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-ish stamp>-<thread id>.jsonl`, and the
 * `thread/start` id, `session_meta.payload.id` and this filename key are all the same value.
 *
 * The search is rooted at the AGENT's home, never at `~/.codex`. Those are different populations:
 * the operator's own sessions carry a different `originator` and, on this laptop, 13 per-agent
 * homes existed holding zero of them.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Walk `<root>/sessions` for the one file whose name ends `-<threadId>.jsonl`.
 *
 *  Returns `undefined` rather than throwing when nothing matches: `thread/start` writes NOTHING to
 *  disk on its own, and the host's primer inject is what materializes the file, so a caller that
 *  arrives in that window has to be able to wait rather than fail. */
export function findRollout(codexHome: string, threadId: string): string | undefined {
  const suffix = `-${threadId}.jsonl`;
  const stack = [join(codexHome, "sessions")];
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
      let isDir: boolean;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(p);
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
    await sleep(intervalMs);
  }
  return undefined;
}
