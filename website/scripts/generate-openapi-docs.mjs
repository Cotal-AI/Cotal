import { readFileSync, writeFileSync } from 'node:fs';
import { validate } from '@readme/openapi-parser';
import { dashboardMarkdown, loadDashboardSpec } from './dashboard-api.mjs';

const spec = loadDashboardSpec();
await validate(structuredClone(spec), { dereference: { circular: 'ignore' } });
const markdown = dashboardMarkdown(spec);
const target = new URL('../../docs/dashboard-api.md', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== markdown) throw new Error('Dashboard reference is stale; run npm --prefix website run gen:api');
} else writeFileSync(target, markdown);

console.log('generate-openapi-docs: canonical dashboard Markdown is current');
