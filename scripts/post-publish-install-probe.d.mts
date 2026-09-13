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
 * Extract a tarball. npm tarballs extract into a `package/` subdirectory.
 */
export function extractTarball(tarball: any, extractDir: any): string;
/**
 * Verify the bin entry exists in an extracted tarball. Returns { binName, binRel, binPath, exists }.
 */
export function verifyBinEntry(pkgDir: any): {
    binName: string | null;
    binRel: any;
    binPath: string | null;
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
 * Run a binary from an extracted tarball. The binary code comes from the tarball; a symlink to
 * the workspace's bin/node_modules is created in the package directory so ESM bare-specifier
 * imports resolve.
 */
export function runBinary(binPath: string, args: any): {
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
