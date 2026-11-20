/** A launch refusal whose message is the complete operator diagnosis. */
export class LaunchRefused extends Error {}

/** Opt in to running Hermes in the operator's own profile instead of a managed profile. */
export const ADOPT_HOME_ENV = "COTAL_HERMES_ADOPT_HOME";

/** Managed profiles do not inherit the model from the operator's Hermes configuration. */
export function requireManagedModel(model: string | undefined): asserts model is string {
  if (!model)
    throw new LaunchRefused(
      "a managed Hermes profile does not read ~/.hermes, and no model was resolved for it. " +
        `Set one with --model or the agent file's model:, or run the gateway on your own profile with ${ADOPT_HOME_ENV}=$HOME/.hermes`,
    );
}
