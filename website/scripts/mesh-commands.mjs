import { markdownToMdx } from '@cotal-ai/docs-content/generate';

const repoRoot = new URL('../../', import.meta.url);

/** Built-in endpoints whose cluster documents are the shipped command surface. */
export const meshEndpoints = [
  {
    id: 'manager',
    label: 'Manager',
    endpoint: 'manager',
    urn: 'ai.cotal.manager',
    module: 'implementations/manager/dist/manager-service-contract.js',
    document: 'managerClusterDocument',
    artifacts: 'managerContractArtifactValues',
    source: 'implementations/manager/src/manager-service-contract.ts',
  },
  {
    id: 'auth',
    label: 'Auth',
    endpoint: 'auth',
    urn: 'ai.cotal.auth',
    module: 'implementations/auth/dist/auth-service-contract.js',
    document: 'authClusterDocument',
    artifacts: 'authContractArtifactValues',
    source: 'implementations/auth/src/auth-service-contract.ts',
  },
];

export const meshCommandPage = 'docs/mesh-commands.mdx';

const fence = (value) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

function assertDocument(endpoint, document) {
  if (document?.urn !== endpoint.urn) throw new Error(`${endpoint.id} cluster URN is ${document?.urn}, expected ${endpoint.urn}`);
  if (!Number.isInteger(document.revision) || document.revision < 1) throw new Error(`${endpoint.id} cluster revision is not a positive integer`);
  if (!Array.isArray(document.commands) || document.commands.length === 0) throw new Error(`${endpoint.id} cluster document has no commands`);
  const names = new Set();
  for (const command of document.commands) {
    if (typeof command.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(command.name)) throw new Error(`${endpoint.id} command name is not a token: ${command.name}`);
    if (names.has(command.name)) throw new Error(`${endpoint.id} declares ${command.name} twice`);
    names.add(command.name);
    if (command.class !== 'ephemeral' && command.class !== 'journal') throw new Error(`${command.name} class is not ephemeral or journal`);
    if (typeof command.targeted !== 'boolean') throw new Error(`${command.name} does not declare targeting`);
    if (command.targeted) {
      if (!Array.isArray(command.modes) || command.modes.length === 0) throw new Error(`${command.name} is targeted without authorization modes`);
    } else if (command.modes !== undefined) {
      throw new Error(`${command.name} is untargeted and still declares authorization modes`);
    }
    if (typeof command.capability !== 'string' || command.capability.length === 0) throw new Error(`${command.name} has no capability`);
    if (typeof command.inputDigest !== 'string' || typeof command.outputDigest !== 'string') throw new Error(`${command.name} is missing a schema digest`);
  }
}

/** Schema roots from the published contract artifacts, keyed by the closure digest the cluster document names. */
async function schemaRoots(loaded, endpoint) {
  const closure = await import(new URL('packages/core/dist/schema-profile.js', repoRoot).href);
  const values = loaded[endpoint.artifacts]();
  if (!Array.isArray(values) || values.length === 0 || values.length % 2 !== 0) throw new Error(`${endpoint.id} artifact table is not root, manifest pairs`);
  const roots = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const root = values[index];
    const manifest = values[index + 1];
    const closed = closure.singleDocumentClosure(root);
    if (manifest?.v !== 1 || manifest.root !== closed.manifest.root || !Array.isArray(manifest.members)) {
      throw new Error(`${endpoint.id} artifact pair does not name its schema root`);
    }
    roots.set(closed.closureDigest, root);
  }
  return roots;
}

/** The shipped command surface, read from the built cluster documents. */
export async function loadMeshSurface() {
  const surface = [];
  for (const endpoint of meshEndpoints) {
    const loaded = await import(new URL(endpoint.module, repoRoot).href);
    const document = loaded[endpoint.document]();
    assertDocument(endpoint, document);
    const schemas = await schemaRoots(loaded, endpoint);
    for (const command of document.commands) {
      if (!schemas.has(command.inputDigest) || !schemas.has(command.outputDigest)) {
        throw new Error(`${command.name} schema digest is not a published contract artifact`);
      }
    }
    surface.push({ ...endpoint, document, schemas });
  }
  return surface;
}

function commandMarkdown(endpoint, command, schemas) {
  const input = schemas.get(command.inputDigest);
  const output = schemas.get(command.outputDigest);
  const admission = command.targeted ? `targeted, modes ${command.modes.join(', ')}` : 'untargeted';
  return [
    `## ${endpoint.endpoint} ${command.name}`,
    '',
    `The \`${command.name}\` command is in the \`${command.capability}\` capability class and is ${admission}.`,
    '',
    `It is served by endpoint \`${endpoint.endpoint}\` on cluster \`${endpoint.urn}\` revision ${endpoint.document.revision}, contract class \`${command.class}\`.`,
    '',
    '### Input schema',
    '',
    fence(input),
    '',
    '### Output schema',
    '',
    fence(output),
    '',
  ].join('\n');
}

export function meshCommandMarkdown(surface) {
  const lines = [
    '# Mesh commands',
    '',
    'Built-in endpoint commands served by the manager and auth cluster documents. Each entry is generated from the built cluster document and the schema artifact that document names.',
    '',
    'Discovery on a running mesh is the authority for the commands an endpoint serves. This catalog covers the built-in endpoints whose contracts ship in the repository. An extension endpoint publishes its own contract through discovery, and a static build cannot list it.',
    '',
    'A caller learns the live contract with `cotal describe` and calls it with `cotal invoke`. The pages [Service discovery](control-discovery.mdx) and [Endpoint control](cli-endpoints.mdx) cover those commands. Holding a capability name in this catalog does not grant it.',
    '',
    '## Endpoints',
    '',
    '| Endpoint | Cluster | Revision | Commands |',
    '|---|---|---|---|',
    ...surface.map((endpoint) => `| \`${endpoint.endpoint}\` | \`${endpoint.urn}\` | ${endpoint.document.revision} | ${endpoint.document.commands.length} |`),
    '',
  ];
  lines.push('## Sources', '');
  for (const endpoint of surface) lines.push(`- ${endpoint.label}: [${endpoint.source}](../${endpoint.source}).`);
  lines.push('');
  for (const endpoint of surface) {
    for (const command of endpoint.document.commands) lines.push(commandMarkdown({ ...endpoint, document: endpoint.document }, command, endpoint.schemas));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function meshCommandMdx(surface) {
  const metadata = {
    title: 'Mesh commands',
    description: 'Built-in manager and auth endpoint commands, with capability class, targeting, and input and output schemas.',
    kind: 'Reference',
    audience: 'endpoint client authors',
  };
  const frontmatter = ['---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', ''].join('\n');
  const body = markdownToMdx(meshCommandMarkdown(surface).replace(/^# [^\n]+\n\n/, ''));
  return frontmatter + body;
}

export function assertMeshCommandsCurrent(surface, source) {
  if (source !== meshCommandMdx(surface)) throw new Error('mesh command reference is stale; run npm --prefix website run gen:api');
}
