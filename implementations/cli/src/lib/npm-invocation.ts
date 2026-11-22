import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, parse, resolve } from "node:path";
import { resolveOnPath } from "@cotal-ai/workspace";

export function npmInvocation(env: NodeJS.ProcessEnv) {
  const cwd = parse(homedir()).root;
  if (process.platform === "win32" || env.PATH === undefined) return { file: "npm", env, cwd };
  const lookup = { PATH: env.PATH.split(delimiter).map(dir => resolve(cwd, dir)).join(delimiter) };
  const file = resolveOnPath("npm", lookup);
  if (!file) return { file: "npm", env, cwd };
  const node = resolveOnPath("node", lookup);
  if (node && realpathSync(node) === realpathSync(process.execPath)) return { file: "npm", env, cwd };
  return { file, env: { ...env, PATH: `${dirname(process.execPath)}${delimiter}${env.PATH}` }, cwd };
}
