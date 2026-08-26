import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostPackageDir } from "./extensions.js";

/**
 * Name which side of a failed extension import is behind.
 *
 * When an installed extension imports a symbol its linked `@cotal-ai/*` peer does not export, the
 * pair is skewed — and the skew has a direction. Prescribing "reinstall the extension" without
 * establishing that direction points the operator at whichever side happens to be CURRENT, which is
 * how an operator ends up running a prescribed command that cannot change anything.
 *
 * Everything here is total and non-throwing on purpose: it runs while an error is already being
 * formatted, and a throw from a diagnosis would replace a real failure with its own.
 */

/** Semver precedence, or `undefined` when either side does not parse. Deliberately NOT the seed
 *  store's comparator: that one throws (with a `cotal ext seed` remedy in the message) so a corrupt
 *  stamp can't be silently mis-ordered, and it lives above this tier where this package can't reach
 *  it. Here an unrankable version must yield "cannot rank", never an exception and never a guess. */
export function comparePeerVersions(a: string, b: string): number | undefined {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) if (pa.rel[i] !== pb.rel[i]) return pa.rel[i] > pb.rel[i] ? 1 : -1;
  // A release outranks a prerelease of the same core version; otherwise compare prerelease fields.
  if (!pa.pre.length !== !pb.pre.length) return pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // fewer prerelease fields ⇒ lower precedence
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    return numeric ? (Number(x) > Number(y) ? 1 : -1) : x > y ? 1 : -1;
  }
  return 0;
}

function parse(v: string): { rel: [number, number, number]; pre: string[] } | undefined {
  const core = v.split("+")[0];
  const dash = core.indexOf("-");
  const rel = (dash >= 0 ? core.slice(0, dash) : core).split(".");
  if (rel.length !== 3 || rel.some((s) => !/^\d+$/.test(s))) return undefined;
  return { rel: [Number(rel[0]), Number(rel[1]), Number(rel[2])], pre: dash >= 0 ? core.slice(dash + 1).split(".") : [] };
}

/** The lowest version a declared peer range admits, when the range states one. `*`, `x`, and every
 *  shape this does not recognize yield `undefined` — an unread range must not be read as `0.0.0`,
 *  which would silently rank every core as satisfying it. */
export function declaredFloor(range: string): string | undefined {
  const m = /^\s*(?:>=|\^|~|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(range);
  return m ? m[1] : undefined;
}

interface PeerSkewBase {
  /** The peer package the extension resolved against. */
  readonly peer: string;
  readonly peerVersion: string;
  readonly peerPath: string;
  /** Why the ranking came out this way, in the operator's terms. */
  readonly because: string;
}

export type PeerSkew =
  | (PeerSkewBase & {
      readonly side: "peer-behind";
      /** The version the peer must reach for this pair to match — so the remedy can be an exact
       *  command instead of an instruction to go find one. */
      readonly needsAtLeast: string;
    })
  | (PeerSkewBase & { readonly side: "same-version" | "extension-behind" | "unrankable" });

/**
 * The command that fixes a behind peer, chosen by what the resolved path actually IS. An installed
 * copy lives under `node_modules` and is upgraded; a path outside one is a source checkout, where
 * `npm i -g` would be the wrong instruction entirely and a rebuild is the real remedy.
 */
export function upgradeRemedy(peerPath: string, needsAtLeast: string): string {
  const installed = /(^|[/\\])node_modules[/\\]/.test(peerPath);
  return installed
    ? `upgrade the cotal that owns it: \`npm i -g cotal-ai@${needsAtLeast}\``
    : `that path is a source checkout rather than an installed copy, so rebuild it at ${needsAtLeast} or newer`;
}

/** Locate the peer this process would have linked, and rank it against the extension. */
export function diagnosePeerSkew(pkg: string, extVersion: string, peer: string, declared: string | undefined): PeerSkew | undefined {
  let peerPath: string;
  let peerVersion: string;
  try {
    peerPath = hostPackageDir(peer);
    const v = (JSON.parse(readFileSync(join(peerPath, "package.json"), "utf8")) as { version?: string }).version;
    if (typeof v !== "string") return undefined;
    peerVersion = v;
  } catch {
    return undefined; // can't see the peer at all: the caller says so rather than naming a side
  }
  const base = { peer, peerVersion, peerPath } as const;

  // A declared floor above the installed peer is the strongest statement available: the extension
  // itself says it needs a newer peer than the one that got linked.
  const floor = declared === undefined ? undefined : declaredFloor(declared);
  if (floor !== undefined && (comparePeerVersions(peerVersion, floor) ?? 0) < 0) {
    return {
      ...base,
      side: "peer-behind",
      needsAtLeast: floor,
      because: `it declares ${peer} ${declared}, and the linked ${peer} is older than that`,
    };
  }

  // Otherwise only first-party packages can be ranked against each other: `@cotal-ai/*` versions move
  // in lockstep (one changeset bumps the fixed group), so their numbers are comparable. A
  // third-party extension's own version says nothing about core's.
  if (!pkg.startsWith("@cotal-ai/")) {
    return { ...base, side: "unrankable", because: `${pkg} is not a @cotal-ai/* package, so its version does not rank against ${peer}'s` };
  }
  const order = comparePeerVersions(extVersion, peerVersion);
  if (order === undefined) return { ...base, side: "unrankable", because: `${extVersion} and ${peerVersion} do not both parse as semver` };
  if (order > 0) {
    return {
      ...base,
      side: "peer-behind",
      needsAtLeast: extVersion,
      because: `@cotal-ai/* versions move in lockstep, and ${extVersion} is newer than the linked ${peer} ${peerVersion}`,
    };
  }
  if (order === 0) return { ...base, side: "same-version", because: `both are ${peerVersion}` };
  return { ...base, side: "extension-behind", because: `@cotal-ai/* versions move in lockstep, and ${extVersion} is older than the linked ${peer} ${peerVersion}` };
}
