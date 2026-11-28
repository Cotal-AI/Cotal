import { compareVersions } from './upgrade-matrix-plan.mjs';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const builtins = new Set(['@cotal-ai/acp', '@cotal-ai/linear', '@cotal-ai/web']);

/** Checkout and unstamped snapshot proofs already run contract 1. */
export function hasPluginContract(version, checkout = false) {
  if (checkout || /^0\.0\.0(?:[-+]|$)/.test(version)) return true;
  // Candidate-next and the desktop setup proof add 1000 or 2000 to the patch.
  const base = version.replace(/^(\d+\.\d+\.)([12]\d{3})(?=[-+]|$)/, (_, prefix, patch) => `${prefix}${Number(patch) % 1000}`);
  return compareVersions(base, '0.184.0-0') >= 0;
}

/** A configured home records the default connectors plus operator-installed tmux. */
export function expectedRecorded(version, checkout = false) {
  if (version === 0 || version === 1) return version === 1 ? 7 : 8;
  return hasPluginContract(version, checkout) ? 7 : 8;
}

/** Use only the active package selected by the verified update route. */
export function activePluginContract(pkg, route) {
  const root = realpathSync.native(pkg);
  const active = route.updateRoute === 'staged'
    ? join(dirname(dirname(root)), '.cotal-generations', route.generationId, 'cotal-ai') : root;
  const manifest = JSON.parse(readFileSync(join(active, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'cotal-ai', 'unexpected active plugin contract package');
  assert.equal(manifest.version, route.selectedCliVersion, 'active plugin contract package version differs from route');
  return Object.hasOwn(manifest.dependencies ?? {}, '@cotal-ai/web') ? 1 : 0;
}

export function requirePluginContracts(report) {
  const contracts = report.contracts;
  assert(contracts && [0, 1].includes(contracts.source) && [0, 1].includes(contracts.target), 'source and target plugin contracts required');
  return contracts;
}

export function retiredBuiltin(pkg, version, checkout = false) {
  if (version === 0 || version === 1) return version === 1 && builtins.has(pkg);
  return hasPluginContract(version, checkout) && builtins.has(pkg);
}

export function connectorInventory(output, version, cliVersion = version) {
  const names = ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi'];
  if (!hasPluginContract(version) && !hasPluginContract(cliVersion)) names.push('web, web-service');
  return names.every(name => output.split('\n').some(line => line.trimStart().startsWith(name) && line.trimEnd().endsWith(version)));
}
