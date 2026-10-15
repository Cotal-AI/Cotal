/** The Markdown renderer that draws every message body: `renderMarkdown` in `client/src/lib/md.ts`,
 *  run against a real DOM. Agent text is untrusted, so what matters is what the sanitizer leaves:
 *  raw HTML is stripped, a link can only lead to http(s), mailto, a relative path or an anchor, every
 *  link opens in a new tab with no opener and no referrer, and the Markdown a message actually uses
 *  (lists, code, quotes, headings) survives. Each cell renders a source and reads the HTML.
 *
 *  The DOM is happy-dom, installed by `dom-globals.ts` before `md.ts` makes its sanitizer. Two parts
 *  of happy-dom break DOMPurify in ways no browser does, and `dom-globals.ts` replaces them. The first
 *  three cells are the evidence for that: each shows the native part misbehaving, so a reader can see
 *  the replacement is not decoration. */
import { strict as assert } from "node:assert";
import { closeDom, dom, nativeCreateNodeIterator, nativeNodeName, SpecNodeIterator } from "./dom-globals.js";
import { renderMarkdown } from "../client/src/lib/md.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

/** The `<a ...>` start tags in `html`, each as its attributes. */
const links = (html: string): Record<string, string>[] =>
  [...html.matchAll(/<a\b([^>]*)>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/\s([a-z-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));

// ── 1. The DOM the sanitizer runs in ─────────────────────────────────────────────────────────────
type Walkable = { nodeName: string; remove(): void };
{
  const doc = dom.document as unknown as {
    createElement(t: string): { innerHTML: string } & Walkable;
  };
  const walk = (make: (root: unknown) => { nextNode(): Walkable | null }) => {
    const root = doc.createElement("div");
    root.innerHTML = "<p>a<script>x</script><b>after</b></p>";
    const it = make(root);
    const seen: string[] = [];
    for (let node = it.nextNode(); node; node = it.nextNode()) {
      seen.push(node.nodeName);
      if (node.nodeName === "SCRIPT") node.remove();
    }
    return seen;
  };
  const native = walk((root) => nativeCreateNodeIterator.call(dom.document, root as never, 0xffffffff, null) as never);
  ok("1.1 CONTROL: happy-dom's own NodeIterator stops at the first removal, so it never reaches what follows",
    native.includes("SCRIPT") && !native.includes("B"), native);
  const spec = walk((root) => new SpecNodeIterator(root as never) as never);
  ok("1.2 the replacement resumes after a removed node, as the DOM standard says it must",
    spec.join() === "DIV,P,#text,SCRIPT,B,#text", spec);
  const p = (dom.document as unknown as { createElement(t: string): object }).createElement("p");
  ok("1.3 CONTROL: happy-dom's base nodeName getter, the one DOMPurify reads, does not name an element",
    nativeNodeName(p) !== "P" && (p as { nodeName: string }).nodeName === "P", nativeNodeName(p));
}

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
}

// ── 3. Links ─────────────────────────────────────────────────────────────────────────────────────
{
  const js = links(renderMarkdown("[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](vbscript:x)"));
  ok("3.1 a javascript: or vbscript: link loses its href, in any letter case", js.length === 3 && js.every((a) => !("href" in a)), js);
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

await closeDom();
console.log(`markdown: ${n} checks passed`);
