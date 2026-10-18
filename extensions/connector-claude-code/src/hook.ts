/**
 * Cotal Claude Code lifecycle hook — a one-liner over the shared relay.
 *
 * Claude Code runs this on a lifecycle event and pipes the event JSON on stdin;
 * the relay (in @cotal-ai/connector-core) forwards it to this session's connector
 * control socket and prints the reply. Two answers settle an event here instead:
 * a call to another Cotal path's tool ({@link otherCotalPath}), and a hosted
 * connection used outside the session that opened it ({@link connectionOwner}).
 * It never blocks the session.
 */
// The subpath, not the package root: the root's graph reaches the NATS client, zod and yaml, which
// this process would load on every lifecycle event without using.
import { runHookRelay } from "@cotal-ai/connector-core/relay";
import { otherCotalPath } from "./one-path.js";
import { connectionOwner } from "./connection-owner.js";

const owner = connectionOwner(process.env.CLAUDE_PLUGIN_DATA);
void runHookRelay((event, session) => otherCotalPath(event, session) ?? owner(event, session)).catch(() => process.exit(0));
