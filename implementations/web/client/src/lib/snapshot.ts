// How the dashboard survives a poll that fails.
//
// A refusal is not data, and this surface used to be unable to tell them apart. The server answers
// a failed route with a 500 whose body is `{"error": "..."}`, which is valid JSON. `fetch()` does
// not reject on a 500 either, so `fetch(u).then((r) => r.json())` resolves with the refusal and the
// page stores it as the snapshot. Measured against a broker behind a 160ms link: `/api/activity`
// returned 500 `{"error":"timeout"}`, the graph page threw out of its bootstrap and never opened
// its live feed, and the console page threw fifteen times in twenty-five seconds. One bug: the
// status was never consulted.
//
// The order of the two rules is the fix. First, a non-200 becomes a throw that names its condition.
// Second, a throwing read leaves the value the page already holds where it is and is reported
// stale. Either rule alone is not enough: checking the status without keeping the last good
// snapshot turns a silent corruption into a visible wipe, and keeping the last good snapshot
// without checking the status keeps nothing, because the refusal arrived as a successful parse.
//
// Stale is not a fallback. The page keeps showing data it already had and says so. It invents no
// value and substitutes no default: the reader is told, per source, that what they see is the last
// thing actually read and why the refresh did not land. The next successful read replaces the value
// and clears the mark.

/** Parse a JSON response, refusing a non-200 rather than handing its body back as data. The
 *  refusal names the source and the status, and carries the server's own `error` text when the
 *  body has one, so a caller that only logs it still says something true. */
export async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown } | null;
      if (body && typeof body.error === "string") detail = `: ${body.error}`;
    } catch {
      /* a refusal need not be JSON; the status is the fact that matters */
    }
    throw new Error(`${what} refused with HTTP ${res.status}${detail}`);
  }
  return res.json() as Promise<T>;
}

/** One thing the page polls. `apply` is the only place its state is written. */
export interface Source<T> {
  name: string;
  read(): Promise<T>;
  apply(v: T): void;
}

/** A source whose read was refused or failed on the network. */
export interface Refusal {
  kind: "refused";
  name: string;
  reason: string;
}

/** A source marked for the header: refused (last value kept) or partial (a short, fresh read). The
 *  optional fields are what the marker's second line says, and each is set only when it is known:
 *  `lastRead` is when a refused source last read successfully (absent when it never has), `since`
 *  is when the observer's presence watch went silent, and `read`, `of` and `missing` are a partial
 *  page's counts and the sources that did not answer. */
export interface StaleMark {
  kind: "refused" | "partial";
  name: string;
  reason: string;
  lastRead?: number;
  since?: number;
  read?: number;
  of?: number;
  missing?: string[];
}

/** Read every source concurrently and apply only the ones that succeeded.
 *
 *  `apply` is called with the value of a successful read and is the only place a source's state is
 *  written, so a failed read cannot reach it: the retention is structural rather than a rule
 *  someone has to remember at each call site. Returns the refusals, empty when everything landed.
 *
 *  Concurrent, not sequential: on a slow link a sequential chain made every source wait for the
 *  slowest one, and a throw part-way through skipped the rest entirely.
 *
 *  What is caught is the read, and only the read. A refusal or a network failure is turned into a
 *  named entry. An `apply` that throws is a defect in the page, not a fact about the link, and it
 *  propagates: swallowing it would hide a broken renderer behind a stale marker that blames the
 *  network. The cost is stated: a throwing apply ends the loop, so later sources are not applied and
 *  the caller does not reach its marker. */
export async function refreshAll(sources: Source<any>[]): Promise<Refusal[]> {
  const settled = await Promise.all(
    sources.map(async (s): Promise<{ value: unknown } | { error: unknown }> => {
      try {
        return { value: await s.read() };
      } catch (e) {
        return { error: e };
      }
    }),
  );
  const stale: Refusal[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if ("error" in r) {
      const e = r.error as { message?: string } | null;
      stale.push({ kind: "refused", name: sources[i].name, reason: e && e.message ? e.message : String(r.error) });
      continue;
    }
    sources[i].apply(r.value);
  }
  return stale;
}

/** One line for the header: what is stale, what is partial, and nothing when neither.
 *
 *  The two are different facts and the label keeps them apart. Stale means the page shows the last
 *  value that was read because the refresh was refused. Partial means the refresh did land and is
 *  short: some sources did not answer inside the request's deadline. One word for both would tell a
 *  reader that data is old when it is actually new and incomplete. */
export function staleLabel(stale: StaleMark[]): string {
  if (!stale.length) return "";
  const refused = stale.filter((s) => s.kind !== "partial").map((s) => s.name);
  const partial = stale.filter((s) => s.kind === "partial").map((s) => s.name);
  const parts: string[] = [];
  if (refused.length) parts.push(`stale: ${refused.join(", ")}`);
  if (partial.length) parts.push(`partial: ${partial.join(", ")}`);
  return parts.join(" · ");
}
