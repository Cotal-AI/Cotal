// @ts-check
/** Compare the frozen legacy order, not only the derived shard number. */
/** @param {string[]} base @param {string[]} head @returns {{ changed: string[], examined: number }} */
export function changedSuiteIndices(base, head) {
  const headIndices = new Map(head.map((suite, index) => [suite, index]));
  /** @type {string[]} */
  const changed = [];
  let examined = 0;
  base.forEach((suite, baseIndex) => {
    const headIndex = headIndices.get(suite);
    if (headIndex === undefined) return;
    examined++;
    if (headIndex !== baseIndex) changed.push(suite);
  });
  return { changed, examined };
}
