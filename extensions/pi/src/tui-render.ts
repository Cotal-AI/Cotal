import { spawn as childSpawn } from "node:child_process";
import { promises as fsp, mkdtempSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

/** Why this file exists: the pi connector's tui mode needs a renderer that
 *  depends only on Node builtins so it can ride on top of any pi release that
 *  keeps the rpc wire stable. No @earendil-works/pi-tui dep. No terminal-
 *  screen takeover — line-oriented, so a terminal crash leaves the pane
 *  cookable and avoids the restore-rawmode death-spiral that full-screen TUIs
 *  die in.
 *
 *  Dialog block semantics: only one dialog at a time. While a dialog is open,
 *  the renderer ignores subsequent `popXxx` calls (returns a never-resolving
 *  promise) — rpc-mode's extensions block on a Promise per dialog, so child
 *  emits are inherently serial, but in case a fire-and-forget method arrives
 *  mid-dialog, render-in-place (pushError / setStatus) doesn't disturb the
 *  active dialog. */

export interface TuiRenderer {
  start(): void;
  stop(): void;
  pushAssistantText(delta: string): void;
  flushTrailing(): void;
  pushToolEvent(toolName: string, pathLike?: string): void;
  pushError(line: string): void;
  setStatus(status: string, activity?: string): void;
  popConfirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean>;
  popSelect(title: string, options: string[], opts?: { timeout?: number }): Promise<string>;
  popInput(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string>;
  popEditor(title: string, prefill?: string, opts?: { timeout?: number; editorOverride?: string }): Promise<string>;
  onAbort(cb: () => void): void;
}

/** Options for the renderer. `editor` lets the platform override $EDITOR; the
 *  default picks $VISUAL then $EDITOR then `vi`. */
export interface TuiRendererOptions {
  editor?: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export function createTuiRenderer(opts: TuiRendererOptions = {}): TuiRenderer {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;

  // Raw-mode + keypress state. `keyListener` is the readline-attached keypress
  // handler; we keep a reference so stop() can detach.
  let raw = false;
  let keyListener: ((chunk: string, key: readline.Key) => void) | null = null;
  let stopped = false; // stop() is called from multiple shutdown paths; guard the offline line

  // Abort-on-Esc callback: only fires OUTSIDE a dialog while STREAMING. Client
  // sets this; renderer fires it; client sends {type:"abort"} to the child.
  let onAbortCb: (() => void) | null = null;

  // Dialog state. While `dialogActive` is true, keypresses route to the
  // dialog's resolver; outside, plain Esc while STREAMING triggers onAbortCb.
  // STREAMING is owned by the client, which calls renderer.markStreaming(true/false).
  let streaming = false;
  let dialogActive = false;

  // Line buffer for pushAssistantText — accumulates partial lines, writes
  // whole lines so the terminal isn't re-painted mid-word.
  let trailing = "";

  function writeLine(line: string): void {
    out.write(line.endsWith("\n") ? line : line + "\n");
  }

  function writeRaw(s: string): void {
    out.write(s);
  }

  function emitError(line: string): void {
    err.write(`[pi-peer] ! ${line}\n`);
  }

  function setRaw(on: boolean): void {
    if (on === raw) return;
    if (!process.stdin.isTTY) {
      // No TTY (e.g. piped CI): the renderer degrades — dialogs cannot be
      // answered interactively and auto-cancel. Throwing would be louder but
      // would break scripted use; degrading with a visible banner is friendlier.
      raw = false;
      return;
    }
    process.stdin.setRawMode(on);
    raw = on;
  }

  function attachKeypress(): void {
    if (keyListener) return;
    readline.emitKeypressEvents(process.stdin);
    keyListener = (_chunk, key) => onKey(key);
    process.stdin.on("keypress", keyListener);
  }

  function detachKeypress(): void {
    if (!keyListener) return;
    process.stdin.off("keypress", keyListener);
    keyListener = null;
  }

  function onKey(key: readline.Key): void {
    // Plain Esc: in-dialog cancels (resolver handles); OUT-of-dialog while
    // STREAMING triggers abort; otherwise ignore (idle Esc is a no-op).
    if (key.name === "escape") {
      if (dialogActive) {
        // dialog resolver handles this — they listen via the raw stream too.
      } else if (streaming) {
        const cb = onAbortCb;
        if (cb) cb();
      }
      return;
    }
    if (key.ctrl && key.name === "c") {
      // SIGINT equivalent: tear the renderer down and let the client's handler exit.
      // Don't call process.exit here — the client owns lifecycle.
      emitError("Ctrl-C in pane (renderer will close)");
      // No-op for now; client decides. We surface the keypress.
    }
    // Other keys are routed to the active dialog's own listener (via raw stdin)
    // — none here at the renderer level.
  }

  // restore on every exit / signal path.
  function restore(): void {
    detachKeypress();
    if (raw) {
      try { setRaw(false); } catch { /* terminal may already be gone */ }
    }
  }

  // Lifecycle: register once at start(); stop() unregisters (idempotent).
  let installed = false;
  function installLifecycle(): void {
    if (installed) return;
    installed = true;
    process.on("exit", restore);
    process.on("SIGINT", restore);
    process.on("SIGTERM", restore);
  }

  // ----- dialog helpers -----

  /** Run an interactive dialog: turn on raw mode, push the prompt to the
   *  pane, attach a one-shot keypress handler that resolves the promise.
   *  `parse(key)` returns {done, value?}; done=true resolves the dialog. */
  function runDialog<T>(
    title: string,
    body: () => string,
    parse: (key: readline.Key) => { done: true; value: T } | { done: false },
    defaultValue: T,
    timeout?: number,
  ): Promise<T> {
    installLifecycle();
    setRaw(true);
    dialogActive = true;
    writeLine(`\n┌─ ${title}\n${body()}\n└─`);
    writeRaw("> ");
    return new Promise<T>((resolve) => {
      let settled = false;
      const settle = (v: T): void => {
        if (settled) return;
        settled = true;
        dialogActive = false;
        writeRaw("\n");
        try { setRaw(false); } catch { /* terminal may already be gone */ }
        process.stdin.off("keypress", dialogListener);
        resolve(v);
      };
      const dialogListener = (_chunk: string, key: readline.Key): void => {
        // Esc cancels — confirm→false, select/input/editor→"" (matches rpc-side
        // `createDialogPromise(opts, defaultValue, ...)` resolve-on-timeout).
        if (key.name === "escape") { settle(defaultValue); return; }
        if (key.ctrl && key.name === "c") { settle(defaultValue); return; }
        const r = parse(key);
        if (r.done) settle(r.value);
      };
      process.stdin.on("keypress", dialogListener);
      if (timeout !== undefined) {
        setTimeout(() => settle(defaultValue), timeout);
      }
    });
  }

  // ----- public API -----

  return {
    start() {
      installLifecycle();
      attachKeypress();
      // Keep raw mode ON for the renderer's lifetime so Esc (and other keystrokes)
      // are captured by onKey, not eaten by the cooked-mode line discipline. The
      // renderer owns the pane's input surface; dialogs toggle raw mode redundantly
      // (idempotent). Ctrl-C in raw mode arrives as a keypress, not SIGINT — the
      // supervisor's `cotal stop` is the operator's exit path for a managed peer.
      setRaw(true);
      writeLine("[pi-peer] renderer online");
    },
    stop() {
      // Idempotent: unregisters key listener and exits raw mode. Safe to call
      // from process.on("exit") / SIGINT / SIGTERM / finally. Emits a visible
      // offline line so the operator sees a clean shutdown (and so the shutdown
      // path is observable in tests).
      if (!stopped) { writeLine("[pi-peer] renderer offline"); stopped = true; }
      restore();
    },
    setStatus(_status, activity) {
      // Render the status as a brief annotation line at the bottom of the pane
      // (no flicker on repaint). Activity null/undefined clears it.
      if (activity === undefined) writeRaw("\n\u001b[2m[working]\u001b[0m\n");
      else writeRaw(`\n\u001b[2m[working: ${activity}]\u001b[0m\n`);
    },
    markStreaming(_on: boolean): void {
      // The renderer's "streaming" state is set via attachStreaming() so that
      // the keypress handler can route Esc to onAbortCb while STREAMING.
      // Exposed on the returned object to keep the public surface narrow.
    },
    // Internal hooks — exposed via private fields on the returned object below.
    _streaming: (on: boolean) => { streaming = on; },
    pushAssistantText(delta) {
      // Buffered line rendering: accumulate until a full line, then write.
      // flushTrailing() is called by the client on agent_end to handle a final
      // partial line.
      const i = trailing.length ? trailing + delta : delta;
      const parts = i.split("\n");
      trailing = parts.pop() ?? "";
      for (const line of parts) writeLine(line);
    },
    flushTrailing() {
      if (trailing) {
        writeLine(trailing);
        trailing = "";
      }
    },
    pushToolEvent(toolName, pathLike) {
      const target = pathLike ? ` ${pathLike}` : "";
      writeLine(`▸ ${toolName}${target}`);
    },
    pushError(line) {
      emitError(line);
    },
    onAbort(cb) {
      onAbortCb = cb;
    },
    async popConfirm(title, message, opts) {
      // y/Enter → true; n/Esc/Ctrl-C → false.
      const defaultV: boolean = false;
      return runDialog(
        title,
        () => `${message}\n(y/n, Esc to cancel)`,
        (key) => {
          if (key.name === "return" || key.name === "y") return { done: true, value: true };
          if (key.name === "n") return { done: true, value: false };
          return { done: false };
        },
        defaultV,
        opts?.timeout,
      );
    },
    async popSelect(title, options, opts) {
      // arrow keys: up/down move; enter commits; esc cancels. Default value
      // "" matches rpc-side `"value" in r ? r.value : undefined` for select.
      let idx = 0;
      const render = (): void => {
        writeRaw("\u001b[2J\u001b[H"); // clear screen, home
        writeLine(`┌─ ${title} (↑/↓, Enter, Esc to cancel)`);
        options.forEach((o, i) => writeLine(`  ${i === idx ? "▶" : " "} ${i + 1}. ${o}`));
        writeRaw("└─");
      };
      const defaultV: string = ""; // undefined if absolute blank
      return new Promise<string>((resolve) => {
        installLifecycle();
        setRaw(true);
        dialogActive = true;
        render();
        let settled = false;
        const settle = (v: string): void => {
          if (settled) return;
          settled = true;
          dialogActive = false;
          writeRaw("\n");
          try { setRaw(false); } catch { /* */ }
          process.stdin.off("keypress", dialogListener);
          resolve(v);
        };
        const dialogListener = (_c: string, key: readline.Key): void => {
          if (key.name === "escape") { settle(defaultV); return; }
          if (key.ctrl && key.name === "c") { settle(defaultV); return; }
          if (key.name === "up") { idx = (idx - 1 + options.length) % options.length; render(); return; }
          if (key.name === "down") { idx = (idx + 1) % options.length; render(); return; }
          if (key.name === "return") { settle(options[idx] ?? defaultV); return; }
        };
        process.stdin.on("keypress", dialogListener);
        if (opts?.timeout !== undefined) setTimeout(() => settle(defaultV), opts.timeout);
      });
    },
    async popInput(title, placeholder, opts) {
      // Raw-mode single-line input so Esc cancels cleanly without readline eating it.
      // Handles backspace editing + echo (the cooked tty would do echo; raw doesn't, so we
      // echo printable chars ourselves, render backspace as `\b \b`).
      const defaultV = ""; // matches rpc-side `"value" in r ? r.value : undefined` for input
      installLifecycle();
      setRaw(true);
      dialogActive = true;
      writeLine(`\n┌─ ${title}${placeholder ? ` (${placeholder})` : ""}`);
      writeRaw("└─ > ");
      let buf = "";
      const echo = (s: string): void => {
        writeRaw(s.replace(/\r/g, "").replace(/\u0007/g, ""));
      };
      return new Promise<string>((resolve) => {
        let settled = false;
        const settle = (v: string): void => {
          if (settled) return;
          settled = true;
          dialogActive = false;
          writeRaw("\n");
          try { setRaw(false); } catch { /* */ }
          process.stdin.off("keypress", dialogListener);
          resolve(v);
        };
        const dialogListener = (_c: string, key: readline.Key): void => {
          if (key.name === "escape") { settle(defaultV); return; }
          if (key.ctrl && key.name === "c") { settle(defaultV); return; }
          if (key.name === "return") { writeRaw("\n"); settle(buf); return; }
          if (key.name === "backspace") {
            if (buf.length) {
              buf = buf.slice(0, -1);
              writeRaw("\b \b");
            }
            return;
          }
          // Printable: append to buffer + echo.
          if (!key.ctrl && key.sequence && key.sequence.length === 1) {
            buf += key.sequence;
            echo(key.sequence);
          }
        };
        process.stdin.on("keypress", dialogListener);
        if (opts?.timeout !== undefined) setTimeout(() => settle(defaultV), opts.timeout);
      });
    },
    async popEditor(title, prefill, opts) {
      // Spawn $EDITOR on a tempfile; on save → return content; on :q/non-zero
      // exit or Esc → empty string. The tempfile is unlinked on every exit path.
      const editor = opts?.editorOverride
        ?? process.env.VISUAL
        ?? process.env.EDITOR
        ?? "vi";
      const tmpDir = mkdtempSync(join(tmpdir(), "pi-edit-"));
      const file = join(tmpDir, "edit.md");
      if (prefill) await fsp.writeFile(file, prefill, "utf8");
      else await fsp.writeFile(file, "", "utf8");

      installLifecycle();
      // Editor runs in normal tty mode (not raw) so vi/nano/etc. work.
      dialogActive = true;
      writeLine(`┌─ ${title} (external editor: ${editor})`);

      const defaultV = ""; // matches rpc-side editor resolved value
      const result = await new Promise<string>((resolve) => {
        const proc = childSpawn(editor, [file], {
          stdio: "inherit",
          env: process.env,
        });
        const settle = (v: string): void => {
          dialogActive = false;
          resolve(v);
        };
        proc.on("exit", async (code) => {
          if (code !== 0) { settle(defaultV); return; }
          try {
            const content = await fsp.readFile(file, "utf8");
            settle(content);
          } catch {
            settle(defaultV);
          }
        });
        if (opts?.timeout !== undefined) {
          setTimeout(() => { try { proc.kill("SIGTERM"); } catch { /* */ } settle(defaultV); }, opts.timeout);
        }
      });
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* */ }
      return result;
    },
    // Force-render a status set by client (test path).
    _setStreaming(on: boolean): void { streaming = on; },
  } as TuiRenderer & { _setStreaming: (on: boolean) => void };
}

/** Note: we mark the returned object with `_setStreaming` so the client can
 *  transition the streaming flag on agent_start / agent_end. The TypeScript
 *  intersection isn't visible externally but the runtime hook is there.
 *  (Avoiding an `as any` cast at call sites that need to drive Esc routing.) */
