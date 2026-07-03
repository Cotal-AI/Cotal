/**
 * Self-registering `login` / `logout` commands (the delivery-daemon pattern): importing
 * `@cotal-ai/auth` registers them into the core `Registry`, and the `cotal` binary pulls the
 * package in at its composition root. Session state lives under the workspace's `homeCotalDir()`
 * (`~/.cotal`, `COTAL_HOME`-overridable) — per human, per machine, NOT per checkout: you are
 * logged in as YOU across every repo on this box.
 */
import { parseArgs } from "node:util";
import { registry, type Command } from "@cotal-ai/core";
import { homeCotalDir } from "@cotal-ai/workspace";
import {
  deleteIdpSession,
  establishIdpSession,
  loadIdpSession,
  normalizeIdpUrl,
  revokeIdpSession,
} from "./login.js";

const DEFAULT_CLIENT_ID = "cotal-cli";

/** Every operational failure in these commands is a deliberately-legible thrown sentence
 *  (a refused client id, a revoked session, a malformed IdP response …) — the CLI's generic
 *  catch would re-throw it into a raw stack trace. Print the sentence, exit 1. parseArgs runs
 *  OUTSIDE this wrapper so usage errors keep runCli's usage formatting. */
async function legibly(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

async function runLogin(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { idp: { type: "string" }, "client-id": { type: "string" } },
  });
  if (!values.idp) {
    console.error("usage: cotal login --idp <auth base URL> [--client-id <id>]   (Better Auth: <origin>/api/auth)");
    process.exit(1);
  }
  const idpArg = values.idp;
  await legibly(async () => {
    const idp = normalizeIdpUrl(idpArg);
    // establishIdpSession proves the session mints user JWTs BEFORE persisting it — a failed
    // proof leaves no cache entry to fool requireIdpSession later.
    const { session, sub } = await establishIdpSession({
      dir: homeCotalDir(),
      idpUrl: idp,
      clientId: values["client-id"] ?? DEFAULT_CLIENT_ID,
      onPrompt: (p) => {
        console.log(`\nTo approve this sign-in, open:\n\n    ${p.verificationUriComplete}\n`);
        console.log(`(or go to ${p.verificationUri} and enter the code ${p.userCode})\n`);
        console.log(`Waiting for approval — the code expires in ${Math.ceil(p.expiresInSec / 60)} min. Ctrl-C to abort.`);
      },
    });
    console.log(
      `\nLogged in to ${idp} as ${sub}. Session cached in ${homeCotalDir()} until ${new Date(session.expiresAt * 1000).toISOString()}.`,
    );
  });
}

async function runLogout(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { idp: { type: "string" } } });
  if (!values.idp) {
    console.error("usage: cotal logout --idp <auth base URL>");
    process.exit(1);
  }
  const idpArg = values.idp;
  await legibly(async () => {
    const idp = normalizeIdpUrl(idpArg);
    const dir = homeCotalDir();
    const session = loadIdpSession(dir, idp);
    if (!session) {
      console.log(`not logged in to ${idp} — nothing to clear`);
      return;
    }
    try {
      await revokeIdpSession(idp, session.token);
    } catch (e) {
      // The local cache is cleared regardless — but a still-live server-side session is a real
      // leak, so the failure is reported loudly, never swallowed.
      deleteIdpSession(dir, idp);
      console.error(`local session cleared, but: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    deleteIdpSession(dir, idp);
    console.log(`Logged out of ${idp} — server-side session revoked, local cache cleared.`);
  });
}

const authCommands: Command[] = [
  {
    kind: "command",
    name: "login",
    group: "Identity",
    summary: "sign in to a space's IdP (device code) and cache the session --idp <auth base URL> [--client-id <id>]",
    usage: "login --idp <auth base URL> [--client-id <id>]",
    run: runLogin,
  },
  {
    kind: "command",
    name: "logout",
    group: "Identity",
    summary: "revoke the IdP session and clear the cached login --idp <auth base URL>",
    usage: "logout --idp <auth base URL>",
    run: runLogout,
  },
];

registry.register(...authCommands);
