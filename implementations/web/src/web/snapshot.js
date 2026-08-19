// How this dashboard survives a poll that fails, on both pages.
//
// A REFUSAL IS NOT DATA, AND THIS SURFACE COULD NOT TELL THEM APART. The server answers a failed
// route with a 500 whose body is `{"error": "..."}` - valid JSON. `fetch()` does not reject on a
// 500 either, so `fetch(u).then((r) => r.json())` resolves with the REFUSAL, and the page then
// treats it as the snapshot. Measured on the shipped pages against a broker behind a 160ms link:
// `/api/activity` returned 500 `{"error":"timeout"}`, `/graph` threw `TypeError: chans is not
// iterable` out of its bootstrap and never reached `connect()`, so the pill said `disconnected`
// with no peers and no channels and the page never recovered; `/` threw `activity is not iterable`
// fifteen times in twenty-five seconds. Both are the same bug: the status was never consulted, so
// the one thing that separated a refusal from an empty result never reached the code.
//
// THE ORDER OF THE TWO RULES IS THE FIX. First, a non-200 is turned into a THROW that names its
// condition. Second, a throwing read leaves the value the page already holds exactly where it is
// and is reported STALE. Either rule alone is not enough: checking the status without keeping the
// last good snapshot converts a silent corruption into a visible wipe, and keeping the last good
// snapshot without checking the status keeps nothing, because the refusal arrived as a successful
// parse and was never a failure to begin with.
//
// WHAT STALE MEANS HERE, AND WHY IT IS NOT A FALLBACK. The page keeps showing data it already had
// and SAYS SO. It does not invent a value, does not substitute a default, and does not silently
// degrade: the reader is told, per source, that what they are looking at is the last thing that
// was actually read and why the refresh did not land. Recovery is the next successful read, which
// replaces the value and clears the mark.
(() => {
  /** Parse a JSON response, refusing a non-200 rather than handing its body back as data. The
   *  refusal names the source and the status, and carries the server's own `error` text when the
   *  body has one, so a caller that only logs it still says something true. */
  async function readJson(res, what) {
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        if (body && typeof body.error === "string") detail = `: ${body.error}`;
      } catch {
        /* a refusal need not be JSON; the status is the fact that matters */
      }
      throw new Error(`${what} refused with HTTP ${res.status}${detail}`);
    }
    return res.json();
  }

  /** Read every source concurrently and apply ONLY the ones that succeeded.
   *
   *  `sources` is `[{ name, read, apply }]`. `apply` is called with the value of a successful read
   *  and is the ONLY place a source's state is written, so a failed read cannot reach it - the
   *  retention is structural rather than a rule someone has to remember at each call site.
   *  Returns the stale list, `[{ name, reason }]`, empty when everything landed.
   *
   *  Concurrent, not sequential: on a slow link the pre-existing sequential chain made every source
   *  wait for the slowest one, and a throw part-way through skipped the rest entirely.
   *
   *  WHAT IS CAUGHT IS THE READ, AND ONLY THE READ. A refusal or a network failure is this function's
   *  business and is turned into a named entry. An `apply` that throws is a defect in the page, not a
   *  fact about the link, and it is allowed to propagate: swallowing it would hide a broken renderer
   *  behind a stale marker that says the network is at fault. The cost is stated rather than hidden:
   *  a throwing apply ends the loop, so the sources after it are not applied and the caller does not
   *  reach its marker. Every apply here is a plain assignment or a render the page owns. */
  async function refreshAll(sources) {
    const settled = await Promise.all(
      sources.map(async (s) => {
        try {
          return { value: await s.read() };
        } catch (e) {
          return { error: e };
        }
      }),
    );
    const stale = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if ("error" in r) {
        const e = r.error;
        stale.push({ kind: "refused", name: sources[i].name, reason: e && e.message ? e.message : String(e) });
        continue;
      }
      sources[i].apply(r.value);
    }
    return stale;
  }

  /** One line for the header: what is stale, what is partial, and nothing when neither.
   *
   *  The two are DIFFERENT FACTS and the label keeps them apart. Stale means the page is showing the
   *  last value that was read because the refresh was refused. Partial means the refresh DID land and
   *  is short: some sources did not answer inside the request's deadline. Folding them into one word
   *  would tell a reader that data is old when it is actually new and incomplete. */
  function staleLabel(stale) {
    if (!stale.length) return "";
    const refused = stale.filter((s) => s.kind !== "partial").map((s) => s.name);
    const partial = stale.filter((s) => s.kind === "partial").map((s) => s.name);
    const parts = [];
    if (refused.length) parts.push(`stale: ${refused.join(", ")}`);
    if (partial.length) parts.push(`partial: ${partial.join(", ")}`);
    return parts.join(" · ");
  }

  window.COTAL_SNAPSHOT = { readJson, refreshAll, staleLabel };
})();
