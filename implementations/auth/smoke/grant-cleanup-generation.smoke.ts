import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, mintLifecycleUid } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { cotalAuthProvider } from "../src/provider.js";
import { ensureCalloutAuth } from "../src/store.js";
import { findManagedActor } from "../src/ledger.js";
import { deriveOwnerToken } from "../src/derive.js";

const dir=mkdtempSync(join(tmpdir(),"grant-custody-")), values=new Map<string,string>();
const store={identity:{kind:"injected" as const,coordinate:dir},async get(k:string){return values.get(k);},async put(k:string,v:string){values.set(k,v);},async create(k:string,v:string){if(values.has(k))return false;values.set(k,v);return true;},async delete(k:string){values.delete(k);}};
let passed=0,failed=0;
function check(name:string,ok:boolean){assert.ok(ok,name);console.log(`✓ ${name}`);passed++;}
try {
 const space="grant-custody", auth=await createSpaceAuth(space);
 await ensureCalloutAuth(store,{space,operatorSeed:auth.operator.seed,accountPub:auth.account.pub});
 const owner=deriveOwnerToken("f".repeat(32),"custody-human"),actor="fixture",uid=mintLifecycleUid();
 const args={store,dir,space,owner,actor,scope:[],allowSubscribe:[],allowPublish:[],lifecycleUid:uid};
 const first=await cotalAuthProvider.grantAgent({...args,fresh:true});const row=findManagedActor(dir,owner,actor);
 await assert.rejects(cotalAuthProvider.grantAgent({...args,lifecycleUid:mintLifecycleUid(),fresh:true}),/already has a grant/,"fresh grant refuses without replacing original row");
 check("fresh grant refuses without replacing original row",JSON.stringify(findManagedActor(dir,owner,actor))===JSON.stringify(row));
 const successor=await cotalAuthProvider.grantAgent(args);
 check("stale token cleanup cannot revoke same-UID successor",!await cotalAuthProvider.revokeAgent({dir,owner,actor,lifecycleUid:uid,actorToken:first.actorToken})&&findManagedActor(dir,owner,actor)!==undefined);
 check("foreign UID cleanup cannot revoke successor",!await cotalAuthProvider.revokeAgent({dir,owner,actor,lifecycleUid:mintLifecycleUid(),actorToken:successor.actorToken}));
 check("exact generation cleanup revokes its own grant",await cotalAuthProvider.revokeAgent({dir,owner,actor,lifecycleUid:uid,actorToken:successor.actorToken})&&findManagedActor(dir,owner,actor)===undefined);
} catch(error){failed++;console.error(error);}finally{rmSync(dir,{recursive:true,force:true});emitSentinel({passed,failed});}
process.exitCode=failed?1:0;
