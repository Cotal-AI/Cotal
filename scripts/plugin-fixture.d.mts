// Generated from plugin-fixture.mjs by gen-ci-suites-dts.mts. Do not edit: run `pnpm gen:ci-suites-dts`.
// The .mjs module is the only source of truth; `pnpm smoke:ci-declarations` fails if this drifts.

/**
 * Write a fixture without resolving any build output. Contract 0 accepts a legacy module body
 * for installs performed by a pre-cut release. Contract 1 expects a default host factory.
 * @param {string} dir
 * @param {PluginFixtureOptions} options
 * @returns {void}
 */
export function writePluginFixture(dir: string, { name, version, provides, factorySource, core, contract, entry, packageFields }: PluginFixtureOptions): void;
export type FixtureProvider = {
    kind: string;
    name: string;
    aliases?: readonly string[];
    requires?: readonly string[];
    eventChannel?: unknown;
    prompts?: boolean;
    supportsAskPermissions?: boolean;
    supportsReasoningEvents?: boolean;
    setup?: {
        kind: string;
        name: string;
    } | null;
    [key: string]: unknown;
};
export type PluginFixtureOptions = {
    name: string;
    version: string;
    provides: readonly FixtureProvider[];
    factorySource: string;
    core?: string;
    contract?: 0 | 1;
    entry?: string;
    packageFields?: Record<string, unknown>;
};
