/**
 * Keeping a conversation reachable when an Agent SDK host runs it. Such a host, T3 Code among them,
 * stops an idle session's Claude Code process: T3 Code does so 30 minutes after the last turn. That
 * ends this plugin's server, the conversation's Cotal connection and its native reader, so a later
 * message wakes nothing. A host keeps a session that has a background task running, so the
 * conversation runs a silent hold (`monitor.cjs --hold`) as one. T3 Code keeps such a session for at
 * most 4 hours after its last activity, so a hold ends sooner and the conversation starts the next.
 */
import { dirname, join } from "node:path";

/** How long one hold runs before it ends and asks for the next. */
export const HOLD_MS = 3 * 60 * 60 * 1000;

/** Whether an Agent SDK host runs this session, from the entrypoint Claude Code exports. */
export function sdkHosted(env: NodeJS.ProcessEnv): boolean {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? "";
  return entrypoint.startsWith("sdk-") || entrypoint === "t3-code";
}

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The command that runs a hold, from the server's own Node and bundle directory. */
export function holdCommand(node: string, serverPath: string): string {
  return `${quote(node)} ${quote(join(dirname(serverPath), "monitor.cjs"))} --hold`;
}

/** What `cotal_connect` adds in such a session. */
export function holdAdvice(command: string): string {
  return "This session runs under a host that stops an idle session (T3 Code does after 30 minutes), " +
    "which disconnects Cotal and stops incoming messages from waking you. To stay reachable, now run this " +
    `with the Bash tool and run_in_background set to true: ${command}\n` +
    "It prints nothing while it runs. When it ends, run it again the same way. Stop it only after cotal_disconnect.";
}

/** What a hold prints when it ends, which wakes the conversation to start the next one. */
export function holdEnded(command: string): string {
  return `Cotal: this session's hold ended. To stay reachable, run it again with the Bash tool and run_in_background set to true: ${command}`;
}
