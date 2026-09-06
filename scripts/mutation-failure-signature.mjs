import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ANSI = /\x1b\[[0-9;]*m/g;

export function unmeasurableFailure(run) {
  if (run.error) return `command could not start: ${run.error.message}`;
  if (run.status === null || run.signal)
    return `command did not produce an exit status${run.signal ? ` (signal ${run.signal})` : ""}`;
  if (run.status === 126 || run.status === 127) return `command was unavailable (exit ${run.status})`;
  const infrastructureFailure = /(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|ERR_PNPM[A-Z0-9_]*|Missing script|command not found|\b[^:\s]+: not found\b|is not recognized as an internal or external command)/i
    .exec(run.output);
  if (infrastructureFailure) return `command could not run: ${infrastructureFailure[0]}`;
  if (run.status !== 0 && run.output.trim() === "")
    return "red command produced no output, so its verdict is ambiguous";
  return undefined;
}

export function comparableFailure(output, cwd) {
  const slash = (value) => value.replace(/\\/g, "/");
  const projectRoot = slash(realpathSync(cwd)).replace(/\/$/, "");
  const projectPrefix = `${projectRoot}/`;
  const dependencyPath = /(?:^|[/\\])(?:node_modules|\.pnpm)(?:[/\\]|$)/;
  const tempRoots = [...new Set([tmpdir(), realpathSync(tmpdir())]
    .map((entry) => slash(entry).replace(/\/$/, "")))];
  const classifyLocation = (location) => {
    const withoutCoordinates = location.replace(/:\d+(?::\d+)?$/, "");
    const fileUrl = withoutCoordinates.startsWith("file://");
    let path = withoutCoordinates;
    if (fileUrl) {
      try { path = fileURLToPath(withoutCoordinates); }
      catch { path = withoutCoordinates.slice(7); }
    }
    path = slash(path);
    const pathShaped = fileUrl || path.startsWith("/") || /^[A-Za-z]:\//.test(path);
    if (!pathShaped) return { kind: "verbatim" };
    if (path === projectRoot || path.startsWith(projectPrefix)) {
      if (dependencyPath.test(path)) return { kind: "drop" };
      const relativePath = path === projectRoot ? "" : path.slice(projectPrefix.length);
      return { kind: "origin", value: relativePath ? `<ROOT>/${relativePath}` : "<ROOT>" };
    }
    if (dependencyPath.test(path)) return { kind: "drop" };
    for (const tempRoot of tempRoots) {
      if (!path.startsWith(`${tempRoot}/`)) continue;
      const remainder = path.slice(tempRoot.length + 1);
      const separator = remainder.indexOf("/");
      return { kind: "origin", value: separator === -1 ? "<TMP>" : `<TMP>/${remainder.slice(separator + 1)}` };
    }
    return { kind: "origin", value: path };
  };
  const signature = [];
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.trim();
    // This exact pnpm warning describes only the execution environment. Do not generalize it to every
    // line-initial [WARN]: suites use that token semantically, and different warnings are different
    // failures even when their sibling assertion lines happen to match.
    if (/^\[WARN\]\s+Local package\.json exists, but node_modules missing, did you mean to install\?$/i.test(line)) continue;
    if (!line || /^(?:Node\.js v|npm |pnpm |Scope:|Lockfile |Progress:|Packages:|Done in |\[?ELIFECYCLE\]?|Command failed)/i.test(line)) continue;
    if (/^at\s/.test(line)) {
      const paren = line.match(/^at\s+(.+?)\s+\((.+)\)$/);
      const bare = line.match(/^at\s+(?:async\s+)?(.+)$/);
      const location = paren?.[2] ?? bare?.[1];
      if (!location || location.startsWith("node:")) continue;
      const classified = classifyLocation(location);
      if (classified.kind === "origin")
        signature.push(paren ? `at ${paren[1]} (${classified.value})` : `at ${classified.value}`);
      else if (classified.kind === "verbatim") signature.push(line);
      continue;
    }
    const header = line.match(/^(file:\/\/)?(.+?):\d+(?::\d+)?$/);
    if (header) {
      const classified = classifyLocation(`${header[1] ?? ""}${header[2]}`);
      if (classified.kind === "origin") signature.push(classified.value);
      if (classified.kind !== "verbatim") continue;
    }
    signature.push(line.split(`file://${projectPrefix}`).join("file://<ROOT>/")
      .split(projectRoot).join("<ROOT>"));
  }
  return signature.length ? signature.join("\n") : undefined;
}

export function failureSignatureHash(output, cwd) {
  const signature = comparableFailure(output, cwd);
  return signature === undefined ? undefined : createHash("sha256").update(signature).digest("hex");
}
