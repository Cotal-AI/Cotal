/**
 * Cotal lifecycle hook relay — stateless.
 *
 * The agent runtime runs a hook on a lifecycle event and pipes the event JSON (which
 * includes `hook_event_name`) on stdin. We forward it to this session's connector over
 * its local control socket and print the reply for the runtime to apply. It must NEVER
 * block the session: any error → exit 0, no output. The Claude Code hook
 * entry points are one-liners over {@link runHookRelay}.
 */
import { connect } from "node:net";
import { controlFromEnv, hasIdentity } from "./config.js";
import { HANDOFF_RECEIPT } from "./control.js";

const TIMEOUT_MS = 2000;

/**
 * One bounded warning per hook process, on stderr, with no values in it.
 *
 * FAIL OPEN IS NOT THE SAME AS FAIL SILENT, and this relay was doing both. A hook that throws is a
 * hook that blocked a human's session, so the catch below stays. But a material file that is
 * missing, permissive, malformed, or contradicted by a direct carrier used to produce a hook that
 * did nothing and said nothing: the seat runs, presence never advances, no queued peer message is
 * ever injected, and there is no line anywhere to read. That is the same failure this connector's
 * Python counterpart shipped, one connector over, and it is why the repair is a WARNING rather than
 * a stricter refusal.
 *
 * Bounded means once per process, and the runtime starts one hook process per lifecycle event, so a
 * genuinely broken session keeps saying so. That is the intended trade: the alternative is a single
 * line early in a session that scrolls away, for a fault that persists until someone fixes the
 * launch. Nothing is interpolated into the message. The variable NAMES are the diagnosis and the
 * operator can read their own environment; a value in a hook's stderr is a disclosure in whatever
 * captures that stream.
 */
let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  try {
    process.stderr.write(`[cotal-connector] ${message}\n`);
  } catch {
    /* a hook that cannot even warn still must not block the session */
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(d));
  });
}

/**
 * Print the reply for the runtime and leave.
 *
 * `confirm` is the connector's delivery receipt. stdout to a pipe is async, so exit()ing right
 * after write() can truncate a large reply — we exit from the write callback, and a 1s backstop
 * guarantees we still leave if it never flushes. That backstop is the dangerous path: the connector
 * has already handed us peer messages, and if we die here they are gone from the runtime's point of
 * view. So the receipt is sent from the flush callback ONLY. A backstop exit sends nothing, the
 * connector scores the reply undelivered, and the batch stays un-acked for redelivery.
 */
function done(out: string, confirm?: (then: () => void) => void): void {
  const exit = (): void => process.exit(0);
  const t = out.trim();
  if (!t) return exit(); // fail open — never blocks the session
  // A failing stdout ALSO emits "error"; unhandled on a stream that throws, which would turn a
  // vanished runtime into a non-zero hook exit. The callback below is what decides the receipt; this
  // only keeps the promise that a hook never blocks the session.
  process.stdout.on("error", () => exit());
  // The callback fires on FAILURE too (EPIPE, ERR_STREAM_DESTROYED — a runtime that closed the pipe).
  // Confirming there would be the exact lie this receipt exists to prevent: a commit with zero bytes
  // delivered. Only a clean write earns the receipt; anything else exits silent and the batch
  // redelivers.
  process.stdout.write(t + "\n", (err?: Error | null) => {
    if (err || !confirm) return exit();
    confirm(exit);
  });
  setTimeout(exit, 1000);
}

/** Relay one hook event from stdin to the connector's control socket and print the reply. */
export async function runHookRelay(): Promise<void> {
  if (!hasIdentity()) return done(""); // plain session, not a managed one — no-op
  // The socket path comes from the launch env; the token comes from the launch-material file that
  // env points at (the same file the in-agent server reads), never recomputed from public identity.
  // A malformed or missing material file THROWS from controlFromEnv, and a hook that throws is a
  // hook that blocked the session, so it is caught here and treated as "no control session": fail
  // open is this relay's whole contract.
  let control: { path: string; token: string } | undefined;
  try {
    control = controlFromEnv();
  } catch {
    warnOnce(
      "this session's control endpoint could not be resolved: the launch material is missing, " +
        "unreadable, readable beyond its owner, malformed, or contradicted by direct COTAL_ variables. " +
        "Lifecycle relays are disabled for this session, so presence will not advance and queued peer " +
        "messages will not be injected. Check COTAL_LAUNCH_MATERIAL and COTAL_CONTROL_SOCKET.",
    );
    return done("");
  }
  // No control endpoint AT ALL is not a fault and is not warned about: a hand-driven session that
  // sets COTAL_NAME and never had a control socket is a legitimate launch, and warning here would
  // fire on every hook of a working session and teach the operator to ignore the channel.
  if (!control) return done("");
  const { path, token } = control;
  const raw = (await readStdin()).trim() || "{}";
  let event: unknown = {};
  try {
    event = JSON.parse(raw); // the hook event the runtime piped in
  } catch {
    /* malformed — relay an empty event under a valid token */
  }
  const sock = connect(path);

  let reply = "";
  let settled = false;
  const drop = (): void => {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  };
  const finish = (out: string): void => {
    if (settled) return;
    settled = true;
    drop();
    done(out);
  };
  /** Got a reply: keep the socket until stdout has flushed, then send the receipt down it. Anything
   *  that kills us first (the 1s backstop, the runtime SIGKILLing the hook) closes the socket with
   *  no receipt, which is exactly the signal the connector needs to NOT commit the batch. */
  const finishWithReceipt = (out: string): void => {
    if (settled) return;
    settled = true;
    done(out, (then) => {
      try {
        sock.write(HANDOFF_RECEIPT, () => {
          drop();
          then();
        });
      } catch {
        then(); // connector already gone; it scores this undelivered and redelivers
      }
    });
  };
  const timer = setTimeout(() => finish(""), TIMEOUT_MS);

  sock.setEncoding("utf8");
  // `handoff` opts into the confirmed-delivery protocol: the connector holds the connection open and
  // treats our receipt, not its own socket write, as proof the reply reached the runtime.
  sock.on("connect", () => sock.write(JSON.stringify({ token, event, handoff: true }) + "\n"));
  sock.on("data", (d) => {
    reply += d;
    const nl = reply.indexOf("\n");
    if (nl >= 0) {
      clearTimeout(timer);
      finishWithReceipt(reply.slice(0, nl));
    }
  });
  sock.on("error", () => {
    clearTimeout(timer);
    finish(""); // connector not running — no-op
  });
  sock.on("end", () => {
    clearTimeout(timer);
    finish(reply);
  });
}
