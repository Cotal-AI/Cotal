/** The full corpus and the search index are two files beside the built module, each read only when
 *  its data is needed and checked first. Each case runs the built module from a copy of dist/ whose
 *  corpus or index file is changed: a missing, replaced, corrupt or truncated file must make the
 *  operations that read it throw (corpus: page and search; index: search) and leave the menu and
 *  structured index working (they read neither), and a bad index must leave pages working. The codec checks
 *  pin the explicit little-endian layout and the version and body-length coupling.
 *  No network, mocks, forced GC, or timing/memory assertions. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { decodeIndex, encodeIndex } from "../src/docs-index-core.js";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const CORPUS = "docs-bundle.bin";
const INDEX = "docs-index.bin";
let checks = 0;
const check = (label: string, run: () => void): void => { run(); checks++; console.log(`✓ ${label}`); };

type Docs = typeof import("../src/docs.js");
const roots: string[] = [];
async function copyOf(change: (root: string) => void): Promise<Docs> {
  const root = mkdtempSync(join(tmpdir(), "docs-index-asset-"));
  roots.push(root);
  cpSync(dist, root, { recursive: true });
  change(root);
  return await import(pathToFileURL(join(root, "docs.js")).href) as Docs;
}

try {
  const search = (docs: Docs) => docs.searchDocs("channel permissions").map(hit => hit.slug);
  const intact = await copyOf(() => undefined);
  const expected = search(intact);
  check("an intact copy searches", () => assert.equal(expected[0], "channels-and-permissions"));

  const changes = (good: Buffer): [string, RegExp, (file: string) => void][] => [
    ["missing", /ENOENT/, file => rmSync(file)],
    ["replaced by other bytes of the same length", /is not the one built with it/, file => writeFileSync(file, Buffer.alloc(good.length, 7))],
    ["replaced by another valid gzip file", /is not the one built with it/, file => writeFileSync(file, gzipSync(Buffer.from("not this data")))],
    ["one byte flipped", /is not the one built with it/, file => { const bytes = Buffer.from(good); bytes[bytes.length >> 1] ^= 1; writeFileSync(file, bytes); }],
    ["truncated", /is not the one built with it/, file => writeFileSync(file, good.subarray(0, good.length - 1))],
    ["empty", /is not the one built with it/, file => writeFileSync(file, "")],
    ["with trailing bytes", /is not the one built with it/, file => writeFileSync(file, Buffer.concat([good, Buffer.from([0])]))],
  ];
  // The corpus file serves pages and search; the index file serves search only. Menu and metadata read neither.
  for (const [file, pageWorks] of [[CORPUS, false], [INDEX, true]] as const) {
    for (const [name, message, change] of changes(readFileSync(join(dist, file)))) {
      const docs = await copyOf(root => change(join(root, file)));
      const label = `${file} ${name}`;
      check(`${label}: import, menu and structured index work`, () => {
        assert.ok(docs.renderDocsIndex().includes("channels-and-permissions"));
        assert.ok(docs.docsIndex().pages.length > 0);
      });
      const page = docs.runDocs({ page: "architecture" });
      if (pageWorks) assert.match((await page).text, /^\(bundled v/, `${label}: page works`);
      else await assert.rejects(page, message, `${label}: page throws`);
      // A second call throws again: a failed read leaves nothing cached that would search wrong bytes.
      assert.throws(() => docs.searchDocs("channel permissions"), message, `${label}: search throws`);
      assert.throws(() => docs.searchDocs("channel permissions"), message, `${label}: search keeps throwing`);
      checks++;
      console.log(`✓ ${label}: page ${pageWorks ? "works" : "throws"}, search throws twice and caches nothing`);
    }
  }

  // Codec: explicit little-endian bytes, version and body-length coupling.
  const text = (title: string, body: string) => ({ title, body });
  const bundle = { version: "9.9.9", pages: [text("Alpha", "# Alpha\n\nchannel permissions grant access.\n")], spec: text("Spec", "# Spec\n\nfirst words\n"), lang: text("Lang", "# Lang\n\nsecond words\n"), schema: text("Schema", "{}") };
  const bytes = encodeIndex(bundle);
  const lengths = [bundle.pages[0].body.length, bundle.spec.body.length, bundle.lang.body.length, bundle.schema.body.length];
  check("the header length is a little-endian prefix and the columns follow it", () => {
    const headerLength = bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] * 2 ** 24;
    assert.equal(JSON.parse(bytes.toString("utf8", 4, 4 + headerLength)).version, "9.9.9");
    assert.equal((bytes.length - 4 - headerLength) % 4, 0);
    // The first column is the first section's source number, 0, then the second's, in four little-endian bytes.
    assert.deepEqual([...bytes.subarray(4 + headerLength, 4 + headerLength + 4)], [0, 0, 0, 0]);
  });
  check("decode reads what encode wrote", () => {
    const index = decodeIndex(bytes, lengths, "9.9.9");
    assert.ok(index.terms.includes("channel"));
    assert.equal(index.sections, index.headings.length);
  });
  check("another release version or other body lengths throw", () => {
    assert.throws(() => decodeIndex(bytes, lengths, "9.9.8"), /does not match/);
    assert.throws(() => decodeIndex(bytes, [...lengths.slice(1), 1], "9.9.9"), /does not match/);
    assert.throws(() => decodeIndex(bytes, lengths.slice(1), "9.9.9"), /does not match/);
  });
  check("a truncated or extended buffer throws", () => {
    assert.throws(() => decodeIndex(bytes.subarray(0, bytes.length - 4), lengths, "9.9.9"), /truncated or malformed/);
    assert.throws(() => decodeIndex(Buffer.concat([bytes, Buffer.alloc(4)]), lengths, "9.9.9"), /truncated or malformed/);
    assert.throws(() => decodeIndex(bytes.subarray(0, 3), lengths, "9.9.9"), /truncated or malformed/);
  });
  console.log(`docs-index-asset: ${checks} checks passed`);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
