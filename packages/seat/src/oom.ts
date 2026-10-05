import { readFileSync, writeFileSync } from "node:fs";

/** How much more killable a seat's PTY child is than the kernel default (0). Positive only: an
 * unprivileged parent may raise a child's `oom_score_adj` but gets `Permission denied` lowering
 * it, so the broker, manager and delivery daemon cannot be protected from here (see the
 * supervisor design record); this only makes a seat a preferred kill over them. It is written to
 * the PTY child, not the custodian, because the agent's own workers fork under that child and
 * inherit the value; a worker forked before the write completes would keep 0, which in practice
 * does not happen because the write lands before the child's `exec` finishes. Off Linux this is a
 * no-op because the in-process runtime, not the custodial one, is the supported mode there. */
export const SEAT_OOM_SCORE_ADJ = 500;

export type OomPreference = { applied: true; value: number } | { applied: false; reason: string };

export function preferSeatForOomKill(pid: number): OomPreference {
  if (process.platform !== "linux") {
    return { applied: false, reason: "oom preference unavailable: /proc/<pid>/oom_score_adj is Linux-only" };
  }
  const path = `/proc/${pid}/oom_score_adj`;
  try {
    writeFileSync(path, String(SEAT_OOM_SCORE_ADJ));
    const readBack = readFileSync(path, "utf8").trim();
    if (readBack !== String(SEAT_OOM_SCORE_ADJ)) {
      return { applied: false, reason: `oom preference mismatch for pid ${pid}: wrote ${SEAT_OOM_SCORE_ADJ}, read back ${readBack}` };
    }
    return { applied: true, value: SEAT_OOM_SCORE_ADJ };
  } catch (err) {
    return { applied: false, reason: `oom preference failed for pid ${pid} (target ${SEAT_OOM_SCORE_ADJ}): ${(err as Error).message}` };
  }
}
