import assert from "node:assert/strict";
import { authorityBarrierGrants, authorityWriterGrants, managedRowMutationExecutorGrants, remoteManagerIssuerGrants } from "../src/authority-client.js";

const space="task84"; const conn="abc12345";
const beforeWriter=authorityWriterGrants(space,conn);
const beforeRemote=remoteManagerIssuerGrants(space,conn);
const managed=managedRowMutationExecutorGrants(space,conn);
const prefixes=managed.publish.filter(s=>s.startsWith(`$KV.cotal_auth_${space}.managedrow`));
assert.equal(prefixes.length,15);
assert.equal(new Set(prefixes).size,15);
assert.deepEqual(managed.subscribe,[`_INBOX_${conn}.>`]);
assert.throws(()=>managedRowMutationExecutorGrants(space,">"));
for(const forbidden of [".gate.",".cred.",".bysrc.",".lifecycle.",".uid.",".epgate.",".epcred.",".renewclean.",".stage.",".session.",".plane", "STREAM.CREATE","STREAM.UPDATE","DIRECT.GET","CONSUMER.CREATE","CONSUMER.MSG.NEXT"])
 assert.equal(managed.publish.some(s=>s.includes(forbidden)),false,forbidden);
assert.equal(managed.publish.some(s=>s.includes("cotal_records_")),false);
assert.deepEqual(authorityWriterGrants(space,conn),beforeWriter);
assert.deepEqual(remoteManagerIssuerGrants(space,conn),beforeRemote);
assert.equal(authorityWriterGrants(space,conn).publish.some(s=>s.includes("managedrow")),false);
assert.equal(remoteManagerIssuerGrants(space,conn).publish.some(s=>s.includes("managedrow")),false);
assert.equal(authorityBarrierGrants(space,conn).publish.some(s=>s.includes("managedrow")),false);
console.log("TASK84 MANAGED ROW EXECUTOR GRANTS 15 families, 0 propagated, 0 forbidden");
