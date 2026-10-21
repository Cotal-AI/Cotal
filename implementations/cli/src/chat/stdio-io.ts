/**
 * Framing for `cotal chat --stdio`: turns raw stdin bytes into bounded UTF-8 lines, and writes
 * records to stdout with backpressure. It does no protocol work and holds no authority; it feeds
 * {@link StdioParticipant} and drains its output. Only versioned NDJSON goes to stdout; every
 * diagnostic goes to stderr through the injected `diagnostic` callback, and never echoes a body.
 */
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { MAX_REQUEST_LINE, StdioParticipant, serializeRecord } from "./stdio.js";
import type { AdmittedChatSession, CloseReport } from "./session.js";

/** Bound on buffered output records waiting for a slow reader before input is paused. Provisional. */
export const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Split decoded text into complete lines. A line longer than {@link MAX_REQUEST_LINE} is discarded
 * up to its next newline, and reported once with no content. A trailing `\r` before `\n` is dropped
 * (CRLF input). StringDecoder decodes invalid UTF-8 as U+FFFD, which never splits a line. In ordinary
 * string content it can reach the request as U+FFFD; in an escape sequence or outside a string it
 * makes the JSON parse refuse.
 */
export class LineFramer {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discarding = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOversize: () => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.feed(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  /** End of input: flush a final unterminated line, if any. */
  end(): void {
    this.feed(this.decoder.end());
    if (this.discarding) {
      this.discarding = false;
      this.buffer = "";
      return;
    }
    if (this.buffer.length) {
      const line = this.buffer;
      this.buffer = "";
      this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }

  private feed(text: string): void {
    let start = 0;
    for (let nl = text.indexOf("\n", start); nl !== -1; nl = text.indexOf("\n", start)) {
      const piece = text.slice(start, nl);
      start = nl + 1;
      if (this.discarding) {
        this.discarding = false;
        this.buffer = "";
        continue;
      }
      const line = this.buffer + piece;
      this.buffer = "";
      if (line.length > MAX_REQUEST_LINE) {
        this.onOversize();
        continue;
      }
      this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (this.discarding) return;
    this.buffer += text.slice(start);
    if (this.buffer.length > MAX_REQUEST_LINE) {
      this.buffer = "";
      this.discarding = true;
      this.onOversize();
    }
  }
}

/**
 * Run one `--stdio` session over the given streams until stdin ends or the session ends.
 * Returns the close report. The caller owns admission (it passes an already admitted session)
 * and the process exit code; this function never exits the process.
 */
export async function runStdio(opts: {
  session: AdmittedChatSession;
  stdin: Readable;
  stdout: Writable;
  diagnostic: (line: string) => void;
}): Promise<CloseReport | undefined> {
  const { session, stdin, stdout, diagnostic } = opts;
  let pendingBytes = 0;
  let paused = false;
  let outputBroken = false;
  let outputErrorObserved = false;
  let finished = false;

  const onDrain = (): void => {
    paused = false;
    if (!finished && !outputBroken && !stdin.destroyed) stdin.resume();
  };
  const stopOutput = (): void => {
    if (outputBroken) return;
    outputBroken = true;
    stdout.off("drain", onDrain);
    diagnostic("stdout closed by the reader; ending the session");
    stdin.destroy();
  };
  const detachOutput = (): void => {
    // Buffered writes can settle after the session. A failed callback precedes its error event.
    if (finished && pendingBytes === 0 && (!outputBroken || outputErrorObserved))
      stdout.off("error", onOutputError);
  };
  const onOutputError = (): void => {
    outputErrorObserved = true;
    stopOutput();
    detachOutput();
  };
  stdout.on("error", onOutputError);

  const write = (line: string): void => {
    if (outputBroken) return;
    const bytes = Buffer.byteLength(line, "utf8");
    pendingBytes += bytes;
    const ok = stdout.write(line, (err) => {
      pendingBytes -= bytes;
      if (err) stopOutput();
      detachOutput();
    });
    // Backpressure: stop reading requests while the reader is behind, so output cannot grow unbounded.
    if ((!ok || pendingBytes > MAX_PENDING_OUTPUT_BYTES) && !paused) {
      paused = true;
      stdin.pause();
      stdout.once("drain", onDrain);
    }
  };

  try {
    let resolveEnded: (close: CloseReport) => void = () => {};
    const ended = new Promise<CloseReport>((r) => { resolveEnded = r; });
    const participant = new StdioParticipant(session, write, (close) => resolveEnded(close));
    const framer = new LineFramer(
      (line) => participant.acceptLine(line),
      () => write(serializeRecord({ schemaVersion: 1, type: "error", id: null, error: { code: "USAGE_INVALID", message: `request line exceeds ${MAX_REQUEST_LINE} characters; discarded` } })),
    );

    return await new Promise<CloseReport | undefined>((resolve) => {
      let done = false;
      const detach = (): void => {
        stdin.off("data", onData);
        stdin.off("end", finish);
        stdin.off("close", finish);
      };
      const finish = (): void => {
        if (done) return;
        done = true;
        detach();
        framer.end();
        participant.endOfInput().then(resolve, (e) => {
          diagnostic(`session close failed: ${(e as Error).message}`);
          resolve(undefined);
        });
      };
      // The session ended on its own (expiry, revocation, retirement): the end record is already
      // written. Stop reading; later input is not processed.
      void ended.then((close) => {
        if (done) return;
        done = true;
        detach();
        stdin.pause();
        resolve(close);
      });
      const onData = (chunk: Buffer | string): void => framer.push(chunk);
      stdin.on("data", onData);
      stdin.once("end", finish);
      stdin.once("close", finish);
      stdin.once("error", (e) => {
        diagnostic(`stdin error: ${e.message}`);
        finish();
      });
    });
  } finally {
    finished = true;
    stdout.off("drain", onDrain);
    detachOutput();
  }
}
