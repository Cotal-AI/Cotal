import assert from "node:assert/strict";
import { isMainEntry } from "./main-entry.mjs";

export const PUBLICATION_BUDGET_MS = 600_000;

export function publicationStartedAt(requestedAt, now = Date.now()) {
  assert(typeof requestedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(requestedAt), "publication needs the original UTC request timestamp");
  const started = Date.parse(requestedAt);
  assert(Number.isFinite(started) && new Date(started).toISOString().slice(0, 19) === requestedAt.slice(0, 19) && started <= now, "publication request timestamp is invalid or in the future");
  return started;
}

export function publicationDeadline(requestedAt, now = Date.now()) {
  const deadline = publicationStartedAt(requestedAt, now) + PUBLICATION_BUDGET_MS;
  assert(deadline > now, "publication request exceeded its ten-minute deadline");
  return deadline;
}

// A delayed command may still finish, but its original service deadline never moves.
// The workflow records this attempt's start once, before checkout or any registry work.
export function publicationExecutionDeadline(requestedAt, attemptStartedAt, now = Date.now()) {
  if (attemptStartedAt === undefined) return publicationDeadline(requestedAt, now);
  const requested = publicationStartedAt(requestedAt, now);
  const started = publicationStartedAt(attemptStartedAt, now);
  assert(started >= requested, "publication attempt predates its original request");
  const deadline = started + PUBLICATION_BUDGET_MS;
  assert(deadline > now, "publication execution attempt exceeded its ten-minute deadline");
  return deadline;
}

export function remainingBudget(deadline, limit = PUBLICATION_BUDGET_MS) {
  assert(Number.isFinite(deadline) && Number.isFinite(limit) && limit > 0, "publication budget is invalid");
  const remaining = Math.min(deadline - Date.now(), limit);
  assert(remaining > 0, "publication deadline expired");
  return Math.max(1, Math.floor(remaining));
}

export async function withinPublicationBudget(run, deadline, limit = 10_000) {
  const remaining = remainingBudget(deadline, limit);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(AbortSignal.timeout(remaining))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("publication I/O deadline expired")), remaining); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Stop admitting work on an error, but settle every operation that already entered.
export async function publicationMap(items, concurrency, run) {
  assert(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 8, "publication concurrency must be between one and eight");
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await run(items[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}

if (isMainEntry(import.meta.url)) {
  try {
    assert.equal(process.argv[2], "--seconds-left", "usage: publication-budget.mjs --seconds-left");
    console.log(remainingBudget(publicationExecutionDeadline(process.env.RELEASE_REQUESTED_AT, process.env.RELEASE_ATTEMPT_STARTED_AT)) / 1_000);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
