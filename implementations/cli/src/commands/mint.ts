import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  agentFilePath,
  loadAgentFile,
  mintCreds,
  mkSecretDir,
  newIdentity,
  stripSpaceAuth,
  writeSecretFile,
  type Profile,
} from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { cotalRoot } from "../lib/paths.js";
import { c } from "../ui.js";

/** Out-of-band cred minting: generate an identity, sign a profile-scoped user JWT with the
 *  space's account signing key, and write a creds file the agent/observer loads to join.
 *  `--signer` instead emits a stripped signer file — only the account signing material
 *  (`space` + `account.pub` + `account.signingSeed`), no operator root-of-trust — to mount into a
 *  containerized manager so it can mint per-agent creds without holding the account-minting key. */
export async function mint(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      out: { type: "string" },
      signer: { type: "boolean" }, // emit a stripped signer file instead of agent/observer creds
      force: { type: "boolean" }, // (--signer) overwrite an existing signer file
      "allow-subscribe": { type: "string" }, // read ACL override (comma-separated)
      "allow-publish": { type: "string" }, // post ACL override (comma-separated)
    },
  });
  const dir = authDir(cotalRoot());

  // `--signer`: no identity, no name — strip this space's auth.json to its account signing material.
  if (values.signer) {
    const auth = loadSpaceAuth(dir);
    if (!auth) {
      console.error(c.red("no space auth found here — run `cotal up` first"));
      process.exit(1);
    }
    const out = resolve(values.out ?? "signer.json");
    if (existsSync(out) && !values.force) {
      console.error(c.red(`${out} already exists — pass --force to overwrite`));
      process.exit(1);
    }
    writeSecretFile(out, JSON.stringify(stripSpaceAuth(auth), null, 2));
    console.log(c.green(`✓ wrote signer for space "${auth.space}"`));
    console.log(c.dim(`  ${out}`));
    console.log(c.dim("  mount read-only at /workspace/.cotal/auth/auth.json in the container"));
    return;
  }

  const name = positionals[0];
  if (!name) {
    console.error(c.red("usage: cotal mint <name> --profile <agent|observer|admin> [--allow-subscribe a,b] [--allow-publish a,b] [--out <path>]"));
    process.exit(1);
  }
  const splitList = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const profile = (values.profile ?? "agent") as Profile;
  if (profile !== "agent" && profile !== "observer" && profile !== "admin") {
    console.error(c.red(`unknown profile "${profile}" — expected agent, observer, or admin`));
    process.exit(1);
  }
  const auth = loadSpaceAuth(dir);
  if (!auth) {
    console.error(c.red("no space auth found here — run `cotal up` first"));
    process.exit(1);
  }
  // For agents, derive the read/post ACLs AND role from the agent file if one exists (flags
  // override): allowSubscribe (read; defaults to subscribe) and allowPublish (post; default-deny);
  // role scopes the TASK-queue consumer to svc_<role>. observers/managers ignore all three.
  // NOTE: this mints CREDS only — the bind-only chat/DM/TASK durables are pre-created separately by
  // a privileged provisioner (`cotal up` / manager / `cotal spawn`), as for DM/TASK already.
  let allowSubscribe: string[] | undefined;
  let allowPublish: string[] | undefined;
  let role: string | undefined;
  if (profile === "agent") {
    const f = agentFilePath(cotalRoot(), name);
    const def = existsSync(f) ? loadAgentFile(f) : undefined;
    allowSubscribe = splitList(values["allow-subscribe"]) ?? def?.allowSubscribe ?? def?.subscribe;
    allowPublish = splitList(values["allow-publish"]) ?? def?.allowPublish;
    role = def?.role;
  }
  const identity = newIdentity();
  const creds = await mintCreds(auth, identity, profile, { allowSubscribe, allowPublish, role });
  const out = resolve(values.out ?? join(dir, "creds", `${name}.creds`));
  mkSecretDir(dirname(out));
  writeSecretFile(out, creds);
  console.log(c.green(`✓ minted ${profile} creds for "${name}"`));
  console.log(c.dim(`  id:    ${identity.id}`));
  console.log(c.dim(`  creds: ${out}`));
}
