import { realpathSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";

export class SuiteMetadataError extends Error {
  constructor(diagnosis, configPath, detail) {
    super(`${configPath}: ${diagnosis}${detail ? `: ${detail}` : ""}`);
    this.name = "SuiteMetadataError";
    this.diagnosis = diagnosis;
  }
}

const fail = (diagnosis, configPath, detail) => {
  throw new SuiteMetadataError(diagnosis, configPath, detail);
};

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function parseSuiteSources(root, configPath, value, { checkExists = true } = {}) {
  if (value === undefined) fail("MISSING SUITE METADATA", configPath, 'required top-level "suite" array');
  if (!Array.isArray(value)) {
    fail("MALFORMED SUITE METADATA", configPath, '"suite" must be an array, not a legacy string or other value');
  }
  if (value.length === 0) fail("EMPTY SUITE METADATA", configPath, '"suite" must name at least one source');

  const rootReal = realpathSync(root);
  const seen = new Set();
  return value.map((source, index) => {
    const at = `suite[${index}]`;
    if (typeof source !== "string" || source.length === 0) {
      fail("MALFORMED SUITE METADATA", configPath, `${at} must be a non-empty string`);
    }
    if (seen.has(source)) fail("MALFORMED SUITE METADATA", configPath, `${at} duplicates ${JSON.stringify(source)}`);
    seen.add(source);

    const segments = source.split("/");
    if (!source.includes("/") || source.startsWith("/") || source.endsWith("/")
        || segments.some((segment) => segment === "" || segment === "." || segment === "..")
        || /[\s:\\]/u.test(source) || /[\u0000-\u001f\u007f]/u.test(source)
        || posix.normalize(source) !== source) {
      fail("NON-PATH SUITE SOURCE", configPath, `${at} is not a normalized repository-relative POSIX source path: ${JSON.stringify(source)}`);
    }

    const absolute = resolve(rootReal, source);
    if (!inside(rootReal, absolute)) {
      fail("NON-PATH SUITE SOURCE", configPath, `${at} escapes the repository root: ${JSON.stringify(source)}`);
    }
    if (!checkExists) return source;
    let resolved;
    let stat;
    try {
      resolved = realpathSync(absolute);
      stat = statSync(absolute);
    } catch {
      fail("SUITE SOURCE MISSING", configPath, `${at} does not resolve to an existing regular file: ${source}`);
    }
    if (!inside(rootReal, resolved) || !stat.isFile()) {
      fail("SUITE SOURCE MISSING", configPath, `${at} does not resolve to an existing regular file inside the repository: ${source}`);
    }
    return source;
  });
}
