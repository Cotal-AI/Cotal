import assert from "node:assert/strict";
import { Algorithms, decode, encodeAuthorizationResponse, encodeUser } from "@nats-io/jwt";
import { createAccount, createCluster, createCurve, createOperator, createServer, createUser, fromPublic, fromSeed, NKeysErrorCode, Prefix } from "@nats-io/nkeys";
import { Codec } from "@nats-io/nkeys/lib/codec.js";
import { decodeNatsJwt, nativeNkeySigner } from "../src/nkey-signer.js";
import { composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth } from "../src/index.js";

const messages = [new Uint8Array(), new TextEncoder().encode("NATS signing: café"), Uint8Array.from({ length: 256 }, (_, i) => i)];
let cases = 0;
for (const create of [createAccount, createCluster, createOperator, createServer, createUser]) {
  const stock = create();
  const seed = Buffer.from(stock.getSeed());
  const originalSeed = Buffer.from(seed);
  const native = nativeNkeySigner(seed);
  try {
    assert.equal(native.getPublicKey(), stock.getPublicKey());
    assert.deepEqual(native.getPrivateKey(), stock.getPrivateKey());
    assert.deepEqual(native.getSeed(), stock.getSeed());
    for (const message of messages) {
      const signature = native.sign(message);
      assert.deepEqual(Uint8Array.from(signature), stock.sign(message), "Ed25519 signatures are byte-identical to stock nkeys");
      assert.equal(stock.verify(message, signature), true);
      assert.equal(native.verify(message, stock.sign(message)), true);
      const changed = Uint8Array.from(signature);
      changed[0] = changed[0]! ^ 1;
      assert.equal(native.verify(message, changed), false);
      assert.equal(native.verify(message, signature.subarray(1)), false);
    }
    const exported = native.getSeed();
    exported.fill(0);
    assert.equal(stock.verify(messages[0]!, native.sign(messages[0]!)), true, "exported seed bytes do not alias signer state");
    native.clear();
    native.clear();
    assert.deepEqual(seed, originalSeed, "clearing a signer never wipes the caller's Buffer");
    for (const operation of [() => native.getSeed(), () => native.getPublicKey(), () => native.getPrivateKey(), () => native.sign(messages[0]!), () => native.verify(messages[0]!, new Uint8Array(64))])
      assert.throws(operation, { code: NKeysErrorCode.ClearedPair });
    assert.throws(() => native.seal(messages[0]!, stock.getPublicKey()), { code: NKeysErrorCode.InvalidNKeyOperation });
    assert.throws(() => native.open(messages[0]!, stock.getPublicKey()), { code: NKeysErrorCode.InvalidNKeyOperation });
    cases++;
  } finally { native.clear(); stock.clear(); seed.fill(0); originalSeed.fill(0); }
}

const curve = createCurve();
assert.throws(() => nativeNkeySigner(curve.getSeed()));
curve.clear();
for (const length of [0, 31, 33, 64]) {
  const malformed = Codec._encode(true, Prefix.Account, new Uint8Array(length));
  assert.throws(() => nativeNkeySigner(malformed), { code: NKeysErrorCode.InvalidSeedLen });
}
const account = createAccount(), user = createUser(), server = createServer();
const native = nativeNkeySigner(account.getSeed());
try {
  const corrupt = account.getSeed().slice();
  corrupt[corrupt.length - 2] = corrupt[corrupt.length - 2] === 65 ? 66 : 65;
  assert.throws(() => nativeNkeySigner(corrupt), "a corrupt checksum is not accepted");
  assert.throws(() => nativeNkeySigner(new TextEncoder().encode(account.getPublicKey())), "a public key is not a signing seed");
  cases++;
  for (const algorithm of [Algorithms.v1, Algorithms.v2]) {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const jwt = await encodeUser("native-signing-smoke", fromPublic(user.getPublicKey()), fromPublic(account.getPublicKey()),
      { pub: { allow: ["test.only"] }, sub: { allow: ["_INBOX.test.>"] } }, { signer: native, exp, algorithm });
    const claims = decode<{ pub: { allow: string[] } }>(jwt);
    assert.equal(claims.iss, account.getPublicKey());
    assert.equal(claims.sub, user.getPublicKey());
    assert.equal(claims.exp, exp);
    assert.deepEqual(claims.nats.pub, { allow: ["test.only"] });
    const parts = jwt.split(".");
    const signed = new TextEncoder().encode(algorithm === Algorithms.v2 ? `${parts[0]}.${parts[1]}` : parts[1]!);
    assert.deepEqual(Buffer.from(parts[2]!, "base64url"), Buffer.from(account.sign(signed)), "stock nkeys reproduces the actual JWT signature");
    parts[1] = Buffer.from(JSON.stringify({ ...claims, exp: exp + 60 })).toString("base64url");
    assert.throws(() => decode(parts.join(".")), "stock JWT verification still rejects changed claims");
    const response = await encodeAuthorizationResponse(fromPublic(user.getPublicKey()), fromPublic(server.getPublicKey()), native,
      { jwt, issuer_account: account.getPublicKey() }, { algorithm });
    assert.equal(decode<{ jwt: string }>(response).nats.jwt, jwt);
    cases++;
  }
} finally { native.clear(); account.clear(); user.clear(); server.clear(); }
// decodeNatsJwt verifies with Node and returns what @nats-io/jwt's decode returns, and refuses what it
// refuses: changed claims, a changed signature, and a token that is not a NATS JWT.
{
  const issuer = createAccount(), holder = createUser(), srv = createServer();
  const signer = nativeNkeySigner(issuer.getSeed());
  try {
    for (const algorithm of [Algorithms.v1, Algorithms.v2]) {
      const jwt = await encodeUser("decode-smoke", fromPublic(holder.getPublicKey()), fromPublic(issuer.getPublicKey()),
        { pub: { allow: ["a.b"] } }, { signer, exp: Math.floor(Date.now() / 1000) + 60, algorithm });
      const response = await encodeAuthorizationResponse(fromPublic(holder.getPublicKey()), fromPublic(srv.getPublicKey()), signer,
        { error: "RATE_LIMITED café", issuer_account: issuer.getPublicKey() }, { algorithm });
      for (const token of [jwt, response]) {
        assert.deepEqual(decodeNatsJwt(token), decode(token), "the native decode returns the stock claims");
        const parts = token.split(".");
        const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("latin1")) as Record<string, unknown>;
        const changed = [parts[0], Buffer.from(JSON.stringify({ ...claims, iat: Number(claims.iat) + 1 }), "latin1").toString("base64url"), parts[2]].join(".");
        assert.throws(() => decode(changed));
        assert.throws(() => decodeNatsJwt(changed), /sig verification failed/, "changed claims are refused");
        const sig = Buffer.from(parts[2]!, "base64url");
        sig[0] = sig[0]! ^ 1;
        assert.throws(() => decodeNatsJwt([parts[0], parts[1], sig.toString("base64url")].join(".")), /sig verification failed/, "a changed signature is refused");
        const foreign = [parts[0], Buffer.from(JSON.stringify({ ...claims, iss: srv.getPublicKey() }), "latin1").toString("base64url"), parts[2]].join(".");
        assert.throws(() => decodeNatsJwt(foreign), /sig verification failed/, "another issuer's key does not verify it");
      }
      const parts = jwt.split(".");
      const header = (h: Record<string, unknown>) => [Buffer.from(JSON.stringify(h)).toString("base64url"), parts[1], parts[2]].join(".");
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      const withIss = (iss: unknown) => [parts[0], Buffer.from(JSON.stringify({ ...claims, iss })).toString("base64url"), parts[2]].join(".");
      const corrupt = issuer.getPublicKey().slice(0, -1) + (issuer.getPublicKey().endsWith("A") ? "B" : "A");
      for (const [bad, why] of [[parts.slice(0, 2).join("."), /2 chunks/], [header({ typ: "JWS", alg: algorithm }), /typ/], [header({ typ: "JWT", alg: "HS256" }), /alg/],
        [withIss(undefined), /no issuer/], [withIss(42), /no issuer/], [withIss(Buffer.from(issuer.getSeed()).toString()), /./], [withIss(createCurve().getPublicKey()), /./], [withIss(corrupt), /./]] as const)
        assert.throws(() => decodeNatsJwt(bad), why, "a token that is not a NATS JWT signed by a public nkey is refused");
    }
    cases++;
  } finally { signer.clear(); issuer.clear(); holder.clear(); srv.clear(); }
}
// The account factory uses the same signer without changing the operator/account trust chain.
{
  const broker = await createBrokerAuth("native-account-factory");
  const operatorPub = decode(broker.operator.jwt).sub;
  const accounts = [];
  for (const space of ["native-account-a", "native-account-b"]) {
    const account = await createSpaceAccountAuth(broker, space);
    const stockAccount = fromSeed(new TextEncoder().encode(account.account.seed));
    const stockSigning = fromSeed(new TextEncoder().encode(account.account.signingSeed));
    try {
      assert.equal(account.account.pub, stockAccount.getPublicKey());
      assert.equal(account.account.signingPub, stockSigning.getPublicKey());
      const claims = decode<{ signing_keys: string[] }>(account.account.jwt);
      assert.equal(claims.iss, operatorPub, "stock JWT verification accepts the operator signature");
      assert.equal(claims.sub, account.account.pub);
      assert.deepEqual(claims.nats.signing_keys, [account.account.signingPub]);
      assert.notEqual(account.account.pub, account.account.signingPub);
      assert.doesNotThrow(() => composeSpaceAuth(broker, account));
      accounts.push(account);
      cases++;
    } finally { stockAccount.clear(); stockSigning.clear(); }
  }
  const first = accounts[0]!;
  const foreignBroker = await createBrokerAuth("native-account-foreign");
  assert.throws(() => composeSpaceAuth(foreignBroker, first), /refusing to compose trust across brokers/);
  cases++;
  const parts = first.account.jwt.split(".");
  const signature = Buffer.from(parts[2]!, "base64url");
  signature[0] = signature[0]! ^ 1;
  const invalidJwt = [parts[0], parts[1], signature.toString("base64url")].join(".");
  assert.throws(() => decode(invalidJwt), /sig verification failed/);
  assert.throws(() => composeSpaceAuth(broker, { ...first, account: { ...first.account, jwt: invalidJwt } }), /sig verification failed/);
  cases++;
  assert.throws(() => composeSpaceAuth({ ...broker, operator: { ...broker.operator, seed: "invalid" } }, first), /not a valid operator seed/);
  assert.throws(() => composeSpaceAuth({ ...broker, operator: { ...broker.operator, seed: "" } }, first), /operator material is required/);
  cases++;
  assert.notEqual(accounts[0]!.account.pub, accounts[1]!.account.pub);
  assert.notEqual(accounts[0]!.account.signingPub, accounts[1]!.account.signingPub);
  await assert.rejects(() => createSpaceAccountAuth({ ...broker, operator: { ...broker.operator, seed: "" } }, "stripped"), /operator seed is required/);
  cases++;
}
console.log(`native nkey signing smoke: ${cases} cases passed (5 key kinds × 3 payloads, invalid seeds, v1/v2 JWTs and callout responses, native JWT decode, account factory and broker binding)`);
