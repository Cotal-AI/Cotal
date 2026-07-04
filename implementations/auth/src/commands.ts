/**
 * Self-registering `login` / `logout` commands (the delivery-daemon pattern): importing
 * `@cotal-ai/auth` registers them into the core `Registry`, and the `cotal` binary pulls the
 * package in at its composition root. Session state lives under the workspace's `homeCotalDir()`
 * (`~/.cotal`, `COTAL_HOME`-overridable) — per human, per machine, NOT per checkout: you are
 * logged in as YOU across every repo on this box.
 */
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
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
 *  catch would re-throw it into a raw stack trace. Print the sentence, exit 1. */
async function legibly(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

async function runLogin(args: ParsedArgs): Promise<void> {
  const values = args.values as { idp?: string; "client-id"?: string };
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

async function runLogout(args: ParsedArgs): Promise<void> {
  const values = args.values as { idp?: string };
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
      // KEEP the local session on a failed revoke: the cached token is the only handle that can
      // retry the revoke from the CLI, and a still-live server-side session that can no longer be
      // revoked is worse than a lingering local cache. Fail loud with the recourse; the operator
      // re-runs `cotal logout`.
      throw new Error(
        `could not revoke the server-side session at ${idp} (${e instanceof Error ? e.message : String(e)}). ` +
          `Your local login is kept so you can retry \`cotal logout --idp ${idp}\`; if it keeps failing, revoke the session from the IdP directly.`,
      );
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
    flags: [
      { name: "idp", type: "string", value: "<auth base URL>", description: "Auth base URL, e.g. <origin>/api/auth" },
      { name: "client-id", type: "string", value: "<id>", description: "OAuth device-flow client id" },
    ],
    run: runLogin,
  },
  {
    kind: "command",
    name: "logout",
    group: "Identity",
    summary: "revoke the IdP session and clear the cached login --idp <auth base URL>",
    usage: "logout --idp <auth base URL>",
    flags: [
      { name: "idp", type: "string", value: "<auth base URL>", description: "Auth base URL, e.g. <origin>/api/auth" },
    ],
    run: runLogout,
  },
];

registry.register(...authCommands);
