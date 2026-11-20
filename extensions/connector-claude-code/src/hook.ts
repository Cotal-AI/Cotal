/**
 * Cotal Claude Code lifecycle hook — a one-liner over the shared relay.
 *
 * Claude Code runs this on a lifecycle event and pipes the event JSON on stdin;
 * the relay (in @cotal-ai/connector-core) forwards it to this session's connector
 * control socket and prints the reply. Two answers settle an event here instead:
 * a call to another Cotal path's tool ({@link otherCotalPath}), and a hosted
 * connection used outside the session that opened it ({@link connectionOwner}).
 * It never blocks the session. A tool permission is held until the connector answers it, while
 * Claude's own dialog stays open ({@link isPermissionRequest}).
 */
// The subpath, not the package root: the root's graph reaches the NATS client, zod and yaml, which
// this process would load on every lifecycle event without using.
import { runHookRelay, type LocalHookAnswer } from "@cotal-ai/connector-core/relay";
import { otherCotalPath } from "./one-path.js";
import { connectionOwner } from "./connection-owner.js";
import { observePersonalHook } from "./native-binding.js";

/** The event the relay holds until the connector answers it. */
const isPermissionRequest = (event: unknown): boolean =>
  (event as { hook_event_name?: unknown } | null)?.hook_event_name === "PermissionRequest";

/** The connector serves no prompts on Windows yet, so there a tool permission gets no decision here,
 *  before any endpoint is resolved or dialed, and Claude's own dialog answers it. */
const windowsPermission: LocalHookAnswer = (event) =>
  (process.platform === "win32" && isPermissionRequest(event) ? {} : undefined);

const owner = connectionOwner(process.env.CLAUDE_PLUGIN_DATA);
void runHookRelay(
  (event, session) => windowsPermission(event, session) ?? otherCotalPath(event, session) ?? owner(event, session),
  async (event, session) => { if (!session.managed) await observePersonalHook(event); },
  { holds: isPermissionRequest },
).catch(() => process.exit(0));
