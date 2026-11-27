const brands = new WeakMap<Function, symbol>();
const ordinaryInstanceOf = Function.prototype[Symbol.hasInstance];

function brandedInstanceOf(this: Function, value: unknown): boolean {
  if (ordinaryInstanceOf.call(this, value)) return true;
  const brand = brands.get(this);
  return brand !== undefined && typeof value === "object" && value !== null && Reflect.get(value, brand) === true;
}

/** Preserve error identity across the host's and a plugin's core copies. */
export function brandCoreError(constructor: Function & { prototype: Error }, name: string): void {
  const brand = Symbol.for(`@cotal-ai/core/error/${name}`);
  brands.set(constructor, brand);
  Object.defineProperty(constructor.prototype, brand, { value: true });
  Object.defineProperty(constructor, Symbol.hasInstance, { value: brandedInstanceOf });
}
