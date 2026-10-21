/**
 * `cotal docs [page]` and bare `cotal ext` on the structured output contract, driven through the built
 * binary in a fresh sandbox: the docs index, one page, a search and its empty result, `--refresh`
 * naming the copy it served, the usage refusals, and that the docs bundle loads only when `docs` runs;
 * the extension listing as one envelope and a plain report, and `ext root` staying a raw path that
 * refuses `--json`. Broker-free and, except `--refresh`, offline.
 *
 * Run: pnpm smoke:docs-ext-read
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
const home = mkdtempSync(join(tmpdir(), "cotal-docs-ext-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const xdg = join(home, ".config");

type Envelope = {
  outcome: string;
  completeness: string;
  command: string;
  target: unknown;
  result: Record<string, unknown> | null;
  warnings: unknown[];
  error?: { code: string; message: string };
};
function run(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: home,
    env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal-home"), COTAL_SKIP_CONNECTOR_SEED: "1", ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
  });
  const stdout = r.stdout ?? "";
  const lines = stdout.split("\n").filter(Boolean);
  const envelope = lines.length === 1 && lines[0]!.startsWith("{") ? (JSON.parse(lines[0]!) as Envelope) : undefined;
  return { status: r.status, stdout, stderr: r.stderr ?? "", envelope };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 400) });

// ── docs: the index ──────────────────────────────────────────────────────────────────────────────
{
  const json = run(["docs", "--json"]);
  const r = json.envelope?.result as { kind: string; version: string; sources: { slug: string }[]; pages: { slug: string; summary: string }[] } | undefined;
  check("docs --json is one complete ok envelope with no target", json.status === 0 && json.envelope?.outcome === "ok" && json.envelope.completeness === "complete" && json.envelope.target === null && json.stderr === "", shown(json));
  check("the index is this version's: the three normative sources and the pages", r?.kind === "docs-index" && r.version === VERSION && JSON.stringify(r.sources.map((s) => s.slug)) === JSON.stringify(["spec", "lang", "schema"]) && r.pages.some((p) => p.slug === "architecture" && p.summary.length > 0), r && { kind: r.kind, version: r.version, sources: r.sources, pages: r.pages.length });
  const plain = run(["docs", "--plain"]);
  check("the plain index names the version, both groups and how to read a page", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && plain.stdout.startsWith(`Cotal v${VERSION} documentation`) && /^Normative sources$/m.test(plain.stdout) && /^Concept$/m.test(plain.stdout) && /^Reference$/m.test(plain.stdout) && /cotal docs <page>/.test(plain.stdout), shown(plain));
  const narrow = run(["docs", "--plain"], { COLUMNS: "80" });
  check("the index groups pages by category in PAGE and TITLE tables that fit 80 columns", narrow.status === 0 && /^ {2}architecture +\S/m.test(narrow.stdout) && !/^ {2}PAGE:/m.test(narrow.stdout) && narrow.stdout.split("\n").every((line) => line.length <= 80), shown(narrow));
}

// ── docs: one page ───────────────────────────────────────────────────────────────────────────────
let specBody = "";
{
  const json = run(["docs", "architecture", "--json"]);
  const r = json.envelope?.result as { kind: string; slug: string; source: string; refresh: unknown; body: string } | undefined;
  check("a page is the bundled copy, with no refresh asked", json.status === 0 && r?.kind === "docs-page" && r.slug === "architecture" && r.source === "bundled" && r.refresh === null && r.body.startsWith("# Architecture"), r && { ...r, body: r.body.slice(0, 80) });
  const plain = run(["docs", "ARCHITECTURE.md", "--plain"]);
  const lines = plain.stdout.split("\n");
  // A line of the page with no punctuation that plain writes in ASCII, so it reads the same in both.
  const asciiLine = r?.body.split("\n").find((line) => line.length > 20 && /^[\x20-\x7e]+$/.test(line));
  check("a page's slug is matched without case or .md, and the plain page says which copy it is", plain.status === 0 && lines[0] === `bundled v${VERSION}` && plain.stdout.includes("# Architecture") && plain.stdout.includes(asciiLine ?? "\u0000"), shown(plain));
  const spec = run(["docs", "spec", "--json"]);
  specBody = (spec.envelope?.result as { body?: string } | undefined)?.body ?? "";
  check("spec, lang and schema are pages too", spec.status === 0 && specBody.length > 0 && run(["docs", "lang", "--json"]).status === 0 && run(["docs", "schema", "--json"]).status === 0, shown(spec));
}

// ── docs: --refresh says which copy it served ────────────────────────────────────────────────────
{
  const json = run(["docs", "spec", "--refresh", "--json"]);
  const r = json.envelope?.result as { source: string; refresh: string; body: string } | undefined;
  const served = r?.refresh === "served";
  check(
    "--refresh names the copy it served: the remote one, or the bundle with the reason",
    json.status === 0 && json.envelope?.completeness === "complete" && (served ? r?.source === "docs.cotal.ai" : r?.source === "bundled" && ["not-published", "unreachable"].includes(r?.refresh ?? "") && r?.body === specBody),
    r && { source: r.source, refresh: r.refresh, sameAsBundle: r.body === specBody },
  );
}

// ── docs: search ─────────────────────────────────────────────────────────────────────────────────
{
  const json = run(["docs", "--search", "allowSubscribe", "--json"]);
  const r = json.envelope?.result as { kind: string; query: string; hits: { slug: string; heading: string; text: string }[] } | undefined;
  check("--search returns sections that hold the query, each naming its page", json.status === 0 && r?.kind === "docs-search" && r.query === "allowSubscribe" && r.hits.length > 0 && r.hits.every((h) => h.slug && h.heading && /allowsubscribe/i.test(h.text)), r && { hits: r.hits.map((h) => `${h.slug}: ${h.heading}`) });
  const plain = run(["docs", "--search", "allowSubscribe", "--plain"]);
  check("the plain search points at each hit's full page", plain.status === 0 && /read the full page: cotal docs \S+/.test(plain.stdout), shown(plain));
  const none = run(["docs", "--search", "zzqqxxnomatch", "--json"]);
  check("a search with no match is an empty, complete result", none.status === 0 && none.envelope?.completeness === "complete" && (none.envelope.result as { hits: unknown[] }).hits.length === 0, shown(none));
}

// ── docs: usage ──────────────────────────────────────────────────────────────────────────────────
for (const [args, why] of [
  [["docs", "nosuch"], /no docs page "nosuch"; pages: spec, lang, schema, /],
  [["docs", "spec", "cli"], /at most one page/],
  [["docs", "spec", "--search", "x"], /a page or --search, not both/],
  [["docs", "--refresh"], /--refresh applies to reading a page/],
  [["docs", "--search", " "], /--search takes a query/],
  [["docs", "--json", "--plain"], /./],
] as const) {
  const r = run([...args, "--json"]);
  check(`${args.join(" ")} is one USAGE_INVALID envelope, exit 1`, r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID" && why.test(r.envelope.error.message), shown(r));
}

// ── docs: the bundle loads only when docs runs ───────────────────────────────────────────────────
{
  const built = readFileSync(join(import.meta.dirname, "..", "dist", "docs.js"), "utf8");
  check("docs imports the bundle inside run, through its narrow subpath", !/^import[^;]*@cotal-ai\/connector-core/m.test(built) && /await import\("@cotal-ai\/connector-core\/docs"\)/.test(built), built.split("\n").filter((l) => /connector-core/.test(l)));
}

// ── ext: the listing ─────────────────────────────────────────────────────────────────────────────
{
  const root = join(xdg, "cotal", "extensions");
  const empty = run(["ext", "--json"]);
  const er = empty.envelope?.result as { kind: string; root: string; items: unknown[] } | undefined;
  check("bare ext --json is one envelope naming the root, empty on a fresh machine", empty.status === 0 && empty.envelope?.command === "ext" && empty.envelope.target === null && er?.kind === "extensions" && er.root === root && er.items.length === 0, shown(empty));
  const emptyPlain = run(["ext", "--plain"]);
  check("an empty plain listing says how to add one", emptyPlain.status === 0 && /^Extension root: /m.test(emptyPlain.stdout) && /no extensions installed/.test(emptyPlain.stdout), shown(emptyPlain));

  mkdirSync(root, { recursive: true });
  const added = { pkg: "@acme/fake-runtime", version: "1.2.3", spec: "@acme/fake-runtime@1.2.3", provides: [{ kind: "runtime", name: "fakert" }], commands: [] };
  const seeded = { pkg: "@cotal-ai/connector-pi", version: VERSION, spec: "/seed/connector-pi", source: "seeded", provides: [{ kind: "connector", name: "pi" }], commands: [] };
  writeFileSync(join(root, "extensions.json"), JSON.stringify({ extensions: [added, seeded] }));
  const json = run(["ext", "list", "--json"]);
  const items = (json.envelope?.result as { items: unknown[] } | undefined)?.items;
  check(
    "ext list --json holds each installed extension once, with its spec, source and what it provides",
    json.status === 0 &&
      JSON.stringify(items) ===
        JSON.stringify([
          { pkg: added.pkg, version: "1.2.3", spec: added.spec, seeded: false, provides: ["runtime:fakert"] },
          { pkg: seeded.pkg, version: VERSION, spec: seeded.spec, seeded: true, provides: ["connector:pi"] },
        ]),
    items,
  );
  const plain = run(["ext", "--plain"]);
  check("the plain listing is a table with the source of each", plain.status === 0 && /^PACKAGE\s+VERSION\s+SOURCE\s+PROVIDES$/m.test(plain.stdout) && /@acme\/fake-runtime\s+1\.2\.3\s+added\s+runtime:fakert/.test(plain.stdout) && /@cotal-ai\/connector-pi\s+\S+\s+built in\s+connector:pi/.test(plain.stdout) && !/\x1b\[/.test(plain.stdout), shown(plain));
}

// ── ext: root stays raw; the other subcommands refuse the listing's flags ────────────────────────
{
  const root = run(["ext", "root"]);
  check("ext root prints only the path", root.status === 0 && root.stdout === `${join(xdg, "cotal", "extensions")}\n`, shown(root));
  // Only the listing declares structured output, so the other modes refuse its flags as text, and keep
  // their own exits.
  for (const args of [["ext", "root", "--json"], ["ext", "root", "--plain"], ["ext", "remove", "x", "--json"], ["ext", "seed", "--plain"]]) {
    const r = run(args);
    check(`${args.join(" ")} is refused as text with no envelope, exit 1`, r.status === 1 && r.stdout === "" && /--json or --plain|taken by the listing only/.test(r.stderr), shown(r));
  }
  const missing = run(["ext", "remove", "not-installed"]);
  check("a mode without structured output keeps its exit: removing a missing package exits 1", missing.status === 1 && /no installed extension "not-installed"/.test(missing.stderr), shown(missing));
  for (const args of [["ext", "--json", "--plain"], ["ext", "list", "--plain", "--json"]]) {
    const r = run(args);
    check(`${args.join(" ")} is one USAGE_INVALID envelope, exit 1`, r.status === 1 && r.envelope?.error?.code === "USAGE_INVALID", shown(r));
  }
  const listHelp = run(["ext", "list", "--help"]);
  const addHelp = run(["ext", "add", "--help"]);
  check("help names the listing's structured output and no other mode's", /structured output: json, plain/.test(listHelp.stdout) && !/structured output: /.test(addHelp.stdout), { list: listHelp.stdout.slice(-200), add: addHelp.stdout.slice(-200) });
}

finish();
