import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const ADOPT_HOME_ENV = "COTAL_HERMES_ADOPT_HOME";
const MISSING_MANAGED_MODEL =
  "A managed Hermes profile does not read ~/.hermes, and no model was resolved for it. " +
  `Set one with --model or the agent file's model:, or use your own profile with ${ADOPT_HOME_ENV}=$HOME/.hermes.`;

/** A launch refusal the launcher prints as a diagnosis without an internal stack. */
export class LaunchRefused extends Error {}

export function requireManagedModel(model: string | undefined): asserts model is string {
  if (!model) throw new LaunchRefused(MISSING_MANAGED_MODEL);
}

/** A blank opt-in means a managed profile. Refuse relative paths to keep the profile independent
 * of the launcher working directory. */
export function adoptedHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ADOPT_HOME_ENV]?.trim();
  if (!raw) return undefined;
  if (!isAbsolute(raw))
    throw new LaunchRefused(`${ADOPT_HOME_ENV}=${raw} is not an absolute path. Set it to the full path of your Hermes profile directory, for example ${ADOPT_HOME_ENV}=$HOME/.hermes`);
  return raw;
}

export function requireAdoptedDirectory(home: string): void {
  const profile = statSync(home, { throwIfNoEntry: false });
  if (!profile)
    throw new LaunchRefused(`${ADOPT_HOME_ENV}=${home} does not exist. Point it at an existing Hermes profile directory, usually ~/.hermes.`);
  if (!profile.isDirectory())
    throw new LaunchRefused(`${ADOPT_HOME_ENV}=${home} is not a directory. Point it at your Hermes profile directory.`);
}
