// Generated from post-publish-install-probe.mjs by tsc --emitDeclarationOnly. Do not edit.
/**
 * Read the version from a package directory's package.json.
 */
export function readVersion(pkgDir: any): any;
/**
 * Pack the cotal-ai package into a tarball and return its path.
 */
export function packPackage(pkgDir: any, outDir: any): string;
/**
 * Return every string target reachable from an exports value, including nested conditions.
 */
export function collectExportTargets(value: any): any;
/**
 * Pack one package and verify that its declared entry points are present in the tarball.
 */
export function verifyPackageTarball(pkgDir: any, outDir: any): {
    name: any;
    tarball: string;
    packedFiles: string[];
    missing: any[];
    pass: boolean;
};
/**
 * Extract a tarball. npm tarballs extract into a `package/` subdirectory.
 */
export function extractTarball(tarball: any, extractDir: any): string;
/**
 * Verify the bin entry exists in an extracted tarball. Returns { binName, binRel, binPath, exists }.
 */
export function verifyBinEntry(pkgDir: any): {
    binName: string;
    binRel: any;
    binPath: string;
    exists: boolean;
};
/**
 * Start a minimal HTTP server serving a single tarball as a fake npm registry.
 */
export function startFakeRegistry(tarballPath: any, packageName: any, version: any): Promise<{
    server: import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>;
    url: string;
    close: () => Promise<any>;
}>;
/**
 * Run a binary from an extracted tarball. The binary ENTRY code comes from the tarball; a symlink
 * to the workspace's node_modules is created in the package directory so ESM bare-specifier imports
 * resolve, matching what a real `npm install` would provide. Note the consequence: the tarball's
 * own entry code runs against WORKSPACE-resolved dependency code, because the packed package.json
 * still carries `workspace:*` for its siblings. A dependency defect is therefore caught only where
 * `--version` or `--help` actually execute it, and a sibling's packaging is not under test at all.
 */
export function runBinary(binPath: any, args: any): {
    stdout: string;
    exitCode: number;
    stderr?: undefined;
} | {
    stdout: any;
    stderr: any;
    exitCode: any;
};
/**
 * Run the full probe. Returns { pass, version, checks }.
 */
export function probe(): Promise<{
    pass: boolean;
    version: any;
    checks: any[];
}>;
