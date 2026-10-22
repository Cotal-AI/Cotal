/** The client build is the shipped page: it must exist after `build`, reference only files it
 *  contains, name every third-party package it bundles with that package's license, and carry the
 *  character art the avatars draw. Its theme boot script loads before the stylesheet and puts the
 *  saved theme on the root element, and its stylesheet's color-scheme follows the theme. Tailwind
 *  comes in without its preflight reset, the shadcn parts' border reset and dark variant land where
 *  the existing styles expect them, and the copied shadcn source and Tailwind carry their licenses. */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { body } from "../client/src/art/index.ts";
import { THEMES } from "../client/src/lib/theme.js";
import { bootTheme } from "../client/src/lib/themeBoot.ts";
import config from "../client/vite.config.js";
import { cssRules } from "./css-rules.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkg, "dist", "web");
let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

ok("the build wrote dist/web/index.html", existsSync(join(out, "index.html")));
const html = readFileSync(join(out, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
ok("the page references at least one script and one stylesheet",
  refs.some((r) => r.endsWith(".js")) && refs.some((r) => r.endsWith(".css")), refs);
for (const r of refs) ok(`the page's reference ${r} is a file in the build`, existsSync(join(out, r)));
ok("every asset other than the theme boot script sits under /assets/", refs.filter((r) => r !== "/theme-boot.js").every((r) => r.startsWith("/assets/")), refs);
ok("the page loads no script from another origin", !/src="https?:/.test(html));

// The theme boot script. The stylesheet blocks the first paint while the module script is deferred,
// so only a classic script that comes before the stylesheet can put the saved theme on the root
// element in time. It is a file of the page's own origin, never inline, so `script-src 'self'` holds.
const bootTag = /<script\b[^>]*\bsrc="\/theme-boot\.js"[^>]*><\/script>/.exec(html);
const sheetAt = html.search(/<link\b[^>]*rel="stylesheet"/);
ok("the page carries no inline script", [...html.matchAll(/<script\b([^>]*)>/g)].every((m) => /\bsrc="/.test(m[1])), html);
ok("the theme boot script is a classic script from the page's own origin, in the head before the stylesheet",
  bootTag !== null && !/type=|defer|async/.test(bootTag[0]) && sheetAt > 0 && bootTag.index < sheetAt && bootTag.index < html.indexOf("</head>"), { tag: bootTag?.[0], at: bootTag?.index, sheetAt });
// The function the build writes into the script, driven directly, then the built script itself.
const marks = (saved: string | null | "blocked") => {
  let set: [string, string] | undefined;
  const storage = () => {
    if (saved === "blocked") throw new Error("storage blocked");
    return { getItem: (k: string) => (k === "cotal.theme" ? saved : null) };
  };
  try {
    bootTheme(storage, { setAttribute: (name, value) => void (set = [name, value]) });
  } catch {
    return "threw";
  }
  return set;
};
ok("bootTheme marks data-theme with each of the theme choices saved under cotal.theme, and system for anything else",
  JSON.stringify([...THEMES.map((t) => marks(t)), marks(null), marks("sepia"), marks("blocked")])
    === JSON.stringify([...THEMES.map((t) => ["data-theme", t]), ["data-theme", "system"], ["data-theme", "system"], ["data-theme", "system"]]));
const bootCode = readFileSync(join(out, "theme-boot.js"), "utf8");
/** The root element's data-theme after the built boot script runs in a fresh page whose storage
 *  holds `saved` (nothing when undefined, or storage that throws when "blocked"), or "threw" when
 *  the script itself threw. */
const booted = (saved: string | undefined | "blocked"): string | null => {
  const page = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
  const win = page.window as unknown as { eval(code: string): unknown; localStorage: { setItem(k: string, v: string): void }; document: { documentElement: { getAttribute(n: string): string | null } } };
  if (saved === "blocked") Object.defineProperty(win, "localStorage", { get() { throw new Error("storage blocked"); } });
  else if (saved !== undefined) win.localStorage.setItem("cotal.theme", saved);
  let threw = false;
  try {
    win.eval(bootCode);
  } catch {
    threw = true;
  }
  const theme = threw ? "threw" : win.document.documentElement.getAttribute("data-theme");
  page.window.close();
  return theme;
};
const runs = { dark: booted("dark"), light: booted("light"), system: booted("system"), none: booted(undefined), junk: booted("sepia"), blocked: booted("blocked") };
ok("the built boot script puts the saved theme on the root element, and system for nothing saved, a value that is no theme, or blocked storage",
  JSON.stringify(runs) === JSON.stringify({ dark: "dark", light: "light", system: "system", none: "system", junk: "system", blocked: "system" }), runs);

// color-scheme, read from the built stylesheet: native scrollbars and form controls follow it.
const css = readdirSync(join(out, "assets")).filter((a) => a.endsWith(".css")).map((a) => readFileSync(join(out, "assets", a), "utf8")).join("\n");
/** The color-scheme a top-level rule with exactly `selector` sets, or undefined. */
const schemeOf = (selector: string): string | undefined => {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) {
        const sel = css.slice(start, i).trim();
        const end = css.indexOf("}", i);
        const scheme = /(?:^|;)\s*color-scheme:\s*([a-z ]+?)\s*(?:;|$)/.exec(css.slice(i + 1, end))?.[1];
        if (sel === selector && scheme) return scheme;
      }
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) start = i + 1;
    }
  }
  return undefined;
};
const schemes = [schemeOf(":root"), schemeOf(":root[data-theme=light]"), schemeOf(":root[data-theme=dark]")];
ok("the built stylesheet's color-scheme follows the theme: light dark for system, and each forced value under its data-theme",
  JSON.stringify(schemes) === JSON.stringify(["light dark", "light", "dark"]), schemes);

// Tailwind comes in without its reset, so the existing screens keep app.css's own base.
const rules = cssRules(css);
const resets = rules.filter((r) => r.selectors.some((s) => s.includes("::backdrop")) && /box-sizing|margin:0|border:0 solid/.test(r.body));
ok("the stylesheet carries no Tailwind preflight: no ::file-selector-button and no reset rule on *, ::after, ::before, ::backdrop",
  !css.includes("::file-selector-button") && resets.length === 0, resets.map((r) => r.selectors));
// Without preflight, shadcn's borders need a border style and colour. The scoped reset gives them both,
// and sits in the base layer so Tailwind's own border utilities still override it.
const SLOT = ":where([data-slot],[data-slot] *)";
const slotResets = rules.filter((r) => r.selectors.includes(SLOT) && /(?:^|;)\s*border(?:-[a-z]+)?\s*:/.test(r.body));
ok("the [data-slot] border reset sits inside @layer base",
  slotResets.length > 0 && slotResets.every((r) => r.within.length === 1 && /^@layer base$/.test(r.within[0]!)), slotResets.map((r) => r.within));
// The mock draws the parts' default borders, Trace's nested rule among them, in --border. With no
// colour here, border: 0 solid falls back to currentColor and the rule takes the text colour.
ok("the [data-slot] border reset draws shadcn borders in our border colour",
  slotResets.length > 0 && slotResets.some((r) => /(?:^|;)\s*border(?:-color)?\s*:[^;]*var\(--border\)/.test(r.body)), slotResets.map((r) => r.body));
// The dark variant follows the theme the way tokens.css does: forced by data-theme="dark", and from
// the OS setting when the theme is system or unset. Button's outline variant uses dark:bg-transparent.
const DARK_BG = ".dark\\:bg-transparent:";
const darkSelectors = rules.filter((r) => /(?:^|;)\s*background-color\s*:/.test(r.body))
  .flatMap((r) => r.selectors.filter((s) => s.startsWith(DARK_BG)).map((selector) => ({ selector, within: r.within })));
ok("a dark: utility from a shadcn file is emitted under [data-theme=dark] and inside @media (prefers-color-scheme: dark)",
  darkSelectors.some((d) => d.selector.includes("[data-theme=dark]") && !d.within.some((w) => w.includes("prefers-color-scheme")))
    && darkSelectors.some((d) => d.selector.includes(":root:not([data-theme=light])") && d.within.some((w) => /prefers-color-scheme:\s*dark/.test(w))),
  darkSelectors);

const licenses = JSON.parse(readFileSync(join(out, "bundle-licenses.json"), "utf8")) as {
  bundled: { package: string; version: string; license: string }[];
};
const names = licenses.bundled.map((b) => b.package);
// marked and DOMPurify are bundled because the message rows render bodies as sanitized Markdown.
// d3-force, d3-selection and d3-zoom are bundled because the topology graph lays out and pans with them.
for (const want of ["react", "react-dom", "@fontsource-variable/inter", "marked", "dompurify", "d3-force", "d3-selection", "d3-zoom"])
  ok(`bundle-licenses.json names ${want}`, names.includes(want), names);
// The shadcn parts and the utilities in shadcn.css are copied source, not a package any module id names.
ok("bundle-licenses.json lists shadcn/ui with MIT and 4.22.1",
  licenses.bundled.some((b) => b.package === "shadcn/ui" && b.license === "MIT" && b.version === "4.22.1"), licenses.bundled);
// Tailwind generates its theme and utilities into the stylesheet, so it ships with no module id either.
const tailwindMeta = JSON.parse(readFileSync(createRequire(join(pkg, "package.json")).resolve("tailwindcss/package.json"), "utf8")) as { version: string; license: string };
ok("bundle-licenses.json lists tailwindcss with its own version and license",
  licenses.bundled.some((b) => b.package === "tailwindcss" && b.version === tailwindMeta.version && b.license === tailwindMeta.license), licenses.bundled);
ok("every bundled package carries a version and a license",
  licenses.bundled.every((b) => b.version && b.license), licenses.bundled);
// The same plain comparison the build sorts with (vite.config.ts), so the two cannot disagree.
ok("bundle-licenses.json is sorted by package", names.join() === [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join());

const assets = readdirSync(join(out, "assets"));
ok("the font ships as a local woff2 file", assets.some((a) => a.endsWith(".woff2")), assets);
// The avatars draw through the art seam, which loads the brand's characters file at run time. A
// bundle that left it out would build and then fail on the first avatar, so the built scripts must
// carry the drawing itself: Claude's body, its pill shape in its fill, as the seam returns it.
const claude = body("claude");
const pill = /rx="32" transform="rotate\(-4 50 50\)"/.exec(claude)?.[0] ?? "";
const fill = /#4663E7/i.exec(claude)?.[0] ?? "";
const scripts = assets.filter((a) => a.endsWith(".js")).map((a) => readFileSync(join(out, "assets", a), "utf8"));
ok("the built scripts carry the character art the avatars draw",
  pill !== "" && fill !== "" && scripts.some((js) => js.includes(pill) && js.includes(fill)), { pill, fill, scripts: scripts.length });
// The manifest's writer, driven directly. The cells above read what one build wrote; these load the
// build config itself and hand its plugin a chunk, so the rule "a bundled module names its package"
// is checked on a known input as well as on whatever the last build happened to bundle.
type Emitted = { fileName: string; source: string };
type LicensesPlugin = { name?: string; generateBundle?: (this: { emitFile(f: Emitted): void }, o: unknown, b: unknown) => void };
const plugins = ((config.plugins ?? []) as unknown[]).flat(3) as LicensesPlugin[];
const licensesPlugin = plugins.find((p) => p?.name === "cotal-bundle-licenses");
ok("the build config carries the bundle-licenses plugin", typeof licensesPlugin?.generateBundle === "function");
const reactEntry = createRequire(join(pkg, "package.json")).resolve("react");
const reactMeta = JSON.parse(readFileSync(join(dirname(reactEntry), "package.json"), "utf8")) as { version: string; license: string };
let emitted: Emitted | undefined;
licensesPlugin!.generateBundle!.call({ emitFile: (f) => { emitted = f; } }, {}, { "index.js": { type: "chunk", moduleIds: [reactEntry] } });
const driven = emitted ? (JSON.parse(emitted.source) as { bundled: { package: string; version: string; license: string }[] }).bundled : [];
// The CSS-only and vendored rows are added whatever the chunks hold, so react is the only package found.
const drivenReact = driven.filter((d) => d.package === "react");
ok("given a chunk holding react, the plugin writes bundle-licenses.json naming react with its own version and license",
  emitted?.fileName === "bundle-licenses.json" && drivenReact.length === 1
    && drivenReact[0]!.version === reactMeta.version && drivenReact[0]!.license === reactMeta.license
    && driven.every((d) => ["react", "shadcn/ui", "tailwindcss"].includes(d.package)), { emitted: emitted?.fileName, driven });
console.log(`client-build: ${n} checks passed`);
