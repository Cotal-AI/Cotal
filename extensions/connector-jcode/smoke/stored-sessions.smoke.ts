/**
 * Empty `sessions/` is a local fact, not a reason to call list_sessions. Each accepting
 * branch of the inspect/panic/cause matchers has a refusing neighbour that differs only
 * by context.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JcodeSessionsEnumerationFailure } from "../src/startup-diagnostics.js";
import {
  boundStoredSessionCause,
  classifyStoredSessionPanic,
  inspectStoredSessions,
  isEmptyStoredSessionsDirectory,
} from "../src/stored-sessions.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-stored-sessions-"));
try {
  console.log("\n1. inspectStoredSessions: accepting empty directory, refusing neighbours");
  {
    const emptyHome = join(root, "empty");
    mkdirSync(join(emptyHome, "sessions"), { recursive: true, mode: 0o700 });
    const empty = inspectStoredSessions(emptyHome);
    check("an empty sessions directory is empty-directory", empty.kind === "empty-directory", empty);
    check("isEmptyStoredSessionsDirectory accepts only that kind", isEmptyStoredSessionsDirectory(empty));
  }
  {
    const absentHome = join(root, "absent");
    mkdirSync(absentHome, { recursive: true, mode: 0o700 });
    const absent = inspectStoredSessions(absentHome);
    check("a missing sessions path is absent, not empty", absent.kind === "absent", absent);
    check("a first-launch home is not treated as the empty-directory defect", !isEmptyStoredSessionsDirectory(absent));
  }
  {
    const populatedHome = join(root, "populated");
    mkdirSync(join(populatedHome, "sessions"), { recursive: true, mode: 0o700 });
    writeFileSync(join(populatedHome, "sessions", "session.json"), "{}");
    const populated = inspectStoredSessions(populatedHome);
    check("a directory with one file is populated, not empty", populated.kind === "populated" && populated.entries === 1, populated);
    check("populated is not the empty-directory defect", !isEmptyStoredSessionsDirectory(populated));
  }
  {
    const fileHome = join(root, "file");
    mkdirSync(fileHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(fileHome, "sessions"), "not-a-dir");
    const asFile = inspectStoredSessions(fileHome);
    check("a regular file at sessions is not-a-directory", asFile.kind === "not-a-directory", asFile);
    check("a file at sessions is not skipped as empty", !isEmptyStoredSessionsDirectory(asFile));
  }
  if (process.platform === "win32") {
    check("symlink refusal is unreachable on unsupported Windows", true);
    check("a sessions symlink is not skipped as empty", true);
  } else {
    const linkHome = join(root, "link");
    const target = join(root, "link-target");
    mkdirSync(join(target, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(linkHome, { recursive: true, mode: 0o700 });
    symlinkSync(join(target, "sessions"), join(linkHome, "sessions"));
    const linked = inspectStoredSessions(linkHome);
    check("a sessions symlink is not-a-directory even if the target is empty", linked.kind === "not-a-directory", linked);
    check("a sessions symlink is not skipped as empty", !isEmptyStoredSessionsDirectory(linked));
  }

  console.log("\n2. classifyStoredSessionPanic: one accepting panic, refusing neighbours");
  {
    const real =
      "thread 'tokio-runtime-worker' (1047612) panicked at crates/jcode-harness-api-server/src/translate.rs:1707:38:\nchunk size must be non-zero\n";
    const got = classifyStoredSessionPanic(real);
    check(
      "the real empty-directory panic is classified",
      got === "chunk size must be non-zero at crates/jcode-harness-api-server/src/translate.rs:1707:38",
      got,
    );
  }
  {
    const prose = "the docs say chunk size must be non-zero when the caller divides a list\n";
    check("prose that mentions the assertion is refused", classifyStoredSessionPanic(prose) === undefined);
  }
  {
    const otherSite =
      "thread 'tokio-runtime-worker' panicked at crates/other/src/foo.rs:12:1:\nchunk size must be non-zero\n";
    check("the same assertion at a different rust site is refused", classifyStoredSessionPanic(otherSite) === undefined);
  }
  {
    const otherMsg =
      "thread 'tokio-runtime-worker' panicked at crates/jcode-harness-api-server/src/translate.rs:1707:38:\nsomething else\n";
    check("a different assertion at translate.rs is refused", classifyStoredSessionPanic(otherMsg) === undefined);
  }
  {
    // Same filename, different crate. The old pattern matched any path ending in translate.rs, so
    // an unrelated crate's panic was reported to the operator as the stored-sessions defect.
    const foreignCrate =
      "thread 'tokio-runtime-worker' panicked at crates/unrelated/src/translate.rs:12:1:\nchunk size must be non-zero\n";
    check("the same filename in another crate is refused", classifyStoredSessionPanic(foreignCrate) === undefined, classifyStoredSessionPanic(foreignCrate));
  }
  {
    // Same basename reached by a suffix rather than a path boundary.
    const suffixed =
      "thread 'tokio-runtime-worker' panicked at crates/jcode-harness-api-server/src/my-translate.rs:9:9:\nchunk size must be non-zero\n";
    check("a filename merely ending in translate.rs is refused", classifyStoredSessionPanic(suffixed) === undefined, classifyStoredSessionPanic(suffixed));
  }
  {
    // No path at all: a bare filename is not the owning site either.
    const bare = "thread 'tokio-runtime-worker' panicked at translate.rs:1:1:\nchunk size must be non-zero\n";
    check("a bare translate.rs with no crate path is refused", classifyStoredSessionPanic(bare) === undefined, classifyStoredSessionPanic(bare));
  }

  console.log("\n3. boundStoredSessionCause: allow-listed phrases only");
  check("chunk-size panic text is reduced to the assertion", boundStoredSessionCause("x chunk size must be non-zero y") === "chunk size must be non-zero");
  check("connection-closed is kept", boundStoredSessionCause("harness connection closed") === "harness connection closed");
  check("write EPIPE is kept", boundStoredSessionCause("write EPIPE") === "write EPIPE");
  check("unrelated child text is not forwarded", boundStoredSessionCause("sk-live-secret-material") === "harness connection closed");

  console.log("\n4. named fatal carries the cause and path, never unknown");
  {
    const failure = new JcodeSessionsEnumerationFailure("/seat/sessions", "chunk size must be non-zero");
    check("the named failure uses sessions_enumeration_failed", failure.code === "sessions_enumeration_failed");
    check("the named failure names the path", failure.sessionsPath === "/seat/sessions");
    check("the named failure names the bounded cause", failure.causeText === "chunk size must be non-zero");
    check("a generic error is not this class", !(new Error("harness connection closed") instanceof JcodeSessionsEnumerationFailure));
  }

  console.log(`COTAL_SMOKE_SENTINEL cells=${pass} passed=${pass} failed=0`);
  console.log(`\nstored sessions: ${pass} passed, 0 failed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
