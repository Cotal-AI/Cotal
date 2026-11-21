/** Opt-in to run the gateway in the operator's own Hermes profile. */
export const ADOPT_HOME_ENV = "COTAL_HERMES_ADOPT_HOME";

/** A launch refusal whose message is shown to the operator without a stack trace. */
export class LaunchRefused extends Error {}

/** A managed profile cannot use the model configured in the operator's own profile. */
export function requireManagedModel(model: string | undefined): asserts model is string {
  if (!model)
    throw new LaunchRefused(
      "A managed Hermes profile needs a model. Set one with --model or the agent file's model: field, " +
        `or run the gateway on your own profile with ${ADOPT_HOME_ENV}=$HOME/.hermes.`,
    );
}
