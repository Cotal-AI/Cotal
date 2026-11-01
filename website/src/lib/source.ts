import { docs } from '../../.source/server';
import { navigation } from '../generated/navigation.mjs';
import { httpOperations } from '../generated/http-operations.mjs';
import { httpReferences } from '../http-references.js';
import { loader } from 'fumadocs-core/source';
import { openapiPlugin } from 'fumadocs-openapi/server';
import { createElement } from 'react';
import { connectorIcons } from './connector-icons.mjs';
import { buildNavigationTree } from './navigation';

const overviewUrls = new Set(httpReferences.map(reference => `/${reference.base}`));

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  plugins: [openapiPlugin()],
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
    transformers: [{
      file(node) {
        const url = node.url.replace(/\/$/, '');
        const operation = httpOperations[url];
        if (operation) node.name = operation.sidebarTitle;
        else if (overviewUrls.has(url)) node.name = 'Overview';
        return node;
      },
      root: (root) => buildNavigationTree(root, navigation),
    }],
  },
});
