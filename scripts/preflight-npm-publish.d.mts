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
 * for this release job's GitHub publisher (repository + workflow file). Other
 * publishers on the same package are ignored. Empty allowed-action lists on this
 * publisher are stage-only: npm's post-2026-09-03 default. HTTP 201 from the
 * OIDC exchange is not an input here.
 */
export function classifyDirectPublishPermission(body: any, identity?: {
    repository: string;
    workflowFilename: string;
}): "refused:malformed-trust" | "refused:no-trusted-publisher" | "refused:no-github-publisher" | "createPackage" | "stage-only";
export function printPublishCensus(rows: any, log?: {
    (...data: any[]): void;
    (message?: any, ...optionalParams: any[]): void;
}): void;
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
    state: string;
    rows: any[];
}>;
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
    state: string;
    rows: any[];
}>;
import { execFileSync } from "node:child_process";
