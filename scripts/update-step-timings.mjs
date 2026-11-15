const phases = new Map([
  ['release archives checked', 'release-checks'],
  ['recovery snapshot saved', 'recovery-snapshot'],
  ['global package install finished', 'global-install'],
  ['installed reconciliation finished', 'installed-reconcile'],
  ['connector integrations refreshed', 'connector-integrations'],
]);
export function updateStepTimings(output) {
  const steps = [];
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  for (const match of plain.matchAll(/^✓ (.+) \((\d+\.\d) s\)\r?$/gm)) {
    let step = phases.get(match[1]);
    if (!step) {
      const item = /^(built-in|integration|extension) ([a-z0-9@/._-]+) (?:reconciled|refreshed|install finished)$/.exec(match[1]);
      if (!item) continue;
      step = `${item[1] === 'built-in' ? 'connector' : item[1]}:${item[2]}`;
    }
    const elapsedMs = Math.round(Number(match[2]) * 1000);
    if (!Number.isSafeInteger(elapsedMs)) throw new Error('update step duration exceeds safe integer range');
    steps.push({ step, elapsedMs });
  }
  return steps;
}
