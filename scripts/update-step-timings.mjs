export function updateStepTimings(output) {
  const steps = [];
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  for (const match of plain.matchAll(/^Update step ([a-z0-9:@/._-]+) completed in (\d+) ms\r?$/gm)) {
    const elapsedMs = Number(match[2]);
    if (!Number.isSafeInteger(elapsedMs)) throw new Error('update step duration exceeds safe integer range');
    steps.push({ step: match[1], elapsedMs });
  }
  return steps;
}
