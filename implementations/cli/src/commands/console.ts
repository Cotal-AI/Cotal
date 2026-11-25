import { writeSync } from "node:fs";
import { userInfo } from "node:os";
import { createElement } from "react";
import { chatWildcard, type ParsedArgs } from "@cotal-ai/core";
import { colorEnabled, inputDisabledByFlag } from "@cotal-ai/workspace";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { runLog } from "../render.js";
import { openObserver, type ObserverAuth } from "@cotal-ai/workspace/view";
import type { ControlCtx } from "@cotal-ai/workspace/control";

/** The TUI and Ink. Ink colors through chalk, which settles its color level once, when it is first
 *  imported, from `FORCE_COLOR` before anything else, and does not read `NO_COLOR`. So they load
 *  here, after the kernel has read `--no-color`, and when color is off they load under
 *  `FORCE_COLOR=0`. The variable is put back at once, so the programs the console starts see the
 *  environment they would have. */
async function loadTui() {
  const forced = process.env.FORCE_COLOR;
  if (!colorEnabled()) process.env.FORCE_COLOR = "0";
  try {
    const [{ render }, { Root }] = await Promise.all([import("ink"), import("../console/root.js")]);
    return { render, Root };
  } finally {
    if (forced === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = forced;
  }
}

/**
 * `cotal console` opens the Ink TUI when stdin and stdout are terminals. Non-terminal streams,
 * `--plain` and `--no-input` use the passive line stream. On an open mesh, the TUI opens the
 * space picker unless `--space` selects a space. The `useMesh` hook owns the read-only observer.
 */
export async function console_(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; server?: string; plain?: boolean; creds?: string };
  // Resolve WHICH running mesh (server + trust material) from any directory — same as `spawn`/`web`.
  // Admin authentication does not widen the console's chat-only tap.
  const conn = await connectOrExit(values, "admin");
  const user = conn.bearer ? await userViewAuthOrExit(conn, "admin") : undefined;
  const { server, space: resolvedSpace, creds, auth } = conn;
  // Auth/user mode pins its one space; open mode keeps --space (undefined → the overview picker).
  const space = auth || user ? resolvedSpace : values.space;
  const observerAuth: ObserverAuth = user
    ? { user: { source: user.source, sentinelCreds: user.sentinelCreds, owner: user.owner, actor: user.actor } }
    : { creds };

  const operator = (() => {
    try {
      return userInfo().username || "operator";
    } catch {
      return "operator";
    }
  })();
  // The line stream cannot host the overview picker, so use the resolved mesh's space.
  if (values.plain || inputDisabledByFlag() || process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    const s = space ?? resolvedSpace;
    await runLog(openObserver({ space: s, server, auth: observerAuth, name: operator, operator: true }), s, creds || user ? chatWildcard(s) : undefined, values.plain === true, conn);
    return;
  }

  // Open mode and explicit --creds can send messages. Default observer credentials and the
  // user-mode admin view can only observe.
  const canWrite = user ? false : !creds || !!values.creds;
  // Control (kill / spawn / purge) never rides the observer: each action resolves the mesh
  // and mints its own one-shot instrument through the CLI's control path (console/control.ts), so
  // the gate is that path's own precondition and nothing about chat-write. The one shape it refuses
  // up front is a raw `--creds` file, which carries no ep rows (`askManager` says so); everything
  // else (open mesh, a registered static mesh, a user-mode bearer) is decided per action, by the
  // broker and the manager, and a refusal lands on the status line.
  const canControl = values.creds === undefined;
  const controlCtx: Omit<ControlCtx, "space"> = { server: values.server };
  // Never at module top: Ink's yoga-layout wasm initialization can fail on macOS with large
  // argv/environment (#4088). The shared loader also applies the requested color mode first.
  const { render, Root } = await loadTui();

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
  // External kill: restore the terminal, then actually exit (a bare handler would just hang) with
  // the signal's code.
  process.once("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    restore();
    process.exit(143);
  });

  const { waitUntilExit } = render(createElement(Root, { server, auth: observerAuth, space, canWrite, canControl, controlCtx, name: operator }), {
    exitOnCtrlC: true,
    maxFps: 30,
    incrementalRendering: true,
  });
  await waitUntilExit();
  restore();
}
