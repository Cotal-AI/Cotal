import type { Folder, Item, Node, Root } from 'fumadocs-core/page-tree';

export type NavigationNode =
  | { kind: 'page'; url: string }
  | { kind: 'group'; title: string; children: NavigationNode[] };

export interface NavigationSection {
  section: 'docs' | 'api-reference';
  title: string;
  children: NavigationNode[];
}

export function buildNavigationTree(
  root: Root,
  navigation: NavigationSection[],
): Root {
  const key = (url: string) => url.replace(/\/$/, '');
  const pages = new Map<string, Item>();
  const sections = new Map<string, Folder>();
  const collect = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.type === 'page') pages.set(key(node.url), node);
      if (node.type === 'folder') {
        if (node.root && node.$ref) sections.set(node.$ref.folder, node);
        if (node.index) pages.set(key(node.index.url), node.index);
        collect(node.children);
      }
    }
  };
  collect(root.children);
  const used = new Set<string>();
  const render = (node: NavigationNode, path: string): Node => {
    if (node.kind === 'page') {
      const page = pages.get(key(node.url));
      if (!page)
        throw new Error(`navigation names an unloaded page: ${node.url}`);
      if (used.has(key(node.url)))
        throw new Error(`page has multiple navigation homes: ${node.url}`);
      used.add(key(node.url));
      return page;
    }
    const id = `${path}/${node.title.toLowerCase().replace(/\s+/g, '-')}`;
    return {
      type: 'folder',
      $id: id,
      name: node.title,
      defaultOpen: false,
      children: node.children.map((child) => render(child, id)),
    };
  };
  const children = navigation.map((section) => {
    const original = sections.get(section.section);
    if (!original)
      throw new Error(`missing navigation section: ${section.section}`);
    const children = section.children.flatMap((node): Node[] => {
      if (node.kind === 'page') return [render(node, section.section)];
      return [
        { type: 'separator', name: node.title },
        ...node.children.map((child) => render(child, section.section)),
      ];
    });
    return { ...original, name: section.title, children };
  });
  for (const url of pages.keys()) {
    if (!used.has(url))
      throw new Error(`published page has no navigation home: ${url}`);
  }
  return { ...root, children };
}
