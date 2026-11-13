import assert from "node:assert/strict";
import { checkBundleDocument } from "../src/registration-policy.js";
const base = { space: "payload", server: "nats://127.0.0.1:4223", tlsRequired: false, sentinelCreds: "fixture", userAuth: { provider: "fixture", idp: {url:"https://idp.example",issuer:"https://idp.example",audience:"payload"}, endpoints:{url:"https://exchange.example"} } };
for (const policy of [{events:"required"},{eventPayloads:"withheld"},{events:"required",eventPayloads:"withheld"}]) {
  assert.equal(checkBundleDocument({...base,policy}).ok,true);
}
for (const policy of [{},{eventPayloads:"publish"},{eventPayloads:false},{events:"optional"},{eventPayloads:"withheld",unknown:true}]) {
  assert.equal(checkBundleDocument({...base,policy}).ok,false);
}
console.log("PASS closed registration payload withholding policy");
