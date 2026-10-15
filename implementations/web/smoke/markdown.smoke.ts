/** The Markdown renderer that draws every message body: `renderMarkdown` in `client/src/lib/md.ts`,
 *  run against a real DOM. Agent text is untrusted, so what matters is what the sanitizer leaves:
 *  raw HTML is stripped, a link can only lead to http(s), mailto, a relative path or an anchor, every
 *  link opens in a new tab with no opener and no referrer, and the Markdown a message actually uses
 *  (lists, code, quotes, headings) survives. Each cell renders a source and reads the HTML.
 *
 *  The DOM is jsdom, DOMPurify's own test environment. It is installed by `dom-globals.ts` after the
 *  first cell, because that cell needs the process WITHOUT a usable DOM: it proves the renderer
 *  refuses to run there instead of handing back the HTML unsanitized. */
import { strict as assert } from "node:assert";
import { JSDOM } from "jsdom";
import { renderMarkdown, sanitizeHtml } from "../client/src/lib/md.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

/** The `<a ...>` start tags in `html`, each as its attributes. */
const links = (html: string): Record<string, string>[] =>
  [...html.matchAll(/<a\b([^>]*)>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/\s([a-z-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));

/** Sources covering every kind of element and link the suite renders, for the second-pass cell. */
const CORPUS = [
  "before <script>alert(1)</script> after",
  '<img src="x" onerror="alert(1)"> <iframe src="https://evil.example"></iframe>',
  '<u>kept <img src=x onerror=alert(1)></u>',
  "[s](https://cotal.example/a) [m](mailto:ops@cotal.example) [r](/docs/a) [h](#top) [j](javascript:alert(1))",
  '<a href="https://cotal.example" target="_self" rel="opener">x</a>',
  "- one\n- two\n\n```\nconst a = '<b>';\n```\n\n# Title\n\n> quoted\n\n**strong** *em* ~~gone~~",
];

// ── 1. The sanitizer itself ──────────────────────────────────────────────────────────────────────
{
  // A window that is complete except for the one thing DOMPurify checks last: it builds a full
  // purifier object, reports isSupported false, and its sanitize would return the input unchanged.
  // The window is its own realm, so taking createHTMLDocument off its DOMImplementation touches no
  // other window.
  const bare = new JSDOM("<!doctype html><body></body>");
  const impl = (bare.window as unknown as { DOMImplementation: { prototype: object } }).DOMImplementation.prototype;
  Object.defineProperty(impl, "createHTMLDocument", { value: undefined });
  const g = globalThis as { window?: unknown };
  g.window = bare.window;
  let out: string | undefined;
  let error = "";
  try { out = renderMarkdown("<b>x</b><script>alert(1)</script>"); } catch (e) { error = String(e); }
  delete g.window;
  ok("1.1 a purifier that cannot run here makes renderMarkdown throw, never return the HTML unsanitized",
    out === undefined && /refuses to render rather than return unsanitized HTML/.test(error), { out, error });
}
await import("./dom-globals.js");

// ── 2. Raw HTML does not survive ─────────────────────────────────────────────────────────────────
{
  const script = renderMarkdown("before <script>alert(1)</script> after");
  ok("2.1 a script element is removed with its content", !/<script/i.test(script) && !script.includes("alert(1)") && script.includes("before"), script);
  const img = renderMarkdown('<img src="x" onerror="alert(1)">');
  ok("2.2 a raw img with onerror is removed", !/<img/i.test(img) && !img.includes("onerror"), img);
  const md = renderMarkdown("![pixel](https://tracker.example/p.png)");
  ok("2.3 a Markdown image draws no img either, so no remote image loads", !/<img/i.test(md), md);
  const frame = renderMarkdown('<iframe src="https://evil.example"></iframe>');
  ok("2.4 an iframe is removed", !/<iframe/i.test(frame), frame);
  const handler = renderMarkdown('<span onclick="alert(1)" onmouseover="x">hi</span>');
  ok("2.5 event handler attributes are removed and the text stays", !/on(click|mouseover)/i.test(handler) && handler.includes("hi"), handler);
  const styled = renderMarkdown('<span style="position:fixed" class="x">hi</span>');
  ok("2.6 style and class attributes are removed", !/style=|class=/.test(styled), styled);
  const other = renderMarkdown("<form><input></form><style>p{}</style><object></object><svg><script>x</script></svg>");
  ok("2.7 form, input, style, object and svg are not on the allow-list", !/<(form|input|style|object|svg|script)/i.test(other), other);
  const wrapped = renderMarkdown("<u>kept <img src=x onerror=alert(1)></u> and <b>bold</b>");
  ok("2.8 a disallowed wrapper keeps its text and still loses the dangerous element inside it",
    wrapped.includes("kept") && wrapped.includes("bold") && !/<img|onerror|<u>|<b>/i.test(wrapped), wrapped);
}

// ── 3. Links ─────────────────────────────────────────────────────────────────────────────────────
{
  const js = links(renderMarkdown("[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](vbscript:x)"));
  ok("3.1 a javascript: or vbscript: link loses its href, in any letter case", js.length === 3 && js.every((a) => !("href" in a)), js);
  const tail = links(renderMarkdown(`<a href="javascript:alert('https://cotal.example')">x</a>`));
  ok("3.1b a javascript: link that names https further on still loses its href: the pattern is anchored", tail.length === 1 && !("href" in tail[0]), tail);
  const data = links(renderMarkdown("[d](data:text/html,<b>x</b>)"));
  ok("3.2 a data: link loses its href", data.length === 1 && !("href" in data[0]), data);
  const web = links(renderMarkdown("[s](https://cotal.example/a) [p](http://cotal.example/b)"));
  ok("3.3 http and https links keep their href", web.map((a) => a.href).join() === "https://cotal.example/a,http://cotal.example/b", web);
  ok("3.4 and open in a new tab", web.length === 2 && web.every((a) => a.target === "_blank"), web);
  ok("3.5 with no opener, no referrer and no follow", web.every((a) => a.rel === "noopener noreferrer nofollow"), web);
  const mail = links(renderMarkdown("[m](mailto:ops@cotal.example)"));
  ok("3.6 a mailto link survives, with the same target and rel",
    mail.length === 1 && mail[0].href === "mailto:ops@cotal.example" && mail[0].target === "_blank" && mail[0].rel === "noopener noreferrer nofollow", mail);
  const local = links(renderMarkdown("[r](/docs/a) [h](#top)"));
  ok("3.7 a relative path and an anchor survive", local.map((a) => a.href).join() === "/docs/a,#top", local);
  const own = links(renderMarkdown('<a href="https://cotal.example" target="_self" rel="opener">x</a>'));
  ok("3.8 an author's own target and rel are replaced, not kept",
    own.length === 1 && own[0].target === "_blank" && own[0].rel === "noopener noreferrer nofollow", own);
  const hidden = links(renderMarkdown('<a href="&#106;avascript:alert(1)">a</a> <a href=" javascript:alert(1)">b</a> <a href="java&#9;script:alert(1)">c</a> <a href="java\tscript:alert(1)">d</a>'));
  ok("3.9 an encoded, padded or tab-split javascript: scheme still loses its href", hidden.length === 4 && hidden.every((a) => !("href" in a)), hidden);
}

// ── 4. The Markdown a message uses survives ──────────────────────────────────────────────────────
{
  const list = renderMarkdown("- one\n- two\n\n1. first");
  ok("4.1 bullet and numbered lists survive", /<ul>[\s\S]*<li>one<\/li>[\s\S]*<\/ul>/.test(list) && /<ol>[\s\S]*<li>first<\/li>/.test(list), list);
  const code = renderMarkdown("```\nconst a = '<b>';\n```\n\nand `inline`");
  ok("4.2 a code block survives with HTML inside it escaped, not parsed", code.includes("<pre><code>") && code.includes("&lt;b&gt;") && !code.includes("<b>"), code);
  ok("4.3 inline code survives", code.includes("<code>inline</code>"), code);
  const rich = renderMarkdown("# Title\n\n> quoted\n\n---\n\n**strong** *em* ~~gone~~");
  ok("4.4 headings, quotes, rules, strong, em and strikethrough survive",
    ["<h1>Title</h1>", "<blockquote>", "<hr>", "<strong>strong</strong>", "<em>em</em>", "<del>gone</del>"].every((t) => rich.includes(t)), rich);
  const lines = renderMarkdown("one\ntwo");
  ok("4.5 a single newline is a line break, as in chat", lines.includes("one<br>two"), lines);
  ok("4.6 an empty body renders as the empty string", renderMarkdown("") === "");
}

// ── 5. A second pass ─────────────────────────────────────────────────────────────────────────────
{
  const once = CORPUS.map((src) => renderMarkdown(src));
  const changed = once.filter((html) => sanitizeHtml(html) !== html);
  ok("5.1 sanitizing the rendered output a second time changes nothing", changed.length === 0, changed);
}

const { closeDom } = await import("./dom-globals.js");
await closeDom();
console.log(`markdown: ${n} checks passed`);
