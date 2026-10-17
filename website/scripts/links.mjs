// How the site classifies a link target, shared by the sync that rewrites links and the
// post-build check that refuses any it left relative.
import { parse, postprocess, preprocess } from 'micromark';

// Absolute URLs, site-root paths and same-page anchors already resolve on the site.
export const isRepoRelative = (target) =>
  !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('/') && !target.startsWith('#');

// The attributes through which an HTML or JSX tag names a URL. A srcset lists candidates, each a
// URL (a run of non-whitespace, less the commas that end it) and descriptors up to the next comma.
export const URL_ATTRS = new Set(['href', 'src', 'srcset']);
export const SRCSET_CANDIDATE = /([\t\n\f\r ,]*)([^\t\n\f\r ]+)(?<!,)([^,]*)/g;

// The URL parser's first steps: it drops leading and trailing C0 controls and spaces and every
// tab and newline, so a value is classified by the URL the browser resolves.
export const urlInput = (value) => value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');

// Returns micromark's events, the text their offsets index, and that text with each blockquote's
// `>` line prefixes blanked: the browser never sees them, so the HTML in a blockquote must parse
// without them.
export function parseMarkdown(md, extensions) {
  // micromark skips one leading BOM and counts offsets from after it, so none may remain.
  md = md.replace(/^\uFEFF+/, '');
  const events = postprocess(parse({ extensions }).document().write(preprocess()(md, undefined, true)));
  const html = md.split('');
  for (const [kind, { type, start, end }] of events)
    if (kind === 'enter' && type === 'blockQuotePrefix') html.fill(' ', start.offset, end.offset);
  return { md, events, html: html.join('') };
}
