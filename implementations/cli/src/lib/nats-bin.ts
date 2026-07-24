import { spawnSync } from "node:child_process";

/** Platform-package prefix the bundled binary ships under. Swapping providers
 *  (e.g. to our own @cotal-ai/nats-server-*) is a one-line change here. */
const BUNDLED_PKG_PREFIX = "@eplightning/nats-server";

/** Resolve the nats-server binary: PATH first (an operator-installed server always
 *  wins), then the bundled platform package. Throws when neither is available. */
export async function resolveNatsServer(): Promise<{ bin: string; source: "path" | "bundled" }> {
  const onPath = spawnSync("nats-server", ["--version"], { stdio: "ignore" });
  if (!onPath.error && onPath.status === 0) return { bin: "nats-server", source: "path" };

  const pkg = `${BUNDLED_PKG_PREFIX}-${process.platform}-${process.arch}`;
  try {
    const mod = (await import(pkg)) as { getBinaryPath(): string };
    return { bin: mod.getBinaryPath(), source: "bundled" };
  } catch {
    // The bundled binary requires Node >= 22; npm silently skips an optional dependency whose
    // engine the running Node doesn't satisfy, so an install done under an older Node lacks it —
    // and npx reuses that binary-less tree even after Node is upgraded. Name the likely cause.
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
    const staleInstallHint = Number.isInteger(nodeMajor) && nodeMajor < 22
      ? `This is Node ${process.version}; the bundled broker needs Node >= 22. Upgrade Node, then reinstall.\n`
      : `This usually means cotal was first installed under Node < 22 (npm skips the broker binary\nthere) and the stale install is being reused. Reinstall under Node >= 22.\n`;
    throw new Error(
      `nats-server not found on PATH, and the bundled binary for ${process.platform}/${process.arch} (${pkg}) is not installed.\n` +
        staleInstallHint +
        `  npm i -g cotal-ai         # global install\n` +
        `  rm -rf ~/.npm/_npx        # if you use npx, clear its cache first, then re-run\n` +
        `Or install nats-server yourself (https://github.com/nats-io/nats-server/releases) and put it on PATH.`,
    );
  }
}
