import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkStringify from 'remark-stringify';

/** @param {string} markdown @returns {string} */
export function markdownToMdx(markdown) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  return unified()
    .use(remarkStringify, {
      handlers: { html: (node, _parent, state, info) => state.safe(node.value, info) },
    })
    .use(remarkGfm)
    .use(remarkMdx)
    .stringify(tree);
}
