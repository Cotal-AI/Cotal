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
  /** Other names that resolve to this extension within its kind. A name or alias already claimed in
   *  the kind is refused at registration, so resolution never depends on load order. */
  readonly aliases?: readonly string[];
}

/** A registry key used by commands that need an operator-installed provider before they run. */
export interface ExtensionRef {
  readonly kind: string;
  readonly name: string;
}

/** Every `kind:word` key an extension claims: its name, then its aliases. */
function claims(ext: Extension): string[] {
  return [ext.name, ...(ext.aliases ?? [])].map((word) => `${ext.kind}:${word}`);
}

export class Registry {
  #byKey = new Map<string, Extension>();
  /** `kind:alias` → the claiming extension's `kind:name` key, for committed extensions. */
  #aliases = new Map<string, string>();
  /** While a stage is active in the CURRENT async context, {@link register} writes there instead of
   *  the live map (invisible to resolve/all until commit). `AsyncLocalStorage` propagates the stage
   *  through the import's awaits but NOT into unrelated concurrent async work. */
  #stage = new AsyncLocalStorage<Map<string, Extension>>();

  /** Register one or more extensions, all-or-nothing. A `kind:name` or `kind:alias` already claimed
   *  by a name or alias (live, staged, or earlier in this call) throws BEFORE any of the batch is
   *  applied. During a
   *  {@link runStaged} import the batch lands in the per-import stage (invisible); otherwise it lands
   *  live. */
  register(...exts: Extension[]): void {
    const stage = this.#stage.getStore();
    const taken = this.#claimed();
    for (const staged of stage?.values() ?? []) for (const key of claims(staged)) taken.add(key);
    for (const ext of exts) {
      for (const key of claims(ext)) {
        if (taken.has(key)) throw new Error(`extension already registered: ${key}`);
        taken.add(key);
      }
    }
    if (stage) for (const ext of exts) stage.set(`${ext.kind}:${ext.name}`, ext);
    else this.#publish(exts);
  }

  /** Every committed name and alias key. */
  #claimed(): Set<string> {
    return new Set([...this.#byKey.keys(), ...this.#aliases.keys()]);
  }

  #publish(exts: readonly Extension[]): void {
    for (const ext of exts) {
      const key = `${ext.kind}:${ext.name}`;
      this.#byKey.set(key, ext);
      for (const alias of claims(ext).slice(1)) this.#aliases.set(alias, key);
    }
  }

  /** Remove one extension by kind + name; returns whether it was registered. Generic teardown; it
   *  knows nothing about what a kind means. */
  unregister(kind: string, name: string): boolean {
    const key = `${kind}:${name}`;
    const ext = this.#byKey.get(key);
    if (!ext) return false;
    for (const alias of claims(ext).slice(1)) this.#aliases.delete(alias);
    return this.#byKey.delete(key);
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
    const taken = this.#claimed();
    for (const ext of staged) for (const key of claims(ext)) if (taken.has(key)) throw new Error(`extension already registered: ${key}`);
    this.#publish(staged);
  }

  /** Whether a committed extension exists for kind + name or alias (staged registrations are invisible here,
   *  like {@link resolve}). A boolean probe that never throws. */
  has(kind: string, name: string): boolean {
    return this.#byKey.has(this.#canonical(kind, name));
  }

  /** The `kind:name` key a name or alias resolves to. */
  #canonical(kind: string, word: string): string {
    const key = `${kind}:${word}`;
    return this.#aliases.get(key) ?? key;
  }

  /** Resolve one extension by kind + name or alias. Unknown throws. Staged (uncommitted) registrations are
   *  invisible here; only committed ones resolve. */
  resolve<T extends Extension>(kind: T["kind"], name: string): T {
    const ext = this.#byKey.get(this.#canonical(kind, name));
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
