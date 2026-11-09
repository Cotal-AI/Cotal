// Like gen:tooldocs, read the service's own contract data through tsx after building dependencies.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { markdownToMdx } from '@cotal-ai/docs-content/generate';
import { contractDigest, parseClosureManifest, singleDocumentClosure, registryClusterDocument, registryContractArtifactValues } from '../packages/core/dist/index.js';
import { managerClusterDocument, managerContractArtifactValues } from '../implementations/manager/src/manager-service-contract.ts';
import { authClusterDocument, authContractArtifactValues } from '../implementations/auth/src/auth-service-contract.ts';

const sources = [
  ['manager', managerClusterDocument(), managerContractArtifactValues()],
  ['auth', authClusterDocument(), authContractArtifactValues()],
  ['registry', registryClusterDocument(), registryContractArtifactValues()],
];
const json = value => '```json\n' + JSON.stringify(value, null, 2) + '\n```';
const lines = [
  'This catalog is generated from the built-in Manager, auth and registry cluster contracts in this source revision. It lists every command those three contracts declare, with its complete input and output JSON schemas. Dynamic extension endpoints, including MCP bridges, are discovered from their running service. Reserved protocol verbs such as `describe` are defined in [SPEC §13](../SPEC.md#13-endpoint-control-surface-v04), not in these cluster tables.',
  '',
  '## Discover before calling',
  '',
  'A published catalog does not establish that a service is running or that a caller has authority. Resolve the live endpoint before invoking it; [discovery](control-discovery.mdx#service-discovery) verifies the registered contract digests. Installed versions may differ from this page. Capability names classify commands; they are not grants. Target modes and instance routing remain enforced by the broker and service.',
  '',
  'For an already authorized space, these examples inspect the Manager and make a read-only status call. Choose the Manager instance explicitly where required by your deployment. They do not create a grant or start a service.',
  '',
  '```sh\ncotal describe manager --space <space> --on <instance>\ncotal invoke manager status --args \'null\' --space <space> --on <instance>\n```',
  '',
  'The [CLI endpoint reference](cli-endpoints.mdx) explains discovery, target selection and invocation. Agent sessions use `cotal_describe` followed by `cotal_invoke`; see the [tool catalog](mcp-tools.mdx). Do not substitute an identity field in command arguments for the authenticated target.',
  '',
  '## Request failures',
  '',
  'The output schemas below describe successful command results, not the protocol error envelope. Input validation refuses before publication. A received `error.outcome` of `not-executed` proves the command did not run; an unknown or absent outcome does not. Check the affected state before repeating a mutation. Commands may also return domain refusal states inside a successful result, as their output schema specifies. See [request outcomes](control-discovery.mdx#request-outcomes) and [SPEC §13](../SPEC.md#13-endpoint-control-surface-v04) for errors, deadlines and retry rules. The cluster documents do not declare an exhaustive per-command error-code list.',
  '',
];
let count = 0;
for (const [endpoint, document, values] of sources) {
  const artifacts = new Map(values.map(value => [contractDigest(value), value]));
  const schema = digest => {
    assert(artifacts.has(digest), `missing schema closure: ${digest}`);
    const manifest = parseClosureManifest(artifacts.get(digest));
    assert.equal(manifest.members.length, 0, 'catalog requires self-contained built-in schemas');
    assert(artifacts.has(manifest.root), `missing schema root: ${manifest.root}`);
    const root = artifacts.get(manifest.root);
    assert.equal(singleDocumentClosure(root).closureDigest, digest);
    return root;
  };
  lines.push(`## ${endpoint}`, '', `Cluster \`${document.urn}\`, revision ${document.revision}. ${document.commands.length} commands.`, '', '| Command | Capability | Class | Target modes |', '|---|---|---|---|');
  for (const command of document.commands)
    lines.push(`| [\`${command.name}\`](#${endpoint}-${command.name}) | \`${command.capability}\` | ${command.class} | ${command.targeted ? command.modes.join(', ') : 'untargeted'} |`);
  lines.push('');
  for (const command of document.commands) {
    lines.push(`### ${endpoint} ${command.name}`, '', 'Registered declaration:', '', json(command), '', 'Input schema:', '', json(schema(command.inputDigest)), '', 'Output schema:', '', json(schema(command.outputDigest)), '');
    count++;
  }
}
lines.push('## Regeneration', '', 'Run `pnpm gen:meshdocs` from the repository root. The generator reads the service contract modules and verifies each schema closure against its declared digest. `pnpm check:meshdocs` checks the generated entries and schemas against those contracts without writing the page. The docs-bundle check also detects stale generated bytes.', '');
const metadata = '---\ntitle: Mesh command catalog\ndescription: Built-in endpoint command declarations, capabilities, targeting modes and JSON schemas.\nkind: "Reference (informative)"\naudience: developers integrating with Cotal\n---\n\n';
writeFileSync(new URL('../docs/mesh-commands.mdx', import.meta.url), metadata + markdownToMdx(lines.join('\n')));
console.log(`gen:meshdocs: ${sources.length} endpoints, ${count} commands`);
