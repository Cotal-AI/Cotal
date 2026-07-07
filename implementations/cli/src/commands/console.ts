import { writeSync } from "node:fs";
import { userInfo } from "node:os";
import { createElement } from "react";
import { render } from "ink";
import { chatWildcard, mintCreds, newIdentity, type ParsedArgs, type SpaceAuth } from "@cotal-ai/core";
import {
  isWorkspaceTargetError,
  loadMeshes,
  preflightTarget,
  pruneStaleMeshes,
  registryTarget,
  removeMesh,
  renderWorkspaceError,
  resolveRegistryTarget,
  type MeshEntry,
  type MeshTarget,
} from "@cotal-ai/workspace";
import { connectOrExit, preflightOrExit } from "../lib/connect.js";
import { c } from "../ui.js";
import { runLog } from "../render.js";
import { Root, makeObserver, type MeshConn } from "../console/root.js";

/**
 * `cotal console` — the live protocol view. A real terminal gets the lazygit-style Ink TUI; a pipe
 * or `--plain` gets the passive line stream. Bare (no flags) it is the run-anywhere overview:
 * resolved from the registry ONLY — never the cwd, so a stray local `.cotal/` can neither hijack
 * nor block it — and with several meshes registered the TTY opens a mesh overview of all of them
 * (pick one to drill in, `b` to come back). On an open mesh with no `--space` a space overview
 * follows; `--space X` goes straight in. Renders over a read-only observer whose lifecycle
 * `useMesh` owns. See docs/mesh-view.md.
 */
export async function console_(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; server?: string; plain?: boolean; creds?: string };
  const tui = !values.plain && process.stdout.isTTY === true;

  // Which mesh(es)? Auth mode self-mints an admin god-view cred (the console shows DMs/anycast,
  // which the narrower `observer` profile denies → NATS Authorization Violation); an authed server
  // hosts exactly one space, so we enter it directly. Open mode connects bare. An explicit --creds
  // wins.
  let meshes: MeshEntry[] | undefined; // set → registry-picker mode, no upfront target
  let server = "";
  let resolvedSpace = "";
  let creds: string | undefined;
  let auth: SpaceAuth | undefined;
  if (!values.space && !values.server && !values.creds) {
    // Bare invocation: registry-only. The stream can't host a picker, so off-TTY the N>1 case
    // resolves to `current` (or errors ambiguous) instead.
    await pruneStaleMeshes();
    const all = loadMeshes();
    if (tui && all.length > 1) {
      meshes = all;
    } else {
      let target: MeshTarget;
      try {
        target = resolveRegistryTarget();
      } catch (e) {
        if (!isWorkspaceTargetError(e)) throw e;
        console.error(c.red(renderWorkspaceError({ kind: "target", error: e })));
        process.exit(1);
      }
      creds = target.auth ? await mintCreds(target.auth, newIdentity(), "admin") : undefined;
      await preflightOrExit(target, creds);
      ({ server, space: resolvedSpace, auth } = target);
    }
  } else {
    ({ server, space: resolvedSpace, creds, auth } = await connectOrExit(values, "admin"));
  }
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
  if (!tui) {
    const s = space ?? resolvedSpace;
    await runLog(makeObserver(s, server, creds, operator), s, creds ? chatWildcard(s) : undefined);
    return;
  }

  // Registry-picker mode: connect on pick — same entry rules as the resolved path (recorded mode
  // decides the admin mint, preflight confirms liveness and prunes a stale entry), but failures
  // REJECT with the rendered one-line copy for the picker to show, instead of exiting the TUI.
  const enterMesh = async (m: MeshEntry): Promise<MeshConn> => {
    let target: MeshTarget;
    try {
      target = registryTarget(m);
    } catch (e) {
      if (!isWorkspaceTargetError(e)) throw e;
      throw new Error(renderWorkspaceError({ kind: "target", error: e }));
    }
    const minted = target.auth ? await mintCreds(target.auth, newIdentity(), "admin") : undefined;
    const r = await preflightTarget(target, minted);
    if (!r.ok) {
      if (r.prune) removeMesh(target.space);
      throw new Error(renderWorkspaceError({ kind: "preflight", failure: r.kind, target, pruned: r.prune }));
    }
    return { server: target.server, creds: minted, space: target.auth ? target.space : undefined, canWrite: !minted };
  };

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

  const props = meshes
    ? { meshes, enterMesh, name: operator }
    : { server, creds, space, canWrite, name: operator };
  const { waitUntilExit } = render(createElement(Root, props), {
    exitOnCtrlC: true,
    maxFps: 30,
    incrementalRendering: true,
  });
  await waitUntilExit();
  restore();
}
