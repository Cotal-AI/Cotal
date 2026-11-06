import { readFileSync, writeFileSync } from 'node:fs';
import { validate } from '@readme/openapi-parser';
import { httpReferences, referenceMdx, loadReferenceSpec, assertReferenceCurrent } from './http-api.mjs';
import { assertMeshCommandsCurrent, loadMeshSurface, meshCommandMdx, meshCommandPage } from './mesh-commands.mjs';

for (const reference of httpReferences) {
  const spec = loadReferenceSpec(reference);
  await validate(structuredClone(spec), { dereference: { circular: 'ignore' } });
  const target = new URL(`../../${reference.docSource}`, import.meta.url);
  if (process.argv.includes('--check')) assertReferenceCurrent(reference, spec);
  else writeFileSync(target, referenceMdx(reference, spec));
}

const surface = await loadMeshSurface();
const meshTarget = new URL(`../../${meshCommandPage}`, import.meta.url);
if (process.argv.includes('--check')) assertMeshCommandsCurrent(surface, readFileSync(meshTarget, 'utf8'));
else writeFileSync(meshTarget, meshCommandMdx(surface));
console.log('generate-openapi-docs: canonical HTTP references and mesh command catalog are current');
