// Cotal markdown: render UNTRUSTED agent message bodies to safe HTML. No hand-rolled parser —
// marked does the parsing, DOMPurify sanitizes the result (the standard combo). One source
// (window.COTAL_MD) for every surface. marked/DOMPurify are served from /vendor/ before this file.
(function () {
  const marked = window.marked;
  const DOMPurify = window.DOMPurify;
  if (!marked || !DOMPurify) throw new Error("markdown libs missing (marked / DOMPurify not loaded)");

  // Chat-style: GFM, single newline → <br>. No raw HTML passthrough survives the sanitize pass.
  marked.setOptions({ gfm: true, breaks: true });

  // Every rendered link opens safely and leaks no referrer.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });

  // Allow only the tags marked emits for our subset (no img — remote images are a tracking vector),
  // safe link attrs only, and http(s)/mailto/relative/anchor hrefs.
  const CLEAN = {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "code", "pre", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "a", "hr", "span"],
    ALLOWED_ATTR: ["href", "title", "target", "rel"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
  };

  const render = (src) => (src ? DOMPurify.sanitize(marked.parse(String(src)), CLEAN) : "");
  window.COTAL_MD = { render };
})();
