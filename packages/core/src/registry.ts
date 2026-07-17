import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A typed registry of extensions, keyed by `kind:name`. Implementations
 * **self-register** their extensions (connectors, commands …) as a side-effect of
 * import; composition roots just import the packages they want and then resolve.
 *
 * Core stays ignorant of which extensions exist: they plug into the registry, not
 * the other way round. An unknown extension throws; no silent fallback.
 *
 * Materializing an installed package must be TRANSACTIONAL and INVISIBLE: a package that registers a
 * key and then throws (a rejected top-level await) must leave NO resolvable keys, and a package that
 * imports cleanly but never advertises the requested key must leave NONE of its registrations live.
 * {@link runStaged} scopes an import's registrations to a per-import stage via `AsyncLocalStorage`:
 * they are invisible to {@link resolve}/{@link all} until {@link commitStaged} publishes them
 * atomically. Registrations made in OTHER async contexts during the import's awaits go straight to
 * live and are never captured (so a rollback never discards an unrelated registration).
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

export class Registry {
  #byKey = new Map<string, Extension>();
  /** While a stage is active in the CURRENT async context, {@link register} writes there instead of
   *  the live map (invisible to resolve/all until commit). `AsyncLocalStorage` propagates the stage
   *  through the import's awaits but NOT into unrelated concurrent async work. */
  #stage = new AsyncLocalStorage<Map<string, Extension>>();

  /** Register one or more extensions, all-or-nothing. A duplicate `kind:name` (already live, already
   *  staged, or repeated within this call) throws BEFORE any of the batch is applied. During a
   *  {@link runStaged} import the batch lands in the per-import stage (invisible); otherwise it lands
   *  live. */
  register(...exts: Extension[]): void {
    const stage = this.#stage.getStore();
    const keys = exts.map((ext) => `${ext.kind}:${ext.name}`);
    const seen = new Set<string>();
    for (const key of keys) {
      if (this.#byKey.has(key) || (stage?.has(key) ?? false) || seen.has(key)) throw new Error(`extension already registered: ${key}`);
      seen.add(key);
    }
    const target = stage ?? this.#byKey;
    exts.forEach((ext, i) => target.set(keys[i], ext));
  }

  /** Remove one extension by kind + name; returns whether it was registered. Generic teardown; it
   *  knows nothing about what a kind means. */
  unregister(kind: string, name: string): boolean {
    return this.#byKey.delete(`${kind}:${name}`);
  }

  /**
   * Run `load` (typically a self-registering `import()`) with the registrations it makes STAGED
   * (invisible to {@link resolve}/{@link all}) and return them for the caller to validate against the
   * manifest-advertised keys, then {@link commitStaged}. A throw/rejection propagates and the stage is
   * DISCARDED: those registrations never touched the live registry, and no unrelated live registration
   * is affected. Callers still SERIALIZE loads so two imports never share a validation window.
   */
  async runStaged<T>(load: () => Promise<T>): Promise<{ value: T; staged: Extension[] }> {
    const stage = new Map<string, Extension>();
    const value = await this.#stage.run(stage, load);
    return { value, staged: [...stage.values()] };
  }

  /** Publish previously-staged registrations to the live registry, atomically (all-or-nothing,
   *  re-checked against the live map, which may have changed since staging). */
  commitStaged(staged: readonly Extension[]): void {
    const keys = staged.map((ext) => `${ext.kind}:${ext.name}`);
    for (const key of keys) if (this.#byKey.has(key)) throw new Error(`extension already registered: ${key}`);
    staged.forEach((ext, i) => this.#byKey.set(keys[i], ext));
  }

  /** Whether a committed extension exists for kind + name (staged registrations are invisible here,
   *  like {@link resolve}). A boolean probe that never throws. */
  has(kind: string, name: string): boolean {
    return this.#byKey.has(`${kind}:${name}`);
  }

  /** Resolve one extension by kind + name. Unknown throws. Staged (uncommitted) registrations are
   *  invisible here; only committed ones resolve. */
  resolve<T extends Extension>(kind: T["kind"], name: string): T {
    const ext = this.#byKey.get(`${kind}:${name}`);
    if (!ext) throw new Error(`no ${kind} registered for "${name}"`);
    return ext as T;
  }

  /** Every registered (committed) extension, optionally narrowed to one kind. */
  all(): Extension[];
  all<T extends Extension>(kind: T["kind"]): T[];
  all<T extends Extension>(kind?: T["kind"]): T[] {
    const values = [...this.#byKey.values()];
    return (kind === undefined ? values : values.filter((e) => e.kind === kind)) as T[];
  }
}

/** The process-wide registry. Implementations self-register into it on import. */
export const registry = new Registry();
