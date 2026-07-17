import assert from "node:assert/strict";
import { encodeAccount, encodeOperator } from "@nats-io/jwt";
import { createAccount, createOperator, fromPublic, fromSeed } from "@nats-io/nkeys";
import { createSpaceAuth, validateSpaceAuth } from "../src/index.js";

const space = "space-auth-smoke";
const auth = await createSpaceAuth(space);
const before = structuredClone(auth);

assert.equal(validateSpaceAuth(auth, space), auth);
assert.deepEqual(auth, before, "validation must not mutate trust material");

const persisted = { ...auth, sys: { pub: auth.sys.pub, jwt: auth.sys.jwt } };
assert.doesNotThrow(() => validateSpaceAuth(persisted, space));

const malformedPub = structuredClone(auth);
malformedPub.account.pub = "not-an-account-nkey";
assert.throws(() => validateSpaceAuth(malformedPub, space), /account\.pub.*valid account public nkey/);

const other = await createSpaceAuth("space-auth-other");
const mismatchedSeed = structuredClone(auth);
mismatchedSeed.account.seed = other.account.seed;
assert.throws(() => validateSpaceAuth(mismatchedSeed, space), /account\.seed does not match account\.pub/);

const forgedJwt = structuredClone(auth);
const jwtParts = forgedJwt.account.jwt.split(".");
jwtParts[2] = `${jwtParts[2]![0] === "A" ? "B" : "A"}${jwtParts[2]!.slice(1)}`;
forgedJwt.account.jwt = jwtParts.join(".");
assert.throws(() => validateSpaceAuth(forgedJwt, space), /account\.jwt is not a currently valid signed NATS JWT/);

const untrustedSigner = createAccount();
try {
  const wrongSigner = structuredClone(auth);
  wrongSigner.account.signingSeed = new TextDecoder().decode(untrustedSigner.getSeed());
  wrongSigner.account.signingPub = untrustedSigner.getPublicKey();
  assert.throws(() => validateSpaceAuth(wrongSigner, space), /active account signing key is not trusted/);
} finally {
  untrustedSigner.clear();
}

const wrongOperator = createOperator();
const accountPublic = fromPublic(auth.account.pub);
try {
  const wrongJwtSigner = structuredClone(auth);
  wrongJwtSigner.account.jwt = await encodeAccount(
    space,
    accountPublic,
    { signing_keys: [auth.account.signingPub] },
    { signer: wrongOperator },
  );
  assert.throws(() => validateSpaceAuth(wrongJwtSigner, space), /account JWT subject, issuer, or type/);
} finally {
  accountPublic.clear();
  wrongOperator.clear();
}

const operatorPair = fromSeed(new TextEncoder().encode(auth.operator.seed));
const dataAccountPair = fromPublic(auth.account.pub);
try {
  const expiredJwt = structuredClone(auth);
  expiredJwt.account.jwt = await encodeAccount(
    space,
    dataAccountPair,
    { signing_keys: [auth.account.signingPub] },
    { signer: operatorPair, exp: 1 },
  );
  assert.throws(() => validateSpaceAuth(expiredJwt, space), /account\.jwt is not a currently valid signed NATS JWT/);

  const wrongAudienceJwt = structuredClone(auth);
  wrongAudienceJwt.account.jwt = await encodeAccount(
    space,
    dataAccountPair,
    { signing_keys: [auth.account.signingPub] },
    { signer: operatorPair, aud: "NOT-NATS" },
  );
  assert.throws(() => validateSpaceAuth(wrongAudienceJwt, space), /account\.jwt is not a currently valid signed NATS JWT/);

  const futureJwt = structuredClone(auth);
  futureJwt.account.jwt = await encodeAccount(
    space,
    dataAccountPair,
    { signing_keys: [auth.account.signingPub] },
    { signer: operatorPair, nbf: Math.floor(Date.now() / 1000) + 3600 },
  );
  assert.throws(() => validateSpaceAuth(futureJwt, space), /account\.jwt is not a currently valid signed NATS JWT/);

  const scopedSigner = structuredClone(auth);
  scopedSigner.account.jwt = await encodeAccount(
    space,
    dataAccountPair,
    {
      signing_keys: [{
        kind: "user_scope",
        key: auth.account.signingPub,
        role: "limited",
        template: {},
      }],
    },
    { signer: operatorPair },
  );
  assert.throws(() => validateSpaceAuth(scopedSigner, space), /not trusted as an unscoped signer/);

  const collapsedAccounts = structuredClone(auth);
  collapsedAccounts.sys = {
    pub: auth.account.pub,
    jwt: await encodeAccount("SYS", dataAccountPair, {}, { signer: operatorPair }),
    signingSeed: auth.account.seed,
  };
  collapsedAccounts.operator.jwt = await encodeOperator(
    `cotal-${space}`,
    operatorPair,
    { system_account: auth.account.pub },
  );
  assert.throws(() => validateSpaceAuth(collapsedAccounts, space), /data account identities and system account must use distinct nkeys/);

  const systemRootSigner = structuredClone(auth);
  systemRootSigner.account.signingPub = auth.sys.pub;
  systemRootSigner.account.signingSeed = auth.sys.signingSeed!;
  systemRootSigner.account.jwt = await encodeAccount(
    space,
    dataAccountPair,
    { signing_keys: [auth.sys.pub] },
    { signer: operatorPair },
  );
  assert.throws(() => validateSpaceAuth(systemRootSigner, space), /data account identities and system account must use distinct nkeys/);
} finally {
  dataAccountPair.clear();
  operatorPair.clear();
}

assert.throws(() => validateSpaceAuth(auth, "wrong-space"), /does not match expected space/);

console.log("space auth validation smoke passed");
