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
    const xNumber = /^\d+$/.test(x), yNumber = /^\d+$/.test(y);
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return xNumber ? (x.length === y.length ? (x > y ? 1 : -1) : x.length > y.length ? 1 : -1) : x > y ? 1 : -1;
  }
  return 0;
}

function parse(v: string): { rel: [number, number, number]; pre: string[] } | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i.exec(v);
  if (!match) return undefined;
  const rel = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  const pre = match[4]?.split(".") ?? [];
  if (rel.some((item) => !Number.isSafeInteger(item)) || pre.some((item) => /^0\d+$/.test(item))) return undefined;
  return { rel, pre };
}
