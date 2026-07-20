/**
 * Pi's PUBLIC inbox type surface (the SDK-embedder exports on the `.` entry). These describe the
 * shape of what `MeshAgent`'s inbox API returns — which pi bundles at runtime — but pi must not leak
 * `@cotal-ai/connector-core` (a build-only dep, absent from an installed plugin) into its shipped
 * `.d.ts`, so it OWNS the public contract here instead of re-exporting connector-core's types.
 *
 * The drift guard at the bottom proves these stay structurally identical to connector-core's, at
 * pi's build (where connector-core IS resolvable, as a devDep); a skew is a loud typecheck error,
 * never a silent one. It is referenced by no exported symbol, so it is elided from the shipped
 * declarations and erased from the bundle.
 */

export type InboxScope = "all" | "automatic" | "pull-only";

export interface InboxItem {
  id: string;
  ts: number;
  fromId: string;
  fromName: string;
  fromRole?: string;
  kind: "channel" | "dm" | "anycast";
  /** Set when kind === "channel". */
  channel?: string;
  /** Set when kind === "anycast" (the role addressed). */
  service?: string;
  /** Lowercased names called out on a channel message (priority hint). */
  mentions?: string[];
  /** True iff this message mentions us by name. */
  mentionsMe: boolean;
  /** True iff this is backfilled history (a "catching up" block on join), not a live message. */
  historical: boolean;
  text: string;
  replyTo?: string;
  contextId?: string;
}

/** An exact-id drain: the items found plus the ids that were not present. */
export interface ExactDrainResult {
  items: InboxItem[];
  missingIds: string[];
}

// --- drift guard (build-only; not shipped) ---
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _GuardItem = Assert<Exact<InboxItem, import("@cotal-ai/connector-core").InboxItem>>;
type _GuardScope = Assert<Exact<InboxScope, import("@cotal-ai/connector-core").InboxScope>>;
type _GuardDrain = Assert<Exact<ExactDrainResult, import("@cotal-ai/connector-core").ExactDrainResult>>;
