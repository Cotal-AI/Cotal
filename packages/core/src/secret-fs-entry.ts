/**
 * The `@cotal-ai/core/secret-fs` subpath: the secret and private-record writers for a hook process
 * that must not load the package root. It names the same functions the root exports and nothing
 * else, so the module's test-only `__setPublishLinkForTest` seam stays off every public entry.
 */
export {
  createPrivateRecord,
  hardenPrivate,
  mkSecretDir,
  openPrivateAppend,
  writePrivateRecord,
  writeSecretFile,
  writeSecretFileAtomic,
  writeSecretFileCreateOnly,
} from "./secret-fs.js";
