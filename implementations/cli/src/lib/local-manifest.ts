import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { resolveManifest } from "./manifest/resolve.js";

export interface LocalManifestHint {
  message: string;
  commands: { command: string; description: string }[];
}

/** Notice only this folder's cotal.yaml. Discovery neither selects a space nor reads personas. */
export function localManifestHint(cwd: string, cmd = "cotal"): LocalManifestHint | undefined {
  const check = { command: `${cmd} team check cotal.yaml --graph`, description: "Check this folder's team declaration offline" };
  let fd: number | undefined;
  try {
    const path = join(cwd, "cotal.yaml");
    // A pipe must not block help or status, and a link must not make discovery read another file.
    if (!lstatSync(path).isFile()) throw new Error("not a regular file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("not a small regular file");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    for (let n; size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0;) size += n;
    if (size > 1024 * 1024) throw new Error("file grew beyond the discovery bound");
    const manifest = resolveManifest(bytes.toString("utf8", 0, size), path);
    if (manifest.space.startsWith("-")) throw new Error("space name cannot be passed as a command argument");
    return {
      message: `cotal.yaml declares space "${manifest.space}"; the file does not select or prepare it.`,
      commands: [check,
        { command: `${cmd} space create ${manifest.space} --root .`, description: "Prepare the declared space if it is not already prepared here" },
        { command: `${cmd} team boot cotal.yaml`, description: "Boot the checked team from its prepared root" },
      ],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { message: "cotal.yaml could not be read as a valid team declaration; no space was inferred from it.", commands: [check] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Next steps for a declaration are advice only, including when no space can be resolved. */
export function localManifestRemedy(cwd: string, cmd = "cotal"): string | undefined {
  const hint = localManifestHint(cwd, cmd);
  return hint && `${hint.message} ${hint.commands.map(({ command }) => `\`${command}\``).join("; then ")}`;
}
