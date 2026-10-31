import { readFileSync, writeFileSync } from 'node:fs';
import { validate } from '@readme/openapi-parser';
import { httpReferences, referenceMdx, loadReferenceSpec } from './http-api.mjs';

for (const reference of httpReferences) {
  const spec = loadReferenceSpec(reference);
  await validate(structuredClone(spec), { dereference: { circular: 'ignore' } });
  const markdown = referenceMdx(reference, spec);
  const target = new URL(`../../${reference.docSource}`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== markdown) throw new Error(`${reference.label} reference is stale; run npm --prefix website run gen:api`);
  } else writeFileSync(target, markdown);
}
console.log('generate-openapi-docs: canonical HTTP references are current');
