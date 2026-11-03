import { readFileSync } from "node:fs";

/**
 * What a process's memory is made of, read from outside it, for the load harnesses' RAM profiles.
 *
 * RSS counts the clean pages a process shares with every other process on the host: the `node` or
 * `nats-server` binary's text, mapped once and counted in each. On a host running many Node seats
 * the sum of their RSS overstates what they take by that text times (processes - 1). USS (private
 * pages only) is what stopping the process would give back; PSS splits the shared pages evenly and
 * so sums to the host's real use. A RAM profile states all three and sizes hosts on PSS.
 */
export interface ProcMem { rssMb: number; pssMb: number; ussMb: number }

/** RSS, PSS and USS of a live process, from `/proc/<pid>/smaps_rollup` (Linux 4.14+). */
export function procMem(pid: number): ProcMem {
  const text = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  const kb = (key: string): number => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? NaN);
  return { rssMb: kb("Rss") / 1024, pssMb: kb("Pss") / 1024, ussMb: (kb("Private_Clean") + kb("Private_Dirty")) / 1024 };
}

/** One row of a heap summary: a class of allocation and its bytes. */
export interface HeapRow { name: string; bytes: number; count: number }

/**
 * The classes holding the most bytes in a V8 heap snapshot (`v8.writeHeapSnapshot()`), by SELF
 * size, grouped as the DevTools summary groups them: objects by constructor, closures, strings,
 * internal arrays, compiled code and system objects each as one class, and the source text V8 keeps
 * for every loaded script as its own class, also broken down by the package the script belongs to.
 * Self size, not retained size: it says what the bytes are, which is what a cut needs, and needs no
 * dominator tree.
 */
export function heapSnapshotTop(file: string, n = 3): { totalBytes: number; top: HeapRow[]; sources: { scripts: number; bytes: number; byPackage: HeapRow[] } } {
  const snap = JSON.parse(readFileSync(file, "utf8")) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[], ...unknown[]]; edge_fields: string[] } };
    nodes: number[];
    edges: number[];
    strings: string[];
  };
  const fields = snap.snapshot.meta.node_fields;
  const types = snap.snapshot.meta.node_types[0];
  const width = fields.length;
  const iType = fields.indexOf("type"), iName = fields.indexOf("name"), iSelf = fields.indexOf("self_size"), iEdges = fields.indexOf("edge_count");
  const edgeWidth = snap.snapshot.meta.edge_fields.length;
  const eName = snap.snapshot.meta.edge_fields.indexOf("name_or_index"), eTo = snap.snapshot.meta.edge_fields.indexOf("to_node");
  // The source text V8 keeps for every loaded script (for lazy compilation and Function#toString)
  // is a string like any other; it is told apart by the Script (a "code" node named by the script's
  // URL) holding it through its internal `source` edge.
  const sources = new Set<number>();
  /** Source text by the package its script belongs to, so a cut can name what is loaded. */
  const byPackage = new Map<string, HeapRow>();
  for (let i = 0, e = 0; i < snap.nodes.length; i += width) {
    const edges = snap.nodes[i + iEdges];
    if (types[snap.nodes[i + iType]] === "code")
      for (let k = e; k < e + edges * edgeWidth; k += edgeWidth) {
        const to = snap.edges[k + eTo];
        if (snap.strings[snap.edges[k + eName]] !== "source" || sources.has(to)) continue;
        sources.add(to);
        const url = snap.strings[snap.nodes[i + iName]];
        const pkg = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(url)?.[1]
          ?? /\/(packages|implementations|extensions)\/([^/]+)\//.exec(url)?.slice(1).join("/")
          ?? (url.startsWith("node:") ? "node: builtins" : url || "(unnamed)");
        const row = byPackage.get(pkg) ?? { name: pkg, bytes: 0, count: 0 };
        row.bytes += snap.nodes[to + iSelf];
        row.count++;
        byPackage.set(pkg, row);
      }
    e += edges * edgeWidth;
  }
  const byClass = new Map<string, HeapRow>();
  let totalBytes = 0;
  for (let i = 0; i < snap.nodes.length; i += width) {
    const type = types[snap.nodes[i + iType]];
    const self = snap.nodes[i + iSelf];
    if (type === "synthetic" || self === 0) continue;
    const raw = snap.strings[snap.nodes[i + iName]];
    const name =
      sources.has(i) ? "(script source text)"
      : type === "object" || type === "native" ? raw || "(anonymous object)"
      : type === "string" || type === "concatenated string" || type === "sliced string" ? "(string)"
      : type === "code" ? "(compiled code)"
      : type === "hidden" ? "(system)"
      : `(${type})`;
    const row = byClass.get(name) ?? { name, bytes: 0, count: 0 };
    row.bytes += self;
    row.count++;
    byClass.set(name, row);
    totalBytes += self;
  }
  const pkgs = [...byPackage.values()].sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes,
    top: [...byClass.values()].sort((a, b) => b.bytes - a.bytes).slice(0, n),
    sources: { scripts: sources.size, bytes: pkgs.reduce((a, r) => a + r.bytes, 0), byPackage: pkgs.slice(0, 5) },
  };
}

/** The part of the broker an allocation or goroutine belongs to, from the functions on its stack. */
export type BrokerPart = "consumers" | "streams" | "connections" | "accounts" | "other";
const BROKER_PARTS: Array<[BrokerPart, RegExp]> = [
  // First match wins, so a store a consumer opens is the consumer's, and a stream write a client
  // publish causes is the stream's.
  ["consumers", /\(\*consumer\)\.|consumerFileStore|consumerMemStore|\.addConsumer|newConsumer/],
  ["streams", /\(\*stream\)\.|\(\*fileStore\)\.|\(\*memStore\)\.|\(\*msgBlock\)\.|newFileStore|newMemStore|\.addStream/],
  ["connections", /\(\*client\)\.|\(\*Sublist\)\.|createClient|\(\*subscription\)\.|\.readLoop|\.writeLoop/],
  ["accounts", /\(\*Account\)\.|nats-io\/jwt|processClientOrLeafAuthentication|\.registerAccount/],
];
const partOf = (stack: string[]): BrokerPart => {
  const joined = stack.join("\n");
  for (const [part, re] of BROKER_PARTS) if (re.test(joined)) return part;
  return "other";
};
/** The innermost nats-server function on a stack: where the bytes were asked for, skipping the
 *  runtime and standard-library frames every allocation passes through, and the anonymous `New`
 *  functions of the server's buffer pools (`init.funcN`), whose caller is the one that holds it. */
const siteOf = (stack: string[]): string =>
  (stack.find((f) => f.startsWith("github.com/nats-io/") && !/\.init\.func\d+$/.test(f)) ?? stack[0] ?? "?").replace(/^github\.com\/nats-io\/nats-server\/v2\//, "");

export interface BrokerHeap {
  /** Live heap after a forced GC, exact (runtime.MemStats). */
  heapAllocMb: number;
  heapInuseMb: number;
  stackInuseMb: number;
  /** Everything the Go runtime has mapped from the OS. */
  sysMb: number;
  goroutines: number;
  /** Live heap by broker part. The profile is sampled, so the parts are scaled to sum to heapAllocMb. */
  heapByPart: Record<BrokerPart, number>;
  goroutinesByPart: Record<BrokerPart, number>;
  /** The allocation site/category pairs holding the most live heap, scaled the same way. */
  topSites: Array<{ site: string; part: BrokerPart; mb: number }>;
  /** Every allocation site/category pair, scaled the same way, so two reads can be subtracted by both keys. */
  sites: Array<{ site: string; part: BrokerPart; mb: number }>;
}

/**
 * A nats-server's live heap and goroutines split by part, from its pprof endpoint (`prof_port` in
 * the server config). `gc=1` forces a collection first, and the heap profile is fetched twice
 * because a profile can lag the last collection by one cycle.
 */
export async function brokerHeap(profBase: string): Promise<BrokerHeap> {
  await (await fetch(`${profBase}/debug/pprof/heap?gc=1&debug=1`)).text();
  const heap = await (await fetch(`${profBase}/debug/pprof/heap?gc=1&debug=1`)).text();
  const gor = await (await fetch(`${profBase}/debug/pprof/goroutine?debug=1`)).text();
  const stat = (key: string): number => Number(new RegExp(`^# ${key} = (\\d+)`, "m").exec(heap)?.[1] ?? NaN) / 1048576;
  const stackInuse = Number(/^# Stack = (\d+)/m.exec(heap)?.[1] ?? NaN) / 1048576;
  const rate = Number(/@ heap\/(\d+)/.exec(heap)?.[1] ?? 1048576) / 2;
  const empty = (): Record<BrokerPart, number> => ({ consumers: 0, streams: 0, connections: 0, accounts: 0, other: 0 });

  // Records: "inuse_objects: inuse_bytes [alloc_objects: alloc_bytes] @ pcs" then "#\tpc\tfunc+off\tfile:line" lines.
  const records: Array<{ count: number; bytes: number; stack: string[] }> = [];
  const parse = (text: string, head: RegExp): void => {
    let cur: { count: number; bytes: number; stack: string[] } | undefined;
    for (const line of text.split("\n")) {
      const h = head.exec(line);
      if (h) { cur = { count: Number(h[1]), bytes: Number(h[2] ?? 0), stack: [] }; records.push(cur); continue; }
      const f = /^#\s+0x[0-9a-f]+\s+(\S+?)\+0x[0-9a-f]+\s/.exec(line);
      if (f && cur) cur.stack.push(f[1]);
      else if (!line.startsWith("#")) cur = undefined;
    }
  };
  parse(heap, /^(\d+): (\d+) \[\d+: \d+\] @/);
  const heapRecords = records.splice(0);
  parse(gor, /^(\d+) @/);
  const gorRecords = records.splice(0);

  const heapByPart = empty(), goroutinesByPart = empty();
  const sites = new Map<string, { site: string; part: BrokerPart; mb: number }>();
  let sampled = 0;
  for (const r of heapRecords) {
    if (!r.count || !r.bytes) continue;
    // pprof's scaling of a sampled heap record: each record stands for 1/(1 - e^(-avg/rate)) as many bytes.
    const bytes = r.bytes / (1 - Math.exp(-(r.bytes / r.count) / rate));
    const part = partOf(r.stack);
    heapByPart[part] += bytes;
    sampled += bytes;
    const site = siteOf(r.stack);
    // One allocation function can serve several parts; keep each stack category separate.
    const key = `${part}:${site}`;
    const s = sites.get(key) ?? { site, part, mb: 0 };
    s.mb += bytes;
    sites.set(key, s);
  }
  const heapAllocMb = stat("HeapAlloc");
  const k = sampled > 0 ? heapAllocMb / (sampled / 1048576) : 0;
  for (const p of Object.keys(heapByPart) as BrokerPart[]) heapByPart[p] = (heapByPart[p] / 1048576) * k;
  let goroutines = 0;
  for (const r of gorRecords) { goroutinesByPart[partOf(r.stack)] += r.count; goroutines += r.count; }
  const all = [...sites.values()].map((s) => ({ ...s, mb: (s.mb / 1048576) * k })).sort((a, b) => b.mb - a.mb);
  return {
    heapAllocMb, heapInuseMb: stat("HeapInuse"), stackInuseMb: stackInuse, sysMb: stat("Sys"), goroutines,
    heapByPart, goroutinesByPart,
    topSites: all.slice(0, 5),
    sites: all,
  };
}
