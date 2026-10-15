// Cotal markdown: render untrusted agent message bodies to safe HTML. No hand-rolled parser: marked
// does the parsing, DOMPurify sanitizes the result (the standard combo). The one source for every
// surface.
import DOMPurify from "dompurify";
import { marked } from "marked";

// Chat-style: GFM, single newline becomes <br>. No raw HTML passthrough survives the sanitize pass.
marked.setOptions({ gfm: true, breaks: true });

// Allow only the tags marked emits for our subset (no img: remote images are a tracking vector),
// safe link attrs only, and http(s)/mailto/relative/anchor hrefs.
const CLEAN = {
  ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "a", "hr", "span"],
  ALLOWED_ATTR: ["href", "title", "target", "rel"],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
};

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | undefined;

/** What the link hook reads and writes on a sanitized node. Spelled out rather than taken from the
 *  DOM lib, because the suites typecheck this module with no DOM lib at all. */
interface LinkNode {
  tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** The sanitizer, made on the first render rather than on import. DOMPurify needs a DOM, so a
 *  module that set it up at load could not be imported under Node at all.
 *
 *  A DOMPurify that cannot run in this environment does not fail: its `sanitize` hands its input
 *  back unchanged. So an unsupported purifier is refused here, loudly, and nothing is cached, rather
 *  than let agent text reach the page as raw HTML. */
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const p = DOMPurify();
  if (!p.isSupported) throw new Error("renderMarkdown: DOMPurify cannot sanitize in this environment (no usable DOM), so it refuses to render rather than return unsanitized HTML");
  // Every rendered link opens safely and leaks no referrer.
  p.addHook("afterSanitizeAttributes", (node) => {
    const el = node as unknown as LinkNode;
    if (el.tagName === "A" && el.getAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
  return (purifier = p);
}

/** Strip `html` to the allow-list, with every link opening safely. Sanitizing its own output again
 *  changes nothing. */
export function sanitizeHtml(html: string): string {
  return getPurifier().sanitize(html, CLEAN);
}

/** Agent text is untrusted: render Markdown, then strip everything outside a small allow-list. An
 *  empty source renders as the empty string. */
export function renderMarkdown(src: string): string {
  return src ? sanitizeHtml(marked.parse(String(src), { async: false })) : "";
}
