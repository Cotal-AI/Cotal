import type { HarnessInstall, HarnessInstaller } from "@cotal-ai/core";

const SYSTEMS = ["darwin", "linux", "win32"] as const;
const FOLDER_VARIABLES = ["LOCALAPPDATA", "APPDATA", "USERPROFILE"];
const RESERVED_ENV = ["PATH", "PATHEXT", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "SHELL"];
const plain = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function installerFor(system: (typeof SYSTEMS)[number], raw: unknown, problem: (what: string) => never): HarnessInstaller {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) problem(`the ${system} installer is not an object`);
  const { script, shell, env, binDir, needs, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length) problem(`the ${system} installer has unknown fields: ${Object.keys(rest).join(", ")}`);
  let url: URL | undefined;
  try { url = typeof script === "string" ? new URL(script) : undefined; } catch { url = undefined; }
  // PowerShell receives the address inside single quotes, so a quote, a space or a backtick never reaches it.
  if (!url || url.protocol !== "https:" || url.username || url.password || url.href !== script || /['"`\s\\$]/.test(script as string))
    problem(`the ${system} installer script must be a plain https address`);
  if (system === "win32" ? shell !== undefined : shell !== "sh" && shell !== "bash") problem(system === "win32" ? "a Windows installer runs in PowerShell and names no shell" : `the ${system} installer must name the shell its script is piped to, sh or bash`);
  if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || RESERVED_ENV.includes(key) || !plain(value, 200))))
    problem(`the ${system} installer's variables must be plain uppercase names with short values, and cannot set ${RESERVED_ENV.join(", ")}`);
  const folder = system === "win32"
    ? /^%([A-Z]+)%((?:\\[^\\/:*?"<>|%]+)+)$/.exec(String(binDir))
    // The folder is written into shell startup files, so a POSIX segment holds no shell syntax.
    : /^~((?:\/[A-Za-z0-9._-]+)+)$/.exec(String(binDir));
  if (!plain(binDir, 200) || !folder || (system === "win32" && !FOLDER_VARIABLES.includes(folder[1]!)) || folder.at(-1)!.split(/[\\/]/).some(part => part === "." || part === ".."))
    problem(system === "win32" ? `the Windows installer's folder must start with %${FOLDER_VARIABLES.join("%\\, %")}%\\` : `the ${system} installer's folder must start with ~/ and name folders with letters, digits, dots, underscores and hyphens only`);
  if (needs !== undefined && (!Array.isArray(needs) || needs.some(name => typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name))))
    problem(`the ${system} installer's needs must be executable names`);
  return Object.freeze({
    script: script as string,
    ...(shell === undefined ? {} : { shell: shell as "sh" | "bash" }),
    ...(env === undefined ? {} : { env: Object.freeze({ ...(env as Record<string, string>) }) }),
    binDir: binDir as string,
    ...(needs === undefined ? {} : { needs: Object.freeze([...(needs as string[])]) }),
  });
}

/** A connector's install declaration, checked and copied, or a thrown error that names the connector
 *  and what is wrong. The extensions manifest caches what this returns, and an app reads it back
 *  through it, so neither runs a malformed command. */
export function checkedHarnessInstall(connector: string, requires: readonly string[], raw: unknown): HarnessInstall {
  const problem = (what: string): never => { throw new Error(`connector ${connector} declares an invalid install: ${what}`); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) problem("it is not an object");
  const { title, maker, installers, signIn, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length) problem(`unknown fields: ${Object.keys(rest).join(", ")}`);
  if (!plain(title, 60) || !plain(maker, 60)) problem("title and maker must be short plain text");
  if (!requires.length) problem("a connector that requires no executable has nothing to install");
  if (!installers || typeof installers !== "object" || Array.isArray(installers)) problem("installers is not an object");
  const systems = Object.keys(installers as object);
  if (!systems.length || systems.some(system => !SYSTEMS.includes(system as (typeof SYSTEMS)[number]))) problem(`installers must name one or more of ${SYSTEMS.join(", ")}`);
  const checked: Partial<Record<(typeof SYSTEMS)[number], HarnessInstaller>> = {};
  for (const system of SYSTEMS) {
    const value = (installers as Record<string, unknown>)[system];
    if (value !== undefined) checked[system] = installerFor(system, value, problem);
  }
  let sign: HarnessInstall["signIn"];
  if (signIn !== undefined) {
    const { status, login, ...extra } = (signIn && typeof signIn === "object" ? signIn : {}) as Record<string, unknown>;
    const command = (value: unknown): value is string[] => Array.isArray(value) && value.length > 1 && value.length <= 8 && value.every(arg => plain(arg, 100)) && requires.includes(value[0]);
    if (Object.keys(extra).length || !command(status) || !command(login)) problem("signIn needs a status and a login command, each starting with an executable the connector requires");
    sign = Object.freeze({ status: Object.freeze([...(status as string[])]), login: Object.freeze([...(login as string[])]) });
  }
  return Object.freeze({ title: title as string, maker: maker as string, installers: Object.freeze(checked), ...(sign ? { signIn: sign } : {}) });
}
