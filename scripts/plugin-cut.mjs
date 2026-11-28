import { compareVersions } from './upgrade-matrix-plan.mjs';

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
  return hasPluginContract(version, checkout) ? 7 : 8;
}

export function retiredBuiltin(pkg, version, checkout = false) {
  return hasPluginContract(version, checkout) && builtins.has(pkg);
}

export function connectorInventory(output, version, cliVersion = version) {
  const names = ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi'];
  if (!hasPluginContract(version) && !hasPluginContract(cliVersion)) names.push('web, web-service');
  return names.every(name => output.split('\n').some(line => line.trimStart().startsWith(name) && line.trimEnd().endsWith(version)));
}
