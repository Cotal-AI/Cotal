import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { resolveAuthProvider, validateSpaceAuth } from "@cotal-ai/core";
import { authDir, brokerAuthPath, loadSpaceAuth, spaceAccountPath, userAuthStateDir, workspaceSecretStore, type MaintenanceAuthMode } from "@cotal-ai/workspace";

export interface AuthorityFingerprint {
  mode: MaintenanceAuthMode;
  account: string;
  scheme: string;
  authoritySha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`authority input is not a regular file: ${path}`);
}

function rootChainCommitment(root: string, space: string): { account: string; sha256: string } {
  const dir = authDir(root);
  const brokerFile = brokerAuthPath(dir);
  const accountFile = spaceAccountPath(dir, space);
  const legacyFile = join(dir, "auth.json");
  // Trust is now TWO records (broker + this space's account); a pre-split root still carries the
  // single monolith and is read as migration input. Guard whichever layout is actually on disk, with
  // the same regular-file posture. The committed hash below is unchanged either way: it composes the
  // same public fields, so `cotal-space-auth-root/v1` still verifies against existing artifacts.
  if (existsSync(brokerFile) || existsSync(accountFile)) {
    for (const p of [brokerFile, accountFile]) {
      if (!existsSync(p)) throw new Error(`restore requires existing trust material: ${p}`);
      assertRegularFile(p);
    }
  } else {
    if (!existsSync(legacyFile)) throw new Error(`restore requires existing trust material: ${brokerFile}`);
    assertRegularFile(legacyFile);
  }
  const auth = validateSpaceAuth(loadSpaceAuth(dir, space), space);
  // Commit only to validated public trust-chain material. Seeds remain outside the artifact while
  // every signed operator/system/data root and active data signer participates in drift detection.
  return {
    account: auth.account.pub,
    sha256: sha256(JSON.stringify({
      version: "cotal-space-auth-root/v1",
      space: auth.space,
      operatorJwt: auth.operator.jwt,
      account: {
        pub: auth.account.pub,
        jwt: auth.account.jwt,
        signingPub: auth.account.signingPub,
      },
      system: { pub: auth.sys.pub, jwt: auth.sys.jwt },
    })),
  };
}

/** Full artifacts bind to existing local trust without copying any secret into the artifact. */
export async function authorityFingerprint(root: string, space: string, mode: MaintenanceAuthMode): Promise<AuthorityFingerprint> {
  if (mode === "open") return {
    mode,
    account: "$G",
    scheme: "cotal-open-store/v1:sha256",
    authoritySha256: sha256(`open\0${space}`),
  };
  const rootChain = rootChainCommitment(root, space);
  if (mode === "user") {
    const provider = await resolveAuthProvider().trustFingerprint({ store: workspaceSecretStore(root), dir: userAuthStateDir(root, space), space });
    return {
      mode,
      account: rootChain.account,
      scheme: `cotal-user-authority/v2:${provider.scheme}`,
      authoritySha256: sha256(JSON.stringify({ rootChainSha256: rootChain.sha256, provider })),
    };
  }
  return {
    mode,
    account: rootChain.account,
    scheme: "cotal-static-authority/v2:sha256",
    authoritySha256: rootChain.sha256,
  };
}
