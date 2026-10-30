/** Per-recipient coverage of acknowledged publish IDs. Repeated durable copies are allowed. */
export function deliveryCoverage(expectedIds: readonly string[], received: ReadonlyMap<string, number>) {
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length) throw new Error("publish IDs must be unique");
  let missing = 0, unexpected = 0, repeated = 0;
  for (const id of expected) if (!received.has(id)) missing++;
  for (const [id, count] of received) {
    if (!expected.has(id)) unexpected += count;
    repeated += count - 1;
  }
  return { expected: expected.size, distinct: received.size, missing, unexpected, repeated };
}
