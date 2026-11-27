import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {{kind: string, name: string, aliases?: readonly string[], requires?: readonly string[], eventChannel?: unknown, prompts?: boolean, supportsAskPermissions?: boolean, supportsReasoningEvents?: boolean, setup?: {kind: string, name: string} | null, [key: string]: unknown}} FixtureProvider */
/** @typedef {{name: string, version: string, provides: readonly FixtureProvider[], factorySource: string, core?: string, contract?: 0 | 1, entry?: string, packageFields?: Record<string, unknown>}} PluginFixtureOptions */

const commandFields = ['name', 'summary', 'aliases', 'group', 'usage', 'hidden', 'flags', 'flagNames', 'positionals', 'subcommands', 'outputs', 'examples', 'reads'];
const processFields = ['kind', 'name', 'label', 'controllerOnly', 'service', 'order', 'pidFile', 'cooperativeStop', 'artifacts', 'stopLast', 'clearsMesh', 'visibleWhen'];

/**
 * Write a fixture without resolving any build output. Contract 0 accepts a legacy module body
 * for installs performed by a pre-cut release. Contract 1 expects a default host factory.
 * @param {string} dir
 * @param {PluginFixtureOptions} options
 * @returns {void}
 */
export function writePluginFixture(dir, { name, version, provides, factorySource, core, contract = 1, entry = 'index.js', packageFields }) {
  const manifest = { ...packageFields, name, version, type: 'module', main: entry };
  const commands = [], connectors = [], localProcesses = [];
  if (contract === 1) {
    for (const provider of provides) {
      switch (provider.kind) {
        case 'command': commands.push(pick(provider, commandFields)); break;
        case 'connector': connectors.push({
          name: provider.name,
          requires: [...(provider.requires ?? [])],
          eventPlane: provider.eventChannel !== undefined,
          prompts: provider.prompts === true,
          askPermissions: provider.supportsAskPermissions === true,
          reasoningEvents: provider.supportsReasoningEvents === true,
          setup: provider.setup ? pick(provider.setup, ['kind', 'name']) : null,
          ...('install' in provider ? { install: provider.install } : {}),
        }); break;
        case 'local-process': localProcesses.push(pick(provider, processFields)); break;
        case 'runtime': break;
        default: throw new Error(`Unsupported fixture provider kind: ${provider.kind}`);
      }
    }
  }
  const metadata = contract === 0 ? { peerDependencies: { '@cotal-ai/core': '*' } } : {
    cotal: {
      contract,
      ...(core === undefined ? {} : { core }),
      provides: provides.map(({ kind, name, aliases }) => ({ kind, name, aliases: [...(aliases ?? [])] })),
      commands, connectors, localProcesses, servicePresets: [],
    },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ ...metadata, ...manifest }, null, 2)}\n`);
  writeFileSync(join(dir, entry), factorySource);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} keys */
function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
