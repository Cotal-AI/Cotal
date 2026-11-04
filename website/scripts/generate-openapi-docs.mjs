import { writeFileSync } from 'node:fs';
import { validate } from '@readme/openapi-parser';
import { httpReferences, referenceMdx, loadReferenceSpec, assertReferenceCurrent } from './http-api.mjs';

for (const reference of httpReferences) {
  const spec = loadReferenceSpec(reference);
  await validate(structuredClone(spec), { dereference: { circular: 'ignore' } });
  const target = new URL(`../../${reference.docSource}`, import.meta.url);
  if (process.argv.includes('--check')) assertReferenceCurrent(reference, spec);
  else writeFileSync(target, referenceMdx(reference, spec));
}
console.log('generate-openapi-docs: canonical HTTP references are current');
