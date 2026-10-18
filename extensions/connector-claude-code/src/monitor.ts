/**
 * The Cotal plugin's monitor. Claude Code runs it for the whole of an interactive session and starts
 * a turn for every line it prints, so it prints one fixed line for each wake the session's local
 * servers announce (`wake-feed.ts`), and nothing else. What it reads is only ever a connection id,
 * checked before use, so no text from a socket reaches the model. A session Cotal launched has its
 * own push, so there it exits.
 */
import { createConnection } from "node:net";
import { hasIdentity } from "@cotal-ai/connector-core/relay";
import { WAKE_ID, wakeSockets } from "./wake-feed.js";

/** How often to look for a server that opened its feed since. */
const SCAN_MS = 1_000;

/** The event for a wake on connection `id`. */
const wakeEvent = (id: string) => `Cotal: a new message for connection_id ${id}. Read it with cotal_inbox.`;

function main(): void {
  if (hasIdentity()) return;
  const claude = Number(process.env.CLAUDE_PID);
  if (!Number.isInteger(claude) || claude <= 0) {
    process.stderr.write("[cotal-monitor] no CLAUDE_PID, so this is not a Claude Code session\n");
    process.exitCode = 1;
    return;
  }
  const reading = new Set<string>();
  const read = (path: string) => {
    reading.add(path);
    let buf = "";
    const s = createConnection(path);
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const id = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (WAKE_ID.test(id)) process.stdout.write(`${wakeEvent(id)}\n`);
      }
      // A feed that sends no newline is not a server's.
      if (buf.length > 256) s.destroy();
    });
    s.on("error", () => {});
    s.on("close", () => reading.delete(path));
  };
  const scan = () => {
    try {
      process.kill(claude, 0);
    } catch {
      // The session ending stops plugin monitors; this also ends one whose Claude Code is gone.
      process.exit(0);
    }
    for (const path of wakeSockets(claude)) if (!reading.has(path)) read(path);
  };
  scan();
  setInterval(scan, SCAN_MS);
}

main();
