/**
 * The environment readers the lifecycle hook relay calls. They live apart from `config.ts`, which
 * imports the core barrel, because a hook process that loaded that barrel would load the NATS
 * client, zod and yaml on every lifecycle event and use none of them.
 */
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, type LaunchMaterial } from "@cotal-ai/core/launch-material";

/** The env vars that carry connection material DIRECTLY, for a hand-driven session. A
 *  launcher-spawned seat gets the same material as a file instead, so that a build script, a linter
 *  or a test suite the seat shells out to does not inherit a live credential nobody handed it. */
const DIRECT_MATERIAL_VARS = [
  "COTAL_CREDS",
  "COTAL_SERVERS",
  "COTAL_TOKEN",
  "COTAL_OWNER",
  "COTAL_ACTOR",
  "COTAL_SENTINEL_CREDS",
  "COTAL_BEARER_CMD",
  "COTAL_EVENTS_REQUIRED",
  // The control token belongs here for a reason that is not symmetry. Once a launcher-spawned seat
  // carries a material pointer in its environment, anything that INHERITS that environment and then
  // sets COTAL_CONTROL_TOKEN by hand has two answers for one question, and controlFromEnv would
  // silently prefer the inherited one - handing a process the OUTER seat's control endpoint while
  // its own explicit token sat unused. That is not hypothetical: it is what a test harness spreading
  // `...process.env` does, and this whole change exists because that spread used to be invisible.
  "COTAL_CONTROL_TOKEN",
  // A join link is connection material in one string: it carries the server, the auth and the space.
  // Left off this list, a launch with both a material file and a link resolved the conflict by
  // precedence and said nothing, which is the same silent answer to "who is this session" that the
  // credential pair is refused for.
  "COTAL_LINK",
] as const;

/** Resolve the launch-material file, if this launch uses one. Refuses the two-carrier case: a
 *  material file AND direct material vars means two answers to "who is this session", and picking
 *  one silently is how a seat ends up connected as something nobody chose. An unreadable or
 *  permissive file throws from {@link readLaunchMaterial} - never a fall back to the env, which
 *  would turn a broken launch into a quietly different one. */
export function readMaterial(env: NodeJS.ProcessEnv): LaunchMaterial | undefined {
  const path = env[LAUNCH_MATERIAL_ENV]?.trim();
  if (!path) return undefined;
  const direct = DIRECT_MATERIAL_VARS.filter((k) => env[k]?.trim());
  if (direct.length)
    throw new Error(
      `COTAL config: this launch carries connection material BOTH as ${LAUNCH_MATERIAL_ENV} and as ${direct.join(", ")}. ` +
        "One launch carries one identity plane - drop the direct variables, or drop the material file.",
    );
  return readLaunchMaterial(path);
}

/**
 * This session's local control endpoint: the socket PATH from the env (not a secret, and the
 * short-lived hook processes need it too) and the first-frame token out of the launch material,
 * which is where the token now rides instead of `COTAL_CONTROL_TOKEN`.
 *
 * NOTHING means nothing: neither half present, so this is a session with no control plane, which is
 * a normal launch. HALF A PAIR THROWS HERE, centrally, and that is the change worth explaining.
 *
 * Returning `undefined` for a half pair made every caller's own check the real contract, and the
 * callers do not agree: the in-agent server would refuse to serve, a hook would fall silent, and one
 * caller could simply forget, leaving a session that runs with a control plane it believes it
 * configured and does not have. That is a silent degradation wearing the shape of an optional
 * feature. Half a pair is not an absent control endpoint, it is a BROKEN one, and the difference
 * belongs where the pair is resolved rather than in five copies downstream.
 *
 * Callers that must survive anything still can, and do so visibly: the lifecycle hook relay wraps
 * this call in a try/catch because a hook that throws is a hook that blocked the session, and fail
 * open is that relay's whole documented contract. Every other caller wants exactly this throw.
 */
export function controlFromEnv(env: NodeJS.ProcessEnv = process.env): { path: string; token: string } | undefined {
  const path = env.COTAL_CONTROL_SOCKET?.trim();
  const token = readMaterial(env)?.controlToken ?? env.COTAL_CONTROL_TOKEN?.trim();
  if (path && token) return { path, token };
  if (!path && !token) return undefined;
  if (path)
    throw new Error(
      "COTAL config: COTAL_CONTROL_SOCKET is set but no control token could be resolved - neither the launch material nor COTAL_CONTROL_TOKEN carries one. " +
        "Half a pair is not a control endpoint, so this launch is refused rather than started without the control plane it was configured to have.",
    );
  throw new Error(
    "COTAL config: a control token was supplied but COTAL_CONTROL_SOCKET is unset, so there is no socket to authenticate against. " +
      "Half a pair is not a control endpoint, so this launch is refused rather than started without the control plane it was configured to have.",
  );
}

/** True iff the env carries a Cotal identity — i.e. this is a launcher-spawned
 *  session, not an operator's plain `claude`. `COTAL_LINK` / `COTAL_AGENT_FILE`
 *  count: setting either is itself the explicit opt-in. The connector stays
 *  inert otherwise. */
export function hasIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.COTAL_NAME?.trim() || env.COTAL_LINK?.trim() || env.COTAL_AGENT_FILE?.trim());
}
