import { credsClaims } from "@cotal-ai/core";
import { REMINTABLE_DAEMON_CREDS, workspaceSecretStore, type OutputWarning } from "@cotal-ai/workspace";

/** A broker-only start has no local signer process renewing its standing daemon credentials. */
export async function noManagerCredentialWarning(root: string, space: string): Promise<OutputWarning> {
  const store = workspaceSecretStore(root);
  const windows: string[] = [];
  for (const { kind, key } of REMINTABLE_DAEMON_CREDS) {
    const name = kind;
    try {
      const bytes = await store.get(key(space));
      if (bytes === undefined) windows.push(`${name}: missing`);
      else {
        const exp = credsClaims(bytes).exp;
        windows.push(typeof exp === "number" && Number.isFinite(exp)
          ? `${name}: expires ${new Date(exp * 1000).toISOString()}`
          : `${name}: no bounded expiry`);
      }
    } catch {
      windows.push(`${name}: expiry could not be read`);
    }
  }
  return {
    code: "DAEMON_CREDENTIAL_RENEWAL_UNOWNED",
    target: { root, space },
    message: `--no-manager starts no local daemon-credential renewal owner. Unless a manager renews this same secret store, the daemon credentials expire without being re-signed (${windows.join("; ")}). The daemon only adopts re-signed credentials. Run \`cotal doctor auth\` to inspect them.`,
  };
}
