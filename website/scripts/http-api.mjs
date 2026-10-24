import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { httpReferences } from '../src/http-references.js';
export { httpReferences };
const repoRoot = new URL('../../', import.meta.url);
const wireUrl = new URL('../../spec/cotal.schema.json', import.meta.url);

// Keep the normative definitions in their own source. Localizing their references
// produces a portable download and avoids resolving repository paths on the site.
export function loadReferenceSpec(reference) {
  const sourceUrl = new URL(reference.source, repoRoot);
  let usesWire = false;
  const spec = JSON.parse(readFileSync(sourceUrl, 'utf8'));
  const wire = JSON.parse(readFileSync(wireUrl, 'utf8'));
  const rewrite = (value, prefix) => {
    if (Array.isArray(value)) return value.map((entry) => rewrite(entry, prefix));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === '$ref' && entry.startsWith(prefix)) {
        usesWire = true;
        const name = entry.slice(prefix.length);
        assert(Object.hasOwn(wire.definitions, name), `Unknown wire schema: ${name}`);
        return [key, `#/components/schemas/Wire${name}`];
      }
      return [key, rewrite(entry, prefix)];
    }));
  };
  const result = rewrite(spec, '../../spec/cotal.schema.json#/definitions/');
  for (const [name, definition] of Object.entries(usesWire ? wire.definitions : {})) {
    assert(!Object.hasOwn(result.components.schemas, `Wire${name}`), `Duplicate schema: Wire${name}`);
    result.components.schemas[`Wire${name}`] = rewrite(definition, '#/definitions/');
  }
  return result;
}

export function referenceOperations(spec) {
  const ids = new Set();
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item).filter(([method]) => methods.has(method)).map(([method, operation]) => {
      assert(/^[a-z]+(?:-[a-z]+)*$/.test(operation.operationId), `Use a lowercase operation ID: ${path}`);
      assert(!ids.has(operation.operationId), `Duplicate operation ID: ${operation.operationId}`);
      ids.add(operation.operationId);
      return { path, method: method.toUpperCase(), ...operation,
        parameters: [...(item.parameters ?? []), ...(operation.parameters ?? [])] };
    }));
}

const fence = (value) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';
const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const rawSpecLink = (reference) => `https://docs.cotal.ai/${reference.specFile}`;

function operationMarkdown(spec, operation) {
  const lines = [`## ${operation.summary}`, '', `\`${operation.method} ${operation.path}\``, '', operation.description, '',
    '### Parameters', ''];
  if (operation.parameters?.length) {
    lines.push('| Name | Location | Required | Schema |', '|---|---|---|---|');
    for (const parameter of operation.parameters) {
      lines.push(`| ${cell(parameter.name)} | ${parameter.in} | ${parameter.required ? 'yes' : 'no'} | \`${cell(JSON.stringify(parameter.schema))}\` |`);
    }
    for (const parameter of operation.parameters) {
      if (parameter.description) lines.push('', `**${parameter.name}:** ${parameter.description}`, '');
    }
  } else lines.push('No operation parameters.');
  if (operation.requestBody) {
    const body = operation.requestBody.$ref ? spec.components.requestBodies[operation.requestBody.$ref.split('/').at(-1)] : operation.requestBody;
    lines.push('', '### Request body', '', body.description ?? 'The request uses the schema below.', '',
      `Required: ${body.required ? 'yes' : 'no'}.`, '');
    for (const [type, content] of Object.entries(body.content)) {
      lines.push(`Content type: \`${type}\`.`, '', fence(content.schema), '');
      if (content.example !== undefined) lines.push('Example:', '', fence(content.example), '');
    }
  }
  lines.push('', '### Responses', '');
  for (const [status, entry] of Object.entries(operation.responses)) {
    const response = entry.$ref ? spec.components.responses[entry.$ref.split('/').at(-1)] : entry;
    assert(response, `Missing response: ${entry.$ref}`);
    lines.push(`#### HTTP ${status}`, '', response.description, '');
    for (const [name, header] of Object.entries(response.headers ?? {})) {
      lines.push(`\`${name}\`: ${header.description ?? JSON.stringify(header.schema)}`, '');
    }
    for (const [type, content] of Object.entries(response.content ?? {})) {
      lines.push(`Content type: \`${type}\`.`, '', fence(content.schema), '');
      if (content.example !== undefined) lines.push('Example:', '', typeof content.example === 'string' ? '```text\n' + content.example + '```' : fence(content.example), '');
    }
  }
  if (operation['x-sse-events']) {
    lines.push('### Event payloads', '', 'Each named event carries the following JSON data schema.', '', fence(operation['x-sse-events']), '');
  }
  return lines.join('\n').trim();
}

export function referenceMarkdown(reference, spec) {
  const operations = referenceOperations(spec);
  return [`# ${spec.info.title}`, '', `> **Reference** (informative) · **For:** HTTP client authors · **Source:** [OpenAPI description](../${reference.source})`, '',
    `<!-- Generated by website/scripts/generate-openapi-docs.mjs. Edit ${reference.source}. -->`, '',
    spec.info.description, '', '## Reading the contract', '',
    `The [interactive reference](https://docs.cotal.ai/${reference.base}/) and [downloadable OpenAPI specification](${rawSpecLink(reference)}) describe the same operations.`, '',
    'Schema references in the sections below resolve inside the downloadable specification.', '',
    'See [API reference](api-reference.md) for the other integration interfaces.', '',
    ...operations.flatMap((operation) => [operationMarkdown(spec, operation), '']),
    '## Schemas', '',
    'These schemas describe the HTTP request and response wrappers. The downloadable specification includes the referenced definitions.', '',
    ...Object.entries(spec.components.schemas).filter(([name]) => !name.startsWith('Wire')).flatMap(([name, schema]) => [`### ${name}`, '', fence(schema), '']),
  ].join('\n').trim() + '\n';
}

export function referencePages(reference, spec) {
  const intro = `# ${spec.info.title}\n\n${spec.info.description}\n\n[OpenAPI specification](${rawSpecLink(reference)})\n\n`;
  const pages = [{ slug: reference.base, markdown: intro + referenceOperations(spec).map((operation) =>
    `- [${operation.summary}](/${reference.base}/operations/${operation.operationId}.md): \`${operation.method} ${operation.path}\``).join('\n') + '\n' }];
  for (const operation of referenceOperations(spec)) {
    pages.push({ slug: `${reference.base}/operations/${operation.operationId}`,
      markdown: `# ${operation.summary}\n\n${operationMarkdown(spec, operation).replace(/^## [^\n]+\n\n/, '')}\n\n` +
        `Authentication and access: ${spec.info.description}\n\n` +
        `[OpenAPI specification](${rawSpecLink(reference)}) contains the referenced response schemas. [Complete Markdown reference](/${reference.base}.md).\n` });
  }
  return pages;
}
