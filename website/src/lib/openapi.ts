import { join } from 'node:path';
import { createOpenAPI, type OpenAPIPageProps_Spec } from 'fumadocs-openapi/server';
import type { OperationItem } from 'fumadocs-openapi';
import { httpReferences } from '../http-references.js';

export type HttpOperation = OperationItem & {
  document: string;
  overviewUrl: string;
  sidebarTitle: string;
  eventPayloads?: string;
};

const openapi = createOpenAPI({
  input: Object.fromEntries(httpReferences.map(reference => [
    reference.id,
    join(process.cwd(), 'src/generated', reference.specFile),
  ])),
});

export async function getHttpOperationProps(operation: HttpOperation): Promise<OpenAPIPageProps_Spec> {
  const { bundled } = await openapi.getSchema(operation.document);
  return {
    document: operation.document,
    payload: { bundled },
    operations: [{ path: operation.path, method: operation.method }],
    showTitle: false,
    showDescription: true,
  };
}
