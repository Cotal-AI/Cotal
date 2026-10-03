/** The longest connector diagnostic kept: one line, enough for an error and the path it names. */
const DIAGNOSTIC_MAX = 240;
/** How much of the start of an unfinished output line is held while waiting for its end. */
const LINE_HEAD_MAX = 4096;

/** The last line in `text` that starts with a `[cotal-<name>]` or `[cotal-<name>/<part>]` prefix,
 *  with terminal escapes and control bytes removed. Connectors print their own diagnostics under
 *  that prefix; nothing else the child prints is kept, including a line that only quotes the prefix
 *  after other text. */
function lastConnectorDiagnostic(text: string): string | undefined {
  const plain = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
  const line = plain.match(/^ *\[cotal-[a-z0-9-]+(?:\/[a-z0-9-]+)?\][^\n]*/gm)?.at(-1)?.trim();
  if (!line) return undefined;
  return line.length > DIAGNOSTIC_MAX ? `${line.slice(0, DIAGNOSTIC_MAX)}…` : line;
}

/**
 * Keeps the last connector diagnostic a pty child printed, across arbitrary output chunks. Both pty
 * backends feed it, so a seat's exit reports the same diagnostic whichever one owned the child.
 */
export class ConnectorDiagnosticReader {
  private last: string | undefined;
  /** The start of the unfinished line the child may still be printing. */
  private lineHead = "";

  push(chunk: string): void {
    // Only complete lines are scanned, so a diagnostic split across chunks is read whole. The start
    // of an unfinished line is what is held, because its prefix decides whether it is a diagnostic.
    const text = this.lineHead + chunk;
    const cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
    if (cut >= 0 && text.lastIndexOf("[cotal-", cut) >= 0) this.last = lastConnectorDiagnostic(text.slice(0, cut)) ?? this.last;
    this.lineHead = text.slice(cut + 1, cut + 1 + LINE_HEAD_MAX);
  }

  /** The last diagnostic, counting a final line the child left unfinished. */
  read(): string | undefined {
    return lastConnectorDiagnostic(this.lineHead) ?? this.last;
  }
}
