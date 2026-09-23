// Generated from preflight-npm-publish.mjs by gen-npm-publish-preflight-dts.mts. Do not edit:
// run `pnpm gen:npm-publish-preflight-dts`. The module is the only source of truth for these types;
// `pnpm smoke:npm-publish-preflight` fails if they drift.
export function assertGithubIdentity(claims: any, env: any): void;
export function workspacePackagesFromPnpm(root?: string, exec?: typeof execFileSync): {
    name: any;
    version: any;
    path: any;
}[];
export function validateReleaseSet(fixedPackages: any, workspacePackages: any): any[];
export function trustUrl(registryBase: any, name: any): string;
/**
 * Map a GET /-/package/<name>/trust body onto the direct-publish Allowed action
 * for this release job's GitHub publisher (repository + workflow file, including npm's
 * documented `claims` object). Other publishers on the same package are ignored. Empty
 * allowed-action lists on this
 * publisher are stage-only: npm's post-2026-09-03 default. HTTP 201 from the
 * OIDC exchange is not an input here.
 */
export function classifyDirectPublishPermission(body: any, identity?: {
    repository: string;
    workflowFilename: string;
    environment: string;
}): "refused:malformed-trust" | "refused:no-trusted-publisher" | "refused:no-github-publisher" | "createPackage" | "stage-only";
export function printPublishCensus(rows: any, log?: {
    (...data: any[]): void;
    (message?: any, ...optionalParams: any[]): void;
}): void;
/**
 * @typedef {(typeof NPM_PUBLISH_PREFLIGHT_STATES)[number]} NpmPublishPreflightState
 */
/**
 * @returns {Promise<{ state: NpmPublishPreflightState, rows: any[] }>}
 */
export function preflightNpmPublish({ fixedPackages, workspacePackages, registryBase, env, fetchImpl, log, }: {
    fixedPackages: any;
    workspacePackages: any;
    registryBase?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    log?: {
        (...data: any[]): void;
        (message?: any, ...optionalParams: any[]): void;
    };
}): Promise<{
    state: NpmPublishPreflightState;
    rows: any[];
}>;
/**
 * @returns {Promise<{ state: NpmPublishPreflightState, rows: any[] }>}
 */
export function preflightFromRepository({ root, registryBase, env, fetchImpl, log, exec, }?: {
    root?: string;
    registryBase?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    log?: {
        (...data: any[]): void;
        (message?: any, ...optionalParams: any[]): void;
    };
    exec?: typeof execFileSync;
}): Promise<{
    state: NpmPublishPreflightState;
    rows: any[];
}>;
export function isUnknownRegistry(registry: any): any;
export function isPresentRegistry(registry: any): boolean;
export function isAbsentRegistry(registry: any): boolean;
/**
 * The bucket predicates in ladder order, paired with the names the ladder and the census use.
 * Exported as one array so a caller enumerating the buckets cannot silently miss one that a
 * later commit adds: a new bucket is a new element here, not a new line in somebody's copy.
 */
export const CENSUS_BUCKETS: {
    name: string;
    matches: (registry: any) => any;
}[];
/**
 * The census verdict this preflight can return. Every other outcome throws, so these two
 * names are the complete contract a caller may branch on. Naming the union here is what puts
 * it in the generated declaration: an object-literal property widens to `string` on emit,
 * while a named type survives, so the published type stays as strict as the module.
 *
 * The members live in this exported CODE array rather than in a JSDoc union, so the contract
 * cannot be widened, narrowed or renamed by a commit that only edits prose. A comment-only
 * diff reads as documentation to a reviewer, which is exactly the diff that must not be able
 * to move a published type. `mutation-fixtures` refuses anchors that span comments for the
 * same reason, and its refusal is what showed the JSDoc-only form was disarmable.
 */
export const NPM_PUBLISH_PREFLIGHT_STATES: readonly ["nothing-to-publish", "ready"];
export type NpmPublishPreflightState = (typeof NPM_PUBLISH_PREFLIGHT_STATES)[number];
import { execFileSync } from "node:child_process";
