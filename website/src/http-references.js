// HTTP reference routes and their canonical repository sources.
export const httpReferences = [
  { id: 'dashboard', label: 'Dashboard HTTP', source: 'implementations/web/openapi.json' },
  { id: 'auth', label: 'Auth HTTP', source: 'implementations/auth/openapi.json' },
  { id: 'auth-host', label: 'Auth host HTTP', source: 'implementations/auth/host.openapi.json' },
  { id: 'manager-console', label: 'Manager console HTTP', source: 'implementations/manager/openapi.json' },
  { id: 'feedback-intake', label: 'Feedback intake HTTP', source: 'implementations/delivery/openapi.json' },
].map((reference) => ({
  ...reference,
  base: `api/${reference.id}`,
  docSlug: `${reference.id}-api`,
  docSource: `docs/${reference.id}-api.mdx`,
  specFile: `${reference.id}.openapi.json`,
}));
