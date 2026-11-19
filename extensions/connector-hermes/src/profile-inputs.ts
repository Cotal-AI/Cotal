import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const ADOPT_HOME_ENV = "COTAL_HERMES_ADOPT_HOME";
const MISSING_MANAGED_MODEL =
  "A managed Hermes profile does not read ~/.hermes, and no model was resolved for it. " +
  `Set one with --model or the agent file's model:, or use your own profile with ${ADOPT_HOME_ENV}=$HOME/.hermes.`;

/** A launch refusal the launcher prints as a diagnosis without an internal stack. */
export class LaunchRefused extends Error {}

export class ManagedModelRequired extends LaunchRefused {}

export function requireManagedModel(model: string | undefined): asserts model is string {
  if (!model) throw new ManagedModelRequired(MISSING_MANAGED_MODEL);
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

export function validateAdoptedProfile(home: string, hasPersona: boolean): void {
  let profile;
  try {
    profile = statSync(home, { throwIfNoEntry: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code !== "string") throw error;
    throw new LaunchRefused(`Cannot inspect ${ADOPT_HOME_ENV}=${home} (${code}). Point it at an accessible Hermes profile directory.`, { cause: error });
  }
  if (!profile)
    throw new LaunchRefused(`${ADOPT_HOME_ENV}=${home} does not exist. Point it at an existing Hermes profile directory, usually ~/.hermes.`);
  if (!profile.isDirectory())
    throw new LaunchRefused(`${ADOPT_HOME_ENV}=${home} is not a directory. Point it at your Hermes profile directory.`);
  if (hasPersona)
    throw new LaunchRefused(`${ADOPT_HOME_ENV} runs your own profile, whose SOUL.md is not overwritten, so the agent file's persona cannot be applied. Remove the persona text from the agent file or unset ${ADOPT_HOME_ENV} to use a managed profile.`);
}
