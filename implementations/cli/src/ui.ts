import { formatAge, presenceAges, type PresenceStamps, type PresenceStatus } from "@cotal-ai/core";
import { c } from "@cotal-ai/workspace";

// The ANSI helpers moved into `@cotal-ai/workspace` (stage 4), shared with @cotal-ai/web.
// Re-exported so the CLI's many importers keep resolving them from here.
export { c, color256 } from "@cotal-ai/workspace";

export function statusBadge(status: PresenceStatus): string {
  switch (status) {
    case "working":
      return c.green("● working · progress unknown");
    case "waiting":
      return c.yellow("◐ waiting");
    case "idle":
      return c.gray("○ idle");
    case "offline":
      return c.dim("⨯ offline");
  }
}

/** The facts a status word needs beside it (#618): the harness-reported condition and how long it has
 *  held, how long the status has stood (#578), then the age of the seat's last harness-reported work
 *  event (`activeAt`). A failure 3s old and one 40m old, or a turn that stopped advancing and one that
 *  is advancing, no longer render alike. The seat reports `activeAt` itself, so the status word keeps
 *  its own progress wording. */
export function presenceDetail(p: PresenceStamps & { condition?: { code: string } }, now = Date.now()): string {
  const age = presenceAges(p, now);
  const condition = p.condition ? ` (${p.condition.code}${age.conditionSince === undefined ? "" : ` for ${formatAge(age.conditionSince)}`})` : "";
  const unchanged = age.statusSince === undefined ? "" : c.dim(` · unchanged for ${formatAge(age.statusSince)}`);
  const active = age.activeAt === undefined ? "" : c.dim(` · active ${formatAge(age.activeAt)} ago`);
  return condition + unchanged + active;
}

/** The age that follows an activity (#544): a hook flips the status every turn and leaves the
 *  activity alone, so the status age cannot date it. */
export function activityAge(p: PresenceStamps, now = Date.now()): string {
  const age = presenceAges(p, now).activitySince;
  return age === undefined ? "" : ` (set ${formatAge(age)} ago)`;
}

/** A follow-up hint for failures whose signature is stale on-disk broker state: streams/durable
 *  consumers minted by an older, incompatible Cotal generation survive every down/up cycle, and
 *  JetStream rejects a same-name re-create with a different config. Rendered dim under the red
 *  line by the error surfaces - the error itself stays the broker's own sentence. */
export function staleStoreHint(msg: string): string | undefined {
  // The recipe must not promise a configuration-preserving restart: a bare `cotal up` would turn
  // a named/open/user-auth mesh into the default authenticated one, and a custom --store-dir is
  // not recorded - so both variable parts are called out instead of implied.
  return /consumer already exists|stream already exists/i.test(msg)
    ? "likely stale on-disk mesh state from an older Cotal version - reset: cotal down, cotal clean store --force (repeat any custom --store-dir), then `cotal up` with your usual flags"
    : undefined;
}
