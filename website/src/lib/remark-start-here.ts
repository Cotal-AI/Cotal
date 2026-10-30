import { remarkSteps } from 'fumadocs-core/mdx-plugins/remark-steps';
import type { Root, RootContent, Nodes, List } from 'mdast';
import type { MdxJsxFlowElement } from 'mdast-util-mdx';
import type { Transformer } from 'unified';

const pages = new Set([
  'what-is-cotal',
  'installation',
  'getting-started',
  'examples',
]);

function textOf(node: Nodes): string {
  if ('value' in node) return node.value;
  if ('children' in node) return node.children.map(textOf).join('');
  return '';
}

function nextStepCards(list: List): MdxJsxFlowElement | undefined {
  const cards: MdxJsxFlowElement[] = [];
  for (const item of list.children) {
    const paragraph = item.children[0];
    if (item.children.length !== 1 || paragraph?.type !== 'paragraph') return;
    const [link, ...description] = paragraph.children;
    if (link?.type !== 'link') return;
    const contents = description.map((node, index) =>
      index === 0 && node.type === 'text'
        ? { ...node, value: node.value.replace(/^\.\s*/, '') }
        : node,
    );
    cards.push({
      type: 'mdxJsxFlowElement',
      name: 'Card',
      attributes: [
        { type: 'mdxJsxAttribute', name: 'href', value: link.url },
        { type: 'mdxJsxAttribute', name: 'title', value: textOf(link) },
      ],
      children: [{ type: 'paragraph', children: contents }],
    });
  }
  return {
    type: 'mdxJsxFlowElement',
    name: 'Cards',
    attributes: [],
    children: cards,
  };
}

export function remarkStartHere(): Transformer<Root> {
  const steps = remarkSteps();
  return (tree, file) => {
    const path = String(file.path).replaceAll('\\', '/');
    const match = /\/content\/docs\/([^/]+)\.mdx?$/.exec(path);
    if (!match?.[1] || !pages.has(match[1])) return;
    if (match[1] === 'getting-started') {
      steps(tree, file, (error) => {
        if (error) throw error;
      });
    }
    let nextSteps = false;
    tree.children = tree.children.map((node): RootContent => {
      if (node.type === 'heading' && node.depth === 2)
        nextSteps = textOf(node) === 'Next steps';
      if (nextSteps && node.type === 'list' && !node.ordered)
        return nextStepCards(node) ?? node;
      return node;
    });
  };
}
