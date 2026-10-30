import { docs } from '../../.source/server';
import { navigation } from '../generated/navigation.mjs';
import { loader } from 'fumadocs-core/source';
import { createElement } from 'react';
import { connectorIcons } from './connector-icons.mjs';
import { buildNavigationTree } from './navigation';

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  icon(name) {
    if (!name) return;
    const src = connectorIcons.get(name);
    if (!src) throw new Error(`unknown page icon: ${name}`);
    return createElement('img', {
      src,
      alt: '',
      'aria-hidden': true,
      width: 16,
      height: 16,
      className: 'size-4 shrink-0 object-contain',
    });
  },
  pageTree: {
    transformers: [{ root: (root) => buildNavigationTree(root, navigation) }],
  },
});
