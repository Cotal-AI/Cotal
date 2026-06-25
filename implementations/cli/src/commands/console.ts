import { parseArgs } from "node:util";
import { writeSync } from "node:fs";
import { userInfo } from "node:os";
import { createElement } from "react";
import { render } from "ink";
import { chatWildcard } from "@cotal-ai/core";
import { connectOrExit } from "../lib/connect.js";
import { c } from "../ui.js";
import { runLog } from "../render.js";
import { Root, makeObserver } from "../console/root.js";

/**
 * `cotal console` — the live protocol view. A real terminal gets the lazygit-style Ink TUI; a pipe
 * or `--plain` gets the passive line stream. With no `--space` on an open mesh it opens an admin
 * overview of every space first (pick one to drill in, `b` to come back); `--space X` goes straight
 * in. Renders over a read-only observer whose lifecycle `useMesh` owns. See docs/protocol-view.md.
 */
export async function console_(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      plain: { type: "boolean" },
      creds: { type: "string" },
    },
  });
  // Resolve WHICH running mesh (server + trust material) from any directory — same as `spawn`/`web`.
  // Auth mode self-mints an admin god-view cred (the console shows DMs/anycast, which the narrower
  // `observer` profile denies → NATS Authorization Violation); an authed server hosts exactly one
  // space, so we enter it directly. Open mode connects bare; with no --space, the TTY shows the
  // space overview. An explicit --creds wins.
  const { server, space: resolvedSpace, creds, auth } = await connectOrExit(values, "admin");
  // Auth pins its one space; open mode keeps --space (undefined → the overview picker).
  const space = auth ? resolvedSpace : values.space;

  // Operator identity for sent messages (still off the roster). Open mode or an explicit --creds can
  // write; the self-minted observer cred (auth default) is read-only, so the palette/`D` are inert.
  const operator = (() => {
    try {
      return userInfo().username || "operator";
    } catch {
      return "operator";
    }
  })();
  const canWrite = !creds || !!values.creds;

  // No TTY (piped/headless) or --plain → the passive line stream; Ink needs a real terminal, and a
  // stream can't host the picker, so it falls back to the RESOLVED mesh's space (not the cwd's).
  if (values.plain || process.stdout.isTTY !== true) {
    const s = space ?? resolvedSpace;
    await runLog(makeObserver(s, server, creds, operator), s, creds ? chatWildcard(s) : undefined);
    return;
  }

  // Full-screen takeover + mouse-wheel scroll: the alternate screen gives a clean app-like
  // canvas (and restores the user's scrollback on exit), and xterm alt-scroll (?1007h) makes the
  // wheel/trackpad emit ↑/↓ — which Ink delivers to useInput, so the feed's arrow-key scroll just
  // works. No SGR mouse parsing, no new deps.
  let restored = false;
  // Synchronous writes (fs.writeSync) so the sequences flush before the process exits — a plain
  // process.stdout.write over a TTY is async and gets truncated by process.exit() on a signal.
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      writeSync(process.stdout.fd, "\x1b[?1007l\x1b[?1049l\x1b[?25h"); // alt-scroll off, leave alt-screen, show cursor
    } catch {
      /* stdout already gone */
    }
  };
  writeSync(process.stdout.fd, "\x1b[?1049h\x1b[?1007h"); // enter alt-screen + alt-scroll before Ink's first frame
  process.once("exit", restore); // synchronous safety net for any exit path
  // External kill: restore the terminal, then actually exit (a bare handler would just hang).
  process.once("SIGINT", () => {
    restore();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    restore();
    process.exit(0);
  });

  const { waitUntilExit } = render(createElement(Root, { server, creds, space, canWrite, name: operator }), {
    exitOnCtrlC: true,
    maxFps: 30,
    incrementalRendering: true,
  });
  await waitUntilExit();
  restore();
}
