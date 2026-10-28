/** A comma-list flag as spawn, mint and both persona commands read it.
 *
 *  An absent flag returns `undefined`, and the caller defers to the persona or its own default. A
 *  present value, `""` and `","` included, splits on commas, trims each entry and drops the blank
 *  ones. An explicit empty override is the empty list. */
export function commaList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(",").map((item) => item.trim()).filter(Boolean);
}
