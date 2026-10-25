import assert from "node:assert/strict";
import { Algorithms, decode, encodeAuthorizationResponse, encodeUser } from "@nats-io/jwt";
import { createAccount, createCluster, createCurve, createOperator, createServer, createUser, fromPublic, NKeysErrorCode, Prefix } from "@nats-io/nkeys";
import { Codec } from "@nats-io/nkeys/lib/codec.js";
import { nativeNkeySigner } from "../src/nkey-signer.js";

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
console.log(`native nkey signing smoke: ${cases} cases passed (5 key kinds × 3 payloads, invalid seeds, v1/v2 JWTs and callout responses)`);
