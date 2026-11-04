import { marked } from 'marked';
import { parse } from 'parse5';

// A srcset URL is a run of non-whitespace characters; commas inside it belong to the URL
// (including data URLs). Trailing commas end a candidate, as do descriptors followed by a comma.
const SRCSET_CANDIDATE = /([\t\n\f\r ,]*)([^\t\n\f\r ]+)(?<!,)([^,]*)/g;
const URL_ATTRS = new Set(['href', 'src', 'srcset']);

/** Refuse relative link targets in rendered HTML or Markdown, without reading code as links. */
export function assertPublishedLinks(source, file) {
  const check = value => {
    // Match the URL parser's treatment of leading/trailing controls and embedded tabs/newlines.
    const target = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) return;
    throw new Error(`repo-relative link leaked into ${file}: ${JSON.stringify(value)}`);
  };
  let html = source;
  if (!file.endsWith('.html')) {
    const tokens = marked.lexer(source);
    html = marked.parser(tokens);
    // Render unused definitions through the same URL escaping as a referenced link.
    for (const definition of Object.values(tokens.links)) {
      html += marked.Parser.parseInline([{ type: 'link', raw: '', text: '', tokens: [], ...definition }]);
    }
  }
  const walk = node => {
    for (const { name, value } of node.attrs ?? []) {
      if (!URL_ATTRS.has(name)) continue;
      if (name === 'srcset') {
        for (const candidate of value.matchAll(SRCSET_CANDIDATE)) check(candidate[2]);
      } else check(value);
    }
    for (const child of (node.content ?? node).childNodes ?? []) walk(child);
  };
  walk(parse(html));
}
