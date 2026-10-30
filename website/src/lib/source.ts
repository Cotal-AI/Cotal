import { docs } from '../../.source/server';
import { navigation } from '../generated/navigation.mjs';
import { loader } from 'fumadocs-core/source';
import { buildNavigationTree } from './navigation';

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  pageTree: {
    transformers: [{ root: (root) => buildNavigationTree(root, navigation) }],
  },
});
