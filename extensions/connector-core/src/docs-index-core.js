// @ts-check
/**
 * The one definition of how `cotal_docs` search reads text (tokens, query stopwords, sections) and
 * of the compact index built from it. Plain ESM JavaScript so the docs generator, a plain Node
 * script with no build step, and the connector's runtime import the same file. The generator calls
 * `encodeIndex` at build time; the runtime calls `tokenize` and `STOP` on a query and `decodeIndex`
 * on the first search.
 */

/** Keep identifiers and subjects whole: `cotal_send`, `$SYS.ACCOUNT`, `#general`, `allowSubscribe`. */
const TOKEN = /[a-z0-9_$.#>*-]+/gi;
/** Trailing/leading subject-wildcard and punctuation noise: `$SYS.>` → `$SYS`, `team.*` → `team`. */
const EDGE = /^[.>*#-]+|[.>*#-]+$/g;

/** @param {string} s @returns {string[]} */
export function tokenize(s) {
  const raw = s.toLowerCase().match(TOKEN);
  if (!raw) return [];
  /** @type {string[]} */
  const out = [];
  for (const r of raw) {
    // The raw form first, so an exact wildcard/identifier match (`team.>`, `cotal_send`) keeps
    // its full weight and out-scores a mere base-subject match.
    if (r.length >= 2) out.push(r);
    // The wildcard-stripped base, so `$SYS.>` still finds the section documenting `$SYS`.
    const t = r.replace(EDGE, "");
    if (t.length >= 2 && t !== r) out.push(t);
    // Dotted segments, so `cotal.schema.json` matches a `schema` query.
    if (t.includes(".")) for (const seg of t.split(".")) if (seg.length >= 2) out.push(seg);
  }
  return out;
}

// Query-side stopwords only (the corpus keeps everything so IDF stays honest).
export const STOP = new Set(
  "a an and are as at be by do for from has how in is it of on or that the this to use using was what when where which who with you your".split(" "),
);

/**
 * Term frequencies of boosted token groups, each group counted `weight` times.
 * @param {[tokens: string[], weight: number][]} groups
 * @returns {{ tf: Map<string, number>, len: number }}
 */
function termFrequencies(groups) {
  /** @type {Map<string, number>} */
  const tf = new Map();
  let len = 0;
  for (const [tokens, weight] of groups) {
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
    len += tokens.length * weight;
  }
  return { tf, len };
}

/**
 * One searchable section. `start` and `end` locate its text in the source body, so the runtime
 * returns `body.slice(start, end)` instead of a second copy of the text.
 * @typedef {{ heading: string, start: number, end: number, tf: Map<string, number>, len: number }} Section
 */

/**
 * A heading and its body, split like the Markdown it is: fences keep their `#` lines inside them.
 * @param {string} pageTitle @param {string} body @returns {Section[]}
 */
function sectionsOf(pageTitle, body) {
  /** @type {Section[]} */
  const out = [];
  let heading = pageTitle;
  let from = 0;
  let to = 0;
  let any = false;
  const flush = () => {
    const raw = body.slice(from, to);
    const text = raw.trim();
    if (any && text) {
      const start = from + (raw.length - raw.trimStart().length);
      const { tf, len } = termFrequencies([
        [tokenize(pageTitle), 3], // title ×3
        [tokenize(heading), 2], // heading ×2
        [tokenize(text), 1],
      ]);
      out.push({ heading, start, end: start + text.length, tf, len });
    }
    any = false;
  };
  let inFence = false;
  let offset = 0;
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const h = inFence ? null : line.match(/^#{2,6}\s+(.+?)\s*$/);
    if (h) {
      flush();
      heading = `${pageTitle} › ${h[1].trim()}`;
    }
    if (!any) { from = offset; any = true; }
    offset += line.length + 1;
    to = offset - 1;
  }
  flush();
  return out;
}

/**
 * Every searchable section of the docs, in the order the search ranks ties: each page, then the
 * spec and the workflow language, then the schema as one section (it is JSON, with no headings).
 * `source` numbers the body a section came from, in the same order.
 * @param {{ pages: { title: string, body: string }[], spec: { title: string, body: string }, lang: { title: string, body: string }, schema: { title: string, body: string } }} bundle
 * @returns {(Section & { source: number })[]}
 */
export function indexSections(bundle) {
  const sources = [...bundle.pages, bundle.spec, bundle.lang];
  const sections = sources.flatMap((p, source) => sectionsOf(p.title, p.body).map((s) => ({ ...s, source })));
  const { tf, len } = termFrequencies([[tokenize(bundle.schema.title), 2], [tokenize(bundle.schema.body), 1]]);
  sections.push({ source: sources.length, heading: bundle.schema.title, start: 0, end: bundle.schema.body.length, tf, len });
  return sections;
}

const U32_MAX = 0xffffffff;

/** Reject a value an unsigned 32-bit slot cannot hold, rather than let a write wrap it. */
const u32 = (/** @type {number} */ value, /** @type {string} */ what) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) throw new Error(`docs index: ${what} ${value} does not fit an unsigned 32-bit slot`);
  return value;
};

/**
 * The search index of a docs bundle as one buffer: a length-prefixed JSON header (the release
 * version, headings, the sorted term list, counts, each source body's length) and then
 * little-endian unsigned 32-bit columns: per-section source, start, end and length, then per-term
 * posting offsets and, for every posting, the section and the boosted term frequency. A term's
 * postings run in section order. Every value is written and read explicitly little-endian, so the
 * bytes are the same on any host.
 * @param {Parameters<typeof indexSections>[0] & { version: string }} bundle @returns {Buffer}
 */
export function encodeIndex(bundle) {
  const sections = indexSections(bundle);
  const terms = [...new Set(sections.flatMap((s) => [...s.tf.keys()]))].sort();
  const termId = new Map(terms.map((t, i) => [t, i]));
  /** @type {[number, number][][]} */
  const postings = terms.map(() => []);
  sections.forEach((s, i) => { for (const [t, f] of s.tf) postings[/** @type {number} */ (termId.get(t))].push([i, f]); });
  const count = postings.reduce((n, p) => n + p.length, 0);
  const n = sections.length;
  const columns = new Array(4 * n + terms.length + 1 + 2 * count);
  sections.forEach((s, i) => {
    columns[i] = u32(s.source, "source");
    columns[n + i] = u32(s.start, "start");
    columns[2 * n + i] = u32(s.end, "end");
    columns[3 * n + i] = u32(s.len, "length");
  });
  const offsets = 4 * n;
  const sectionColumn = offsets + terms.length + 1;
  const weightColumn = sectionColumn + count;
  let at = 0;
  postings.forEach((list, t) => {
    columns[offsets + t] = u32(at, "posting offset");
    for (const [section, f] of list) { columns[sectionColumn + at] = u32(section, "section"); columns[weightColumn + at] = u32(f, "term frequency"); at++; }
  });
  columns[offsets + terms.length] = u32(at, "posting count");
  const sources = [...bundle.pages, bundle.spec, bundle.lang, bundle.schema];
  const header = Buffer.from(JSON.stringify({ version: bundle.version, sections: n, terms, postings: count, headings: sections.map((s) => s.heading), bodyLengths: sources.map((b) => b.body.length) }), "utf8");
  const out = Buffer.alloc(4 + header.length + 4 * columns.length);
  out.writeUInt32LE(header.length, 0);
  header.copy(out, 4);
  columns.forEach((value, i) => out.writeUInt32LE(value, 4 + header.length + 4 * i));
  return out;
}

/**
 * The index as typed columns. `version` and `bodyLengths` are the release version and each source
 * body's length in the bundle being searched; an index built from another release or other bodies
 * throws instead of returning offsets into the wrong text.
 * @param {Buffer} bytes @param {number[]} bodyLengths @param {string} version
 */
export function decodeIndex(bytes, bodyLengths, version) {
  if (bytes.length < 4) throw new Error("docs index is truncated or malformed");
  const headerLength = bytes.readUInt32LE(0);
  if (4 + headerLength > bytes.length) throw new Error("docs index is truncated or malformed");
  const header = /** @type {{ version: string, sections: number, terms: string[], postings: number, headings: string[], bodyLengths: number[] }} */ (
    JSON.parse(bytes.toString("utf8", 4, 4 + headerLength)));
  if (header.version !== version || header.bodyLengths.length !== bodyLengths.length || header.bodyLengths.some((length, i) => length !== bodyLengths[i]))
    throw new Error("docs index does not match the docs bundle it is searching");
  const n = header.sections;
  const length = 4 * n + header.terms.length + 1 + 2 * header.postings;
  if (bytes.length - 4 - headerLength !== 4 * length) throw new Error("docs index is truncated or malformed");
  const columns = new Uint32Array(length);
  for (let i = 0; i < length; i++) columns[i] = bytes.readUInt32LE(4 + headerLength + 4 * i);
  const offsets = 4 * n;
  const sectionColumn = offsets + header.terms.length + 1;
  let total = 0;
  for (let i = 0; i < n; i++) total += /** @type {number} */ (columns[3 * n + i]);
  return {
    sections: n,
    terms: header.terms,
    headings: header.headings,
    source: columns.subarray(0, n),
    start: columns.subarray(n, 2 * n),
    end: columns.subarray(2 * n, 3 * n),
    length: columns.subarray(3 * n, 4 * n),
    offsets: columns.subarray(offsets, sectionColumn),
    postSection: columns.subarray(sectionColumn, sectionColumn + header.postings),
    postWeight: columns.subarray(sectionColumn + header.postings),
    avgdl: total / Math.max(1, n),
  };
}
