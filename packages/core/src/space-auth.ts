import { decode, type Account, type Operator, Types } from "@nats-io/jwt";
import { fromPublic, fromSeed, type KeyPair } from "@nats-io/nkeys";
import type { SpaceAuth } from "./provision.js";
import { token } from "./subjects.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`validateSpaceAuth: ${field} must be an object`);
  return value as RecordValue;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`validateSpaceAuth: ${field} must be a non-empty string`);
  return value;
}

function publicKey(value: string, field: string, prefix: "A" | "O"): string {
  let pair: KeyPair | undefined;
  try {
    pair = fromPublic(value);
    const pub = pair.getPublicKey();
    if (!pub.startsWith(prefix)) throw new Error();
    return pub;
  } catch {
    throw new Error(`validateSpaceAuth: ${field} is not a valid ${prefix === "A" ? "account" : "operator"} public nkey`);
  } finally {
    pair?.clear();
  }
}

function seedPublicKey(value: string, field: string, prefix: "A" | "O"): string {
  let pair: KeyPair | undefined;
  try {
    pair = fromSeed(new TextEncoder().encode(value));
    const pub = pair.getPublicKey();
    if (!pub.startsWith(prefix)) throw new Error();
    return pub;
  } catch {
    throw new Error(`validateSpaceAuth: ${field} is not a valid ${prefix === "A" ? "account" : "operator"} seed`);
  } finally {
    pair?.clear();
  }
}

function claims<T>(jwt: string, field: string): ReturnType<typeof decode<T>> {
  try {
    const decoded = decode<T>(jwt);
    const now = Math.floor(Date.now() / 1000);
    if (decoded.aud !== "NATS") throw new Error();
    if (!Number.isSafeInteger(decoded.iat) || decoded.iat < 0) throw new Error();
    if (typeof decoded.jti !== "string" || decoded.jti.length === 0) throw new Error();
    if (decoded.exp !== undefined && (!Number.isSafeInteger(decoded.exp) || decoded.exp <= now)) throw new Error();
    if (decoded.nbf !== undefined && (!Number.isSafeInteger(decoded.nbf) || decoded.nbf > now)) throw new Error();
    return decoded;
  } catch {
    throw new Error(`validateSpaceAuth: ${field} is not a currently valid signed NATS JWT`);
  }
}

/**
 * Validate an existing full space trust bundle before a restore or other state mutation.
 *
 * This is read-only: it never generates, rotates, or signs key material, and returns the same
 * validated object. Persisted bundles may omit `sys.signingSeed`; when present, it is validated too.
 */
export function validateSpaceAuth(auth: unknown, expectedSpace?: string): SpaceAuth {
  const root = record(auth, "auth");
  const operator = record(root.operator, "operator");
  const account = record(root.account, "account");
  const sys = record(root.sys, "sys");

  const space = string(root.space, "space");
  if (!space.trim()) throw new Error("validateSpaceAuth: space must not be blank");
  if (expectedSpace !== undefined && space !== expectedSpace)
    throw new Error(`validateSpaceAuth: space "${space}" does not match expected space "${expectedSpace}"`);

  const operatorSeed = string(operator.seed, "operator.seed");
  const operatorJwt = string(operator.jwt, "operator.jwt");
  const accountPub = publicKey(string(account.pub, "account.pub"), "account.pub", "A");
  const accountSeed = string(account.seed, "account.seed");
  const accountJwt = string(account.jwt, "account.jwt");
  const signingSeed = string(account.signingSeed, "account.signingSeed");
  const signingPub = publicKey(string(account.signingPub, "account.signingPub"), "account.signingPub", "A");
  const sysPub = publicKey(string(sys.pub, "sys.pub"), "sys.pub", "A");
  const sysJwt = string(sys.jwt, "sys.jwt");
  if (accountPub === sysPub || signingPub === sysPub)
    throw new Error("validateSpaceAuth: data account identities and system account must use distinct nkeys");

  const operatorPub = seedPublicKey(operatorSeed, "operator.seed", "O");
  if (seedPublicKey(accountSeed, "account.seed", "A") !== accountPub)
    throw new Error("validateSpaceAuth: account.seed does not match account.pub");
  if (seedPublicKey(signingSeed, "account.signingSeed", "A") !== signingPub)
    throw new Error("validateSpaceAuth: account.signingSeed does not match account.signingPub");
  if (sys.signingSeed !== undefined) {
    const sysSigningSeed = string(sys.signingSeed, "sys.signingSeed");
    if (seedPublicKey(sysSigningSeed, "sys.signingSeed", "A") !== sysPub)
      throw new Error("validateSpaceAuth: sys.signingSeed does not match sys.pub");
  }

  const operatorClaims = claims<Operator>(operatorJwt, "operator.jwt");
  const accountClaims = claims<Account>(accountJwt, "account.jwt");
  const sysClaims = claims<Account>(sysJwt, "sys.jwt");

  publicKey(operatorClaims.sub, "operator JWT subject", "O");
  if (operatorClaims.nats?.type !== Types.Operator || operatorClaims.sub !== operatorPub || operatorClaims.iss !== operatorPub)
    throw new Error("validateSpaceAuth: operator JWT subject, issuer, or type does not match operator.seed");
  if (operatorClaims.name !== `cotal-${token(space)}`)
    throw new Error("validateSpaceAuth: operator JWT name does not match space");
  if (operatorClaims.nats.system_account !== sysPub)
    throw new Error("validateSpaceAuth: operator JWT system account does not match sys.pub");

  if (accountClaims.nats?.type !== Types.Account || accountClaims.sub !== accountPub || accountClaims.iss !== operatorPub)
    throw new Error("validateSpaceAuth: account JWT subject, issuer, or type does not match the operator/account keys");
  if (accountClaims.name !== token(space))
    throw new Error("validateSpaceAuth: account JWT name does not match space");
  const signingKeys = accountClaims.nats.signing_keys;
  if (!Array.isArray(signingKeys) || !signingKeys.includes(signingPub))
    throw new Error("validateSpaceAuth: active account signing key is not trusted as an unscoped signer by account.jwt");

  if (sysClaims.nats?.type !== Types.Account || sysClaims.sub !== sysPub || sysClaims.iss !== operatorPub)
    throw new Error("validateSpaceAuth: system account JWT subject, issuer, or type does not match the operator/system keys");
  if (sysClaims.name !== "SYS")
    throw new Error("validateSpaceAuth: system account JWT name must be SYS");
  return auth as SpaceAuth;
}
