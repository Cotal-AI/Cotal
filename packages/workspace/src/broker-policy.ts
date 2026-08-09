/**
 * The broker LAUNCH POLICY: how this mesh's broker must be served, recorded durably so that every
 * later `up` renders the same transport.
 *
 * Why this is a separate record from the mesh registry entry. `MeshEntry` lives in the machine
 * home and carries TLS-required CLIENT INTENT only — enough for a resolved connection to become
 * strict, and nothing an operator would mind seeing. It is also removed by `cotal down`, so it
 * cannot be where the broker's own configuration lives: a bare `down` followed by `up` would
 * forget that this broker serves TLS and quietly bring it back up in cleartext. That is the silent
 * downgrade, arriving by the most ordinary operator gesture there is.
 *
 * So cert and key REFERENCES live here instead, under the workspace root's protected tree, beside
 * `auth/` rather than inside it — `auth/broker.json` already means broker TRUST, and two things
 * one letter apart in meaning in the same directory is how a later reader composes the wrong pair.
 *
 * WHY THE TIGHT DIRECTORY, and this is the part that must not be optimised away: the paths in this
 * file are NOT secret. The private key they point at is, and it belongs to the operator or their
 * PKI, not to us. The protection here is for INTEGRITY, not confidentiality — ANYONE WHO CAN
 * REWRITE THIS FILE CAN POINT THE BROKER AT A CERTIFICATE THEY CONTROL ON THE NEXT `up`. A reader
 * who opens it, correctly observes that it holds no secrets, and relaxes the permissions on that
 * entirely sensible-sounding basis would be handing over the broker's identity.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic, type BrokerTransport } from "@cotal-ai/core";

/** What was recorded about how this broker is served. */
export interface BrokerPolicy {
  /** Schema version, so a future reader can refuse a shape it does not understand rather than
   *  guess at one. */
  readonly version: 1;
  readonly transport: BrokerTransport;
}

/** Thrown for every unreadable, unparseable or unusable policy. Distinct so callers can report a
 *  POLICY cause and refuse, instead of reporting a generic failure and continuing. */
export class BrokerPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerPolicyError";
  }
}

/** `<root>/.cotal/broker-policy.json` — a sibling of `auth/`, `run/`, `nats/` and `agents/`. */
export function brokerPolicyPath(root: string): string {
  return join(root, ".cotal", "broker-policy.json");
}

/** Record how this broker is served. The parent directory is hardened BEFORE the file lands, and
 *  the write is atomic so a crashed `up` cannot leave a half-written policy that the next `up`
 *  would have to interpret. */
export function writeBrokerPolicy(root: string, policy: BrokerPolicy): void {
  const path = brokerPolicyPath(root);
  mkSecretDir(join(root, ".cotal"));
  writeSecretFileAtomic(path, `${JSON.stringify(policy, null, 2)}\n`);
}

/**
 * Read the recorded policy, or `undefined` when this mesh has none — a mesh created before the
 * policy existed, or one that was never given a transport to remember.
 *
 * FAILS LOUD on a policy it cannot trust, and never degrades to plaintext. The absence of a file
 * and the presence of a broken one are different situations: the first means "no decision was
 * recorded", the second means "a decision was recorded and I cannot honour it". Treating the
 * second as the first is how a mesh that was deliberately put on TLS comes back up in cleartext
 * because a cert file moved — reachable by an operator who did nothing wrong.
 */
export function readBrokerPolicy(root: string): BrokerPolicy | undefined {
  const path = brokerPolicyPath(root);
  if (!existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new BrokerPolicyError(`broker policy at ${path} exists but is not readable: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new BrokerPolicyError(`broker policy at ${path} is not valid JSON: ${(e as Error).message}`);
  }

  const doc = parsed as Partial<BrokerPolicy>;
  if (doc.version !== 1)
    throw new BrokerPolicyError(`broker policy at ${path} has unsupported version ${JSON.stringify(doc.version)}; expected 1`);

  const t = doc.transport;
  if (!t || typeof t !== "object")
    throw new BrokerPolicyError(`broker policy at ${path} is missing its transport`);

  if (t.kind === "plaintext") return { version: 1, transport: { kind: "plaintext" } };

  if (t.kind !== "tls-required")
    throw new BrokerPolicyError(`broker policy at ${path} names an unknown transport ${JSON.stringify((t as { kind?: unknown }).kind)}`);

  if (typeof t.certFile !== "string" || typeof t.keyFile !== "string" || !t.certFile || !t.keyFile)
    throw new BrokerPolicyError(`broker policy at ${path} declares TLS but does not name both a certFile and a keyFile`);

  // The referenced material must still be there. A cert that moved is the ordinary way this breaks,
  // and the ONLY acceptable outcome is a loud refusal: coming up in cleartext because a path went
  // stale would silently undo a deliberate decision to serve TLS.
  for (const [what, file] of [["certificate", t.certFile], ["private key", t.keyFile]] as const) {
    if (!existsSync(file))
      throw new BrokerPolicyError(
        `broker policy at ${path} requires TLS, but its ${what} is missing at ${file}. ` +
        `Restore it or record a new policy; this broker will NOT be started in plaintext.`,
      );
  }

  return { version: 1, transport: { kind: "tls-required", certFile: t.certFile, keyFile: t.keyFile } };
}
