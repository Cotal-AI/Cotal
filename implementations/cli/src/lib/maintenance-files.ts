import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { resolveAuthProvider, validateSpaceAuth } from "@cotal-ai/core";
import { authDir, loadSpaceAuth, userAuthStateDir, workspaceSecretStore, type MaintenanceAuthMode } from "@cotal-ai/workspace";

export interface AuthorityFingerprint {
  mode: MaintenanceAuthMode;
  account: string;
  scheme: string;
  authoritySha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rootChainCommitment(root: string, space: string): { account: string; sha256: string } {
  const path = join(authDir(root), "auth.json");
  if (!existsSync(path)) throw new Error(`restore requires existing trust material: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`authority input is not a regular file: ${path}`);
  const auth = validateSpaceAuth(loadSpaceAuth(authDir(root)), space);
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
