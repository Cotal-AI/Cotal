// Public HTTP reference routes and their canonical repository sources.
export const httpReferences = [
  { id: 'dashboard', label: 'Dashboard HTTP', source: 'implementations/web/openapi.json' },
  { id: 'auth', label: 'Auth HTTP', source: 'implementations/auth/openapi.json' },
].map((reference) => ({
  ...reference,
  base: `api/${reference.id}`,
  docSlug: `${reference.id}-api`,
  docSource: `docs/${reference.id}-api.mdx`,
  specFile: `${reference.id}.openapi.json`,
}));
