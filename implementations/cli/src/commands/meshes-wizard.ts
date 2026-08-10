import * as p from "@clack/prompts";
import { findMesh, type MeshEntry } from "@cotal-ai/workspace";
import { bold, brand, brandBold, dim, ok } from "../lib/theme.js";
import { abortIfCancel } from "../lib/cancel.js";
import {
  candidateTarget,
  checkDialPolicy,
  checkEnforcement,
  checkMode,
  checkRoot,
  checkServer,
  checkTrust,
  isDir,
  probeEnforcement,
  spacesAtRoot,
  verifyTarget,
  writeRecord,
} from "./meshes-add.js";

/**
 * The guided form of `cotal meshes add` — a bare `cotal meshes add` on a terminal.
 *
 * It exists because the flag form asks the operator to already know four things: the broker
 * address, whether that broker authenticates, which space name to use, and that credentials must
 * be copied locally first. Three of those the machine can find out, so this asks for the ONE that
 * cannot be derived (the address), then probes and reports what it learned. Every question after
 * that is a choice between real options rather than free text: the space names come from the trust
 * actually on disk, and the mode is stated as a fact about the broker, never asked.
 *
 * The rules are not re-implemented here. Every decision goes through `meshes-add.ts`, so the
 * guided and flag forms cannot drift; this module owns presentation and recovery only — which
 * failures offer a way out (a wrong URL is worth retyping; a mesh that is simply down is worth
 * recording anyway) instead of ending the command.
 */

/**
 * The prompts, as an interface rather than direct clack calls.
 *
 * Not indirection for its own sake: the wizard's VALUE is its control flow — does a name that came
 * from the command line still hit the clash gate, does "point at a different folder" actually ask
 * for one, does a replacement still get verified — and every one of those questions was answered
 * wrong at least once. None of it is reachable by a test that cannot answer a prompt, so the review
 * that caught those bugs was doing work the suite structurally could not. With the prompts injected,
 * a test drives the real function with scripted answers and asserts what it asked and what it wrote.
 */
export interface WizardIO {
  intro(message: string): void;
  outro(message: string): void;
  note(body: string, title: string): void;
  cancel(message: string): void;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  spinner(): { start(m: string): void; stop(m: string): void };
  text(opts: { message: string; placeholder?: string; validate?: (v: string | undefined) => string | undefined }): Promise<string>;
  select<T>(opts: { message: string; options: { value: T; label: string; hint?: string }[] }): Promise<T>;
  confirm(opts: { message: string }): Promise<boolean>;
}

/** The real terminal, via clack. Cancellation (Ctrl-C / Esc) exits here rather than returning a
 *  sentinel the wizard body would have to thread through every branch. */
export function clackIO(): WizardIO {
  return {
    intro: (m) => p.intro(m),
    outro: (m) => p.outro(m),
    note: (body, title) => p.note(body, title),
    cancel: (m) => p.cancel(m),
    log: { info: (m) => p.log.info(m), warn: (m) => p.log.warn(m), error: (m) => p.log.error(m) },
    spinner: () => {
      const s = p.spinner();
      return { start: (m) => s.start(m), stop: (m) => s.stop(m) };
    },
    text: async (opts) => abortIfCancel(await p.text(opts as never)),
    select: async <T>(opts: { message: string; options: { value: T; label: string; hint?: string }[] }) =>
      abortIfCancel(await p.select<T>(opts as never)) as T,
    confirm: async (opts) => abortIfCancel(await p.confirm({ ...opts, initialValue: true })),
  };
}

/** Whether a guided run is possible at all: both ends of the pipe must be a real terminal. Without
 *  this a missing flag would hang a script waiting on input nobody is there to give; the flag form
 *  keeps failing loud instead. */
export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && process.env.COTAL_NO_PROMPT !== "1";
}

/** Pre-filled from whatever the command line already supplied, so a half-typed command completes
 *  itself rather than starting over. */
export interface WizardSeed {
  space?: string;
  server?: string;
  root?: string;
  mode?: string;
  force?: boolean;
}

/** Run the guided registration. Returns false if the operator backed out (the caller exits 0 —
 *  cancelling is not a failure). */
export async function addWizard(seed: WizardSeed, cwd: string, io: WizardIO = clackIO()): Promise<boolean> {
  io.intro(brandBold("Register a mesh"));
  io.note(
    "A mesh running somewhere else - another machine, a shared broker, a hosted space - so that\n`cotal spawn` and `--space` can reach it from any folder on this machine.\n\nNothing is written until you confirm.",
    brand("What this does"),
  );

  // TWO different decisions, deliberately not one flag. `--force` conflates them for the scripted
  // form (documented there), but here they are reached separately and must stay separate:
  // `unverified` means the operator accepted a record nothing confirmed; `replace` means an
  // existing record for that name is being overwritten. Folding replace into unverified would
  // silently skip the broker checks for anyone who picked "replace that record" — a record
  // presented as checked that never was, which is the failure this command exists to refuse.
  let unverified = Boolean(seed.force);
  let replace = Boolean(seed.force);

  // ── 1. the one thing that cannot be derived ────────────────────────────────────────────────────
  let server = seed.server;
  let enforces: "auth" | "open" | "unreachable" = "unreachable";

  for (;;) {
    if (!server) {
      server = await io.text({
          message: "Broker URL of the mesh you want to reach",
          placeholder: "nats://100.90.12.34:4222",
          validate: (v) => {
            if (!v) return "Required - this is the address the mesh's broker listens on.";
            const r = checkServer(v);
            if (!r.ok) return r.message.replace(/^✗ (--server )?/, "");
            // The same safety gate the flag form applies, asked here so a refused address is
            // caught at the prompt instead of after the operator has answered three more
            // questions. Both front ends must agree; that is what this module exists for.
            const d = checkDialPolicy(v);
            return d.ok ? undefined : d.message.replace(/^✗ /, "");
          },
        });
    } else {
      const pre = checkServer(server);
      if (!pre.ok) {
        io.log.error(pre.message);
        server = undefined;
        continue;
      }
      const dial = checkDialPolicy(server);
      if (!dial.ok) {
        io.log.error(dial.message);
        server = undefined;
        continue;
      }
    }

    // A permitted-but-not-guaranteed target is said out loud here too, not only in the flag form.
    // Recomputed rather than threaded because the typed path validates inside its own callback:
    // the check is pure, and one call site for the warning beats two ways of reaching it.
    const settled = checkDialPolicy(server);
    if (settled.ok && settled.value.residual) io.log.warn(settled.value.residual);

    const spin = io.spinner();
    spin.start(`Asking ${server} what it is`);
    enforces = await probeEnforcement(server);
    spin.stop(
      enforces === "auth"
        ? `${ok("✓")} ${server} answered - it ${bold("requires credentials")}`
        : enforces === "open"
          ? `${ok("✓")} ${server} answered - it is ${bold("open")} (accepts anyone)`
          : `${server} did not answer`,
    );
    if (enforces !== "unreachable") break;

    const next = await io.select({
        message: "No broker answered there.",
        options: [
          { value: "retype", label: "Use a different address", hint: "typo, wrong port, VPN not up" },
          { value: "anyway", label: "Register it anyway", hint: "the mesh is down right now; nothing is verified" },
          { value: "cancel", label: "Cancel" },
        ],
      });
    if (next === "cancel") return cancelled(io);
    if (next === "anyway") {
      unverified = true;
      break;
    }
    server = undefined;
  }

  // ── 2. where this mesh's local trust + personas live ───────────────────────────────────────────
  // A LOOP, not a recursive re-entry: "point at a different folder" has to actually ask for one.
  // Clearing the answer and inferring again would land on the same project root inside a project,
  // re-hit the same dead end, and offer the same useless choice forever.
  const inferred = checkRoot(seed.root, cwd);
  let root = inferred.ok ? inferred.value : undefined;
  if (root && !seed.root) io.log.info(`Using this project as its local folder: ${bold(root)}`);
  // The cwd is only a sensible default the FIRST time. After the operator has been told this
  // folder holds no credentials, offering it back pre-filled makes them clear the field to answer
  // the question at all — so the recovery ask starts empty and insists on a real path.
  let defaultRoot: string | undefined = cwd;
  let accounts: string[] = [];
  for (;;) {
    while (!root) root = await askRoot(io, cwd, defaultRoot);
    const inventory = spacesAtRoot(root);
    if (!inventory.ok) {
      // Unreadable trust is not "no trust": say so and let them point somewhere else.
      io.log.error(inventory.message);
      root = undefined;
      defaultRoot = undefined;
      continue;
    }
    accounts = inventory.value;
    // An auth broker with no trust here cannot be registered at all — say what is missing and where
    // it comes from, rather than failing after more questions.
    if (enforces !== "auth" || accounts.length > 0) break;
    io.log.warn(
      `That broker requires credentials, and ${bold(root)} holds none.\n` +
        dim("Copy the mesh's .cotal/auth from the machine it runs on (or `cotal mint` there), then point at that folder."),
    );
    const next = await io.select({
        message: "That folder holds no credentials for this broker. What next?",
        options: [
          { value: "root", label: "Point at a different folder", hint: "one that already holds its credentials" },
          { value: "cancel", label: "Cancel" },
        ],
      });
    if (next === "cancel") return cancelled(io);
    root = undefined; // ask for a path; never re-infer, or this offers the same dead end again
    defaultRoot = undefined; // …and never offer the folder we just rejected as the default
  }

  // ── 3. which space ────────────────────────────────────────────────────────────────────────────
  // The clash gate runs for EVERY resolved name, including one that came in on the command line.
  // Gating it on "did we just ask?" let `cotal meshes add <already-registered>` overwrite silently —
  // something the flag form refuses outright.
  let space = seed.space;
  for (;;) {
    while (!space) {
      if (accounts.length > 0) {
        const picked = await io.select<string | null>({
            message: "Which space on that broker?",
            options: [
              ...accounts.map((s) => ({ value: s as string | null, label: s, hint: "credentials for this space are already here" })),
              { value: null, label: "Another name…" }, // null, not a sentinel string: no space name can collide with it
            ],
          });
        if (picked !== null) space = picked;
      }
      if (!space) {
        space = await io.text({
            message: "Space name on that broker",
            placeholder: "the name the mesh was started with",
            validate: (v) => (v ? undefined : "Required - it must match the space name where the mesh runs."),
          });
      }
    }
    const clash = findMesh(space);
    if (!clash || replace) break;
    const next = await io.select({
        message: `"${space}" is already registered here (${clash.server}).`,
        options: [
          { value: "replace", label: "Replace that record", hint: clash.root },
          { value: "rename", label: "Use a different name" },
          { value: "cancel", label: "Cancel" },
        ],
      });
    if (next === "cancel") return cancelled(io);
    if (next === "rename") space = undefined;
    else {
      replace = true;
      break;
    }
  }

  // ── 4. mode + trust, decided rather than asked ─────────────────────────────────────────────────
  // The probe's answer is the best evidence of the mode — but only when the broker actually
  // answered. An UNREACHABLE broker knows nothing, and reading "not auth" out of silence would
  // record an auth mesh as open (the exact wrong-mode failure this command is built to refuse); so
  // fall back to the same on-disk inference the flag form uses.
  const modeHint = seed.mode ?? (enforces === "unreachable" ? undefined : enforces);
  const modeCheck = checkMode(space, root, accounts, modeHint);
  if (!modeCheck.ok) {
    io.log.error(modeCheck.message);
    return cancelled(io, "Nothing was registered.");
  }
  const mode = modeCheck.value;
  const trust = checkTrust(mode, root, space);
  if (!trust.ok) {
    io.log.error(trust.message);
    return cancelled(io, "Nothing was registered.");
  }
  if (!unverified) {
    const match = checkEnforcement(mode, enforces, server as string, space, root);
    if (!match.ok) {
      io.log.error(match.message);
      return cancelled(io, "Nothing was registered.");
    }
  }

  // ── 5. verify for real, then confirm ──────────────────────────────────────────────────────────
  if (!unverified) {
    const target = candidateTarget(space, server as string, root, mode, trust.value);
    const spin = io.spinner();
    spin.start(mode === "auth" ? `Checking this folder's credentials for "${space}"` : `Checking the connection to "${space}"`);
    const verified = await verifyTarget(target);
    spin.stop(verified.ok ? `${ok("✓")} ${mode === "auth" ? "Credentials accepted" : "Connected"}` : "Could not connect");
    if (!verified.ok) {
      io.log.error(verified.message);
      const next = await io.select({
          message: "The check did not pass. What next?",
          options: [
            { value: "anyway", label: "Register it anyway", hint: "the record will say it was not verified" },
            { value: "cancel", label: "Cancel" },
          ],
        });
      if (next === "cancel") return cancelled(io, "Nothing was registered.");
      unverified = true;
    }
  }

  io.note(
    [
      `${dim("space ")}  ${bold(space)}`,
      `${dim("broker")}  ${server}`,
      `${dim("mode  ")}  ${mode}${unverified ? dim("  (not verified - the broker was not reachable/checked)") : dim(mode === "auth" ? "  (broker enforces credentials)" : "  (broker is open)")}`,
      ...(replace ? [`${dim("note  ")}  ${bold("replaces")} the existing record for "${space}"`] : []),
      `${dim("folder")}  ${root}`,
    ].join("\n"),
    brand("About to record"),
  );
  const go = await io.confirm({ message: "Register this mesh?" });
  if (!go) return cancelled(io, "Nothing was registered.");

  const entry: MeshEntry = { space, server: server as string, root, mode, origin: "manual", ts: new Date().toISOString() };
  const result = writeRecord(entry);

  // Padded from the rendered widths, not a guess: the commands carry the space name, so a
  // hard-coded gutter misaligns for every name but the one it was written against.
  const rows: [string, string][] = [
    result.adoptedCurrent
      ? ["cotal spawn", "launch an agent into it (it is now the default)"]
      : [`cotal use ${space}`, "make it the default a bare spawn joins"],
    [`cotal status --space ${space}`, "check it"],
    [`cotal meshes rm ${space}`, "forget it again (never stops the mesh)"],
  ];
  const width = Math.max(...rows.map(([cmd]) => cmd.length));
  io.note(rows.map(([cmd, why]) => `${bold(cmd.padEnd(width))}  ${dim(why)}`).join("\n"), brand("What you can do now"));
  io.outro(ok(`Registered "${space}"${result.keptCurrent ? ` - "${result.keptCurrent}" is still the default` : ""}`));
  return true;
}

/** Ask for the folder, re-asking until it resolves. `defaultTo` is accepted on an empty answer;
 *  without one, an empty answer is a non-answer rather than a silent fallback. */
async function askRoot(io: WizardIO, cwd: string, defaultTo: string | undefined): Promise<string> {
  for (;;) {
    const typed = await io.text({
        message: "Local folder for this mesh's credentials and personas",
        placeholder: defaultTo ?? "the folder holding its .cotal/auth",
        validate: (v) => {
          const candidate = v || defaultTo;
          if (!candidate) return "Required - the folder that holds this mesh's .cotal/auth and .cotal/agents.";
          return isDir(candidate) ? undefined : "Not a directory - it must already exist.";
        },
      });
    const r = checkRoot(typed || (defaultTo as string), cwd);
    if (r.ok) return r.value;
    io.log.error(r.message);
  }
}

function cancelled(io: WizardIO, message = "Cancelled."): false {
  io.cancel(message);
  return false;
}
