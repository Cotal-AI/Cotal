import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, mintLifecycleUid } from "@cotal-ai/core";
import { userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { cotalAuthProvider, ensurePinnedIdp, grantActor, grantManagedActor, hashActorToken, managedActorLedgerDir, readManagedActor } from "../src/index.js";
import { verifyManagedHistoryAgainstCanonical } from "../src/managed-row.js";
import { setBeforeAgentExchangeReadForSmoke } from "../src/ledger.js";

const SPACE="retained-ab",OWNER=`u_${"a".repeat(26)}`,ACTOR="worker",LIFECYCLE=mintLifecycleUid();
const root=mkdtempSync(join(process.env.TMPDIR??tmpdir(),"task84-retained-ab-"));
const dir=userAuthStateDir(root,SPACE),store=workspaceSecretStore(root);
let hookCalls=0;
try {
  ensurePinnedIdp(dir,"http://127.0.0.1:49151/api/auth");
  const auth=await createSpaceAuth(SPACE);
  await cotalAuthProvider.prepareServer({space:SPACE,operatorSeed:auth.operator.seed,account:{pub:auth.account.pub,signingSeed:auth.account.signingSeed},store,dir});
  mkdirSync(join(dir,"managed-actors"),{mode:0o700});
  grantActor(dir,{owner:OWNER,actor:"cli",scope:["spawn","admin"],allowSubscribe:["general","other"],allowPublish:["general","other"]});
  const retained=await cotalAuthProvider.grantAgent({store,dir,space:SPACE,owner:OWNER,actor:ACTOR,scope:["spawn"],allowSubscribe:["general"],allowPublish:["general"],role:"worker",parent:`${OWNER}.cli`,lifecycleUid:LIFECYCLE});
  const managedDir=managedActorLedgerDir(dir);
  const before=readManagedActor(managedDir,OWNER,ACTOR);
  assert.equal(before.state,"live");
  const ordinary=await cotalAuthProvider.validateRetainedAgent({store,dir,space:SPACE,owner:OWNER,actor:ACTOR,actorToken:retained.actorToken,sentinelCreds:retained.sentinelCreds});
  assert.deepEqual({scope:ordinary.scope,allowSubscribe:ordinary.allowSubscribe,allowPublish:ordinary.allowPublish,role:ordinary.role,lifecycleUid:ordinary.lifecycleUid},{scope:["spawn"],allowSubscribe:["general"],allowPublish:["general"],role:"worker",lifecycleUid:LIFECYCLE});
  setBeforeAgentExchangeReadForSmoke(()=>{
    hookCalls++;
    grantManagedActor(dir,{owner:OWNER,actor:ACTOR,scope:["spawn"],allowSubscribe:["other"],allowPublish:["other"],role:"reviewer",parent:`${OWNER}.cli`,lifecycleUid:LIFECYCLE,tokenHash:hashActorToken(retained.actorToken)});
  });
  let refusedDrift=false,authority:Awaited<ReturnType<typeof cotalAuthProvider.validateRetainedAgent>>|undefined;
  try {
    authority=await cotalAuthProvider.validateRetainedAgent({store,dir,space:SPACE,owner:OWNER,actor:ACTOR,actorToken:retained.actorToken,sentinelCreds:retained.sentinelCreds});
  } catch(error) {
    const message=error instanceof Error?error.message:String(error);
    assert.match(message,/changed during retained validation/,message);
    refusedDrift=true;
  }
  if(authority) assert.deepEqual({scope:authority.scope,allowSubscribe:authority.allowSubscribe,allowPublish:authority.allowPublish,role:authority.role},{scope:["spawn"],allowSubscribe:["general"],allowPublish:["general"],role:"worker"},"retained validation returned independently reread snapshot B after verifying snapshot A");
  assert.equal(hookCalls,1);
  const after=readManagedActor(managedDir,OWNER,ACTOR);
  assert.equal(after.state,"live");
  assert.equal(after.row.lifecycleUid,LIFECYCLE);
  assert.equal(after.row.tokenHash,hashActorToken(retained.actorToken));
  assert.deepEqual(after.row.allowSubscribe,["other"]);
  assert.equal(after.row.role,"reviewer");
  assert.equal(verifyManagedHistoryAgainstCanonical(managedDir,OWNER,ACTOR,after.bytes),after.historyHead);
  console.log(`TASK84 RETAINED AGENT SNAPSHOT ${refusedDrift?"drift refused":"snapshot A returned"} 10 passed, 0 failed`);
} finally {
  setBeforeAgentExchangeReadForSmoke(undefined);
  rmSync(root,{recursive:true,force:true});
}
