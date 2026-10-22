/** The dashboard's copy and style rules hold across the client source: no em or en dashes (one pinned
 *  fallback string excepted), no uppercase text, no positive letter-spacing, no Geist or Work Sans, no
 *  network call outside api/, and a token file that defines both palettes. Tailwind classes live only
 *  in the copied shadcn parts, shadcn's colour names are bridged from ours, and every running
 *  animation in app.css stops under reduced motion. */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "src");
let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

const read = (path: string) => readFileSync(path, "utf8");
const sources: { rel: string; text: string }[] = [];
for (const entry of readdirSync(src, { recursive: true }) as string[]) {
  if (/\.(tsx?|css)$/.test(entry)) sources.push({ rel: entry.split("\\").join("/"), text: readFileSync(join(src, entry), "utf8") });
}
const lines = sources.flatMap((f) => f.text.split("\n").map((text, i) => ({ rel: f.rel, line: i + 1, text })));
/** Every line that matches, as `file:line: text`, so a failure names the place. */
const hits = (re: RegExp, only = (_rel: string) => true) =>
  lines.filter((l) => only(l.rel) && re.test(l.text)).map((l) => `${l.rel}:${l.line}: ${l.text.trim()}`);

ok("the client source has files to scan", sources.length > 0, sources.length);

/** The one line allowed a dash: the pinned fallback for a part kind with no renderer. It is written as an escape in source. */
const PINNED = { rel: "lib/parts.ts", text: "return `[unrenderable part kind ${JSON.stringify(kind)} \\u2014 no renderer for it on this surface]`;" };
const DASH = /[\u2014\u2013]|\\u\{?(?:2014|2013)\}?|&(?:m|n)dash;|&#(?:8212|8211|x2014|x2013);/i;
const dashes = lines.filter((l) => DASH.test(l.text));
const pinned = dashes.filter((l) => l.rel === PINNED.rel && l.text.trim() === PINNED.text);
ok("the pinned fallback string is still in lib/parts.ts, once", pinned.length === 1, pinned);
ok("no em or en dash anywhere outside the pinned fallback string",
  dashes.length === pinned.length, dashes.filter((l) => !pinned.includes(l)).map((l) => `${l.rel}:${l.line}: ${l.text.trim()}`));

ok("no uppercase text-transform", hits(/text-transform\s*:\s*uppercase|textTransform\s*:\s*["']uppercase/i).length === 0,
  hits(/text-transform\s*:\s*uppercase|textTransform\s*:\s*["']uppercase/i));

const spacing = lines.flatMap((l) =>
  [...l.text.matchAll(/(?:letter-spacing|letterSpacing)\s*:\s*["']?([^;}"',]+)/g)].map((m) => ({ at: `${l.rel}:${l.line}`, value: m[1]!.trim() })));
const positive = spacing.filter(({ value }) => {
  if (/^(normal|inherit|initial|unset)$/.test(value)) return false;
  const num = /^(-?\d*\.?\d+)/.exec(value);
  return !num || Number(num[1]) > 0;
});
ok("no letter-spacing above 0", positive.length === 0, positive);

ok("no Geist or Work Sans", hits(/\b(Geist|Work Sans)\b/i).length === 0, hits(/\b(Geist|Work Sans)\b/i));

const network = /\bfetch\s*\(|new\s+EventSource\s*\(/;
const isCode = (text: string) => !/^\s*(\/\/|\/\*|\*)/.test(text);
const outsideApi = lines.filter((l) => /\.tsx?$/.test(l.rel) && !l.rel.startsWith("api/") && isCode(l.text) && network.test(l.text));
ok("no fetch( or new EventSource( outside api/, comments aside",
  outsideApi.length === 0, outsideApi.map((l) => `${l.rel}:${l.line}: ${l.text.trim()}`));

const tokensPath = join(src, "styles", "tokens.css");
ok("styles/tokens.css exists", existsSync(tokensPath));
const tokens = read(tokensPath);
/** The declarations of the block opened by `selector`, matched on its whole header line. */
const block = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return undefined;
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", at) + 1, i);
  }
  return undefined;
};
const vars = (body: string) => new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

const light = block(tokens, ":root");
const night = block(tokens, ':root[data-theme="dark"]');
const media = block(tokens, "@media (prefers-color-scheme: dark)");
const system = media && block(media, ':root:not([data-theme="light"])');
ok("tokens.css defines the Quiet palette on :root", !!light && vars(light).get("--bg") === "#FFFFFF" && vars(light).get("--ink") === "#1F2430");
ok('tokens.css defines the Night palette on :root[data-theme="dark"]', !!night && vars(night).get("--bg") === "#16181D" && vars(night).get("--ink") === "#E6E8EE");
ok("tokens.css gives system the Night palette in a prefers-color-scheme: dark block that spares data-theme=light",
  !!system && vars(system).get("--bg") === "#16181D" && vars(system).get("--ink") === "#E6E8EE");
const nightVars = vars(night ?? ""), systemVars = vars(system ?? ""), lightVars = vars(light ?? "");
ok("the system block and the dark block carry the same declarations",
  nightVars.size > 0 && [...nightVars].every(([k, v]) => systemVars.get(k) === v) && systemVars.size === nightVars.size);
ok("every Night token overrides a Quiet token", [...nightVars.keys()].every((k) => lightVars.has(k)), [...nightVars.keys()].filter((k) => !lightVars.has(k)));
ok("the fonts are Inter Variable and the system mono stack",
  lightVars.get("--body") === '"Inter Variable", system-ui, sans-serif' && lightVars.get("--mono") === 'ui-monospace, "SF Mono", Menlo, Consolas, monospace');

const app = read(join(src, "styles", "app.css"));
const defined = new Set([...lightVars.keys(), ...[...app.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!)]);
const unknown = [...new Set([...app.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!))].filter((v) => !defined.has(v));
ok("every var() in app.css names a token", unknown.length === 0, unknown);
const literals = app.split("\n").filter((l) => !/mask-image/.test(l) && /#[0-9a-f]{3,8}\b|\brgba?\(/i.test(l));
ok("app.css holds no colour literal, only tokens", literals.length === 0, literals);
const scoped = app.split("\n").filter((l) => /(^|[\s,>+~])\.v3(?![\w-])/.test(l));
ok("app.css has no .v3 scope: no element has to carry a root class", scoped.length === 0, scoped);

// The copied shadcn parts keep the type rules too: Tailwind classes, not CSS, so the checks above miss them.
const shadcnLines = lines.filter((l) => l.rel.startsWith("ui/shadcn/"));
const loud = /(?<![\w-])(?:uppercase|tracking-(?:wide|wider|widest))(?![\w-])/;
ok("no `uppercase` class and no tracking-wide, tracking-wider or tracking-widest in ui/shadcn",
  shadcnLines.length > 0 && hits(loud, (rel) => rel.startsWith("ui/shadcn/")).length === 0,
  hits(loud, (rel) => rel.startsWith("ui/shadcn/")));

// Tailwind utilities come only from the copied shadcn files: shadcn.css scans ui/shadcn alone, so a
// utility written anywhere else would silently do nothing, or match a class Tailwind happens to emit.
// Product parts style with app.css classes. The ui-*, v3-* and ox-* names never match this list.
const REFUSED = /^(?:flex|grid|hidden|border|rounded|truncate|text-sm|(?:p|px|py|gap|bg)-.+)$/;
const tailwindOutside = lines
  .filter((l) => l.rel.endsWith(".tsx") && !l.rel.startsWith("ui/shadcn/") && l.text.includes("className"))
  .flatMap((l) => [...l.text.slice(l.text.indexOf("className")).matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? m[3]!).split(/\s+/))
    .filter((token) => REFUSED.test(token.split(":").pop()!.replace(/^!/, "")))
    .map((token) => `${l.rel}:${l.line}: ${token}`));
ok("no Tailwind utility class outside ui/shadcn", tailwindOutside.length === 0, tailwindOutside);

/** shadcn's names, each set on :root from one of our tokens, so Night follows from our Night blocks. */
const BRIDGE: Record<string, string> = {
  "--background": "--bg", "--foreground": "--ink", "--card-foreground": "--ink", "--popover-foreground": "--ink",
  "--secondary-foreground": "--ink", "--accent-foreground": "--ink", "--muted": "--soft", "--secondary": "--soft",
  "--muted-foreground": "--dim", "--border": "--line", "--input": "--card-line", "--ring": "--focus",
  "--accent": "--hover", "--primary-foreground": "--primary-ink", "--destructive": "--red-ink", "--popover": "--card",
};
const unbridged = Object.entries(BRIDGE).filter(([name, ours]) => lightVars.get(name) !== `var(${ours})` || nightVars.has(name) || systemVars.has(name));
ok("tokens.css's :root defines each bridged shadcn name as var(--ours) per the map", unbridged.length === 0,
  unbridged.map(([name]) => ({ name, root: lightVars.get(name), night: nightVars.get(name), system: systemVars.get(name) })));

// Every class rule in app.css that runs an animation is stopped under reduced motion.
type CssRule = { selector: string; body: string; within: string[] };
/** The style rules of `css`, comments removed, each with the at-rules around it, outermost first. */
const cssRules = (css: string, within: string[] = []): CssRule[] => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < text.length; close++) {
      if (text[close] === "{") depth++;
      else if (text[close] === "}" && --depth === 0) break;
    }
    const head = text.slice(i, open).trim();
    const inner = text.slice(open + 1, close);
    if (/^@(?:media|layer|supports)\b/.test(head)) out.push(...cssRules(inner, [...within, head]));
    else if (!head.startsWith("@")) out.push({ selector: head, body: inner, within });
    i = close + 1;
  }
  return out;
};
const appRules = cssRules(app);
const reduced = (r: CssRule) => r.within.some((w) => /prefers-reduced-motion:\s*reduce/.test(w));
const sets = (body: string) => /(?:^|;)\s*animation(?:-name)?\s*:\s*([^;]+)/.exec(body)?.[1]?.trim();
const animated = appRules.filter((r) => !reduced(r) && sets(r.body) && sets(r.body) !== "none")
  .flatMap((r) => r.selector.split(",").map((s) => s.trim())).filter((s) => s.includes("."));
const stopped = new Set(appRules.filter((r) => reduced(r) && sets(r.body) === "none")
  .flatMap((r) => r.selector.split(",").map((s) => s.trim())));
const moving = animated.filter((s) => !stopped.has(s));
ok("every class rule in app.css with a running animation also has a reduced-motion rule",
  animated.length > 0 && moving.length === 0, moving);

const touchesBrowser =/\b(window|document|localStorage|sessionStorage)\b|\bfetch\s*\(|new\s+EventSource\s*\(/;
const impure = lines.filter((l) => /^(lib|state)\//.test(l.rel) && l.rel !== "lib/md.ts" && isCode(l.text) && touchesBrowser.test(l.text));
ok("lib/ and state/ stay free of window, document, storage, fetch and EventSource, except lib/md.ts",
  impure.length === 0, impure.map((l) => `${l.rel}:${l.line}: ${l.text.trim()}`));
console.log(`client-copy: ${n} checks passed`);
