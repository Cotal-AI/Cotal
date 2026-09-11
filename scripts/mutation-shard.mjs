/**
 * Deterministic fixture-path assignment shared by mutation reproof and its corpus partition control.
 * Keep this independent of fixture contents so changing or adding one fixture cannot move another.
 *
 * @param {string} path
 * @param {number} count
 * @returns {number}
 */
export function mutationShard(path, count) {
  let hash = 0;
  for (const byte of Buffer.from(path)) hash = (hash * 31 + byte) >>> 0;
  return hash % count;
}
