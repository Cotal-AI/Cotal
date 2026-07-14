/**
 * A typed registry of extensions, keyed by `kind:name`. Implementations
 * **self-register** their extensions (connectors, commands …) as a side-effect of
 * import; composition roots just import the packages they want and then resolve.
 *
 * Core stays ignorant of which extensions exist: they plug into the registry, not
 * the other way round. An unknown extension throws — no silent fallback.
 */
export interface Extension {
  readonly kind: string;
  readonly name: string;
}

/** A registry key used by commands that need an operator-installed provider before they run. */
export interface ExtensionRef {
  readonly kind: string;
  readonly name: string;
}

/** An opaque restore point captured by {@link Registry.snapshot}. */
export type RegistrySnapshot = ReadonlyMap<string, Extension>;

export class Registry {
  #byKey = new Map<string, Extension>();

  /** Register one or more extensions, all-or-nothing. A duplicate `kind:name` (already present, or
   *  repeated within this call) throws BEFORE any of the batch is applied, so a rejected multi-key
   *  registration never leaves half of it resolvable. */
  register(...exts: Extension[]): void {
    const keys = exts.map((ext) => `${ext.kind}:${ext.name}`);
    const seen = new Set<string>();
    for (const key of keys) {
      if (this.#byKey.has(key) || seen.has(key)) throw new Error(`extension already registered: ${key}`);
      seen.add(key);
    }
    exts.forEach((ext, i) => this.#byKey.set(keys[i], ext));
  }

  /** Remove one extension by kind + name; returns whether it was registered. Generic teardown — it
   *  knows nothing about what a kind means. */
  unregister(kind: string, name: string): boolean {
    return this.#byKey.delete(`${kind}:${name}`);
  }

  /** Capture the current registration set as a restore point (a copy — later mutation is invisible
   *  to it). Pair with {@link restore} to make a self-registering `import()` transactional. */
  snapshot(): RegistrySnapshot {
    return new Map(this.#byKey);
  }

  /** Roll the registry back to a snapshot: it becomes exactly what it was at capture. Callers MUST
   *  serialize loads (single-flight) so a rollback never discards a concurrent load's registrations. */
  restore(snap: RegistrySnapshot): void {
    this.#byKey = new Map(snap);
  }

  /** Resolve one extension by kind + name. Unknown throws. */
  resolve<T extends Extension>(kind: T["kind"], name: string): T {
    const ext = this.#byKey.get(`${kind}:${name}`);
    if (!ext) throw new Error(`no ${kind} registered for "${name}"`);
    return ext as T;
  }

  /** Every registered extension, optionally narrowed to one kind. */
  all(): Extension[];
  all<T extends Extension>(kind: T["kind"]): T[];
  all<T extends Extension>(kind?: T["kind"]): T[] {
    const values = [...this.#byKey.values()];
    return (kind === undefined ? values : values.filter((e) => e.kind === kind)) as T[];
  }
}

/** The process-wide registry. Implementations self-register into it on import. */
export const registry = new Registry();
