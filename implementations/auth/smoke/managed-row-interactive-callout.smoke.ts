/**
 * Focused real interactive-callout regression. Boots one owned private broker and drives the exact
 * openAuthAuthorityPlane/startAuthCallout composition used by runAuthService.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, credsAuthenticator, type ConnectionOptions, type NatsConnection } from "@nats-io/transport-node";
import { createSpaceAuth, isReachable, mintLifecycleUid, serverConfig, standaloneConnectOpts } from "@cotal-ai/core";
import { calloutPermissions, createCalloutAuth, createUserTokenIssuer, deriveOwnerToken, generateSigningKey, grantActor, grantManagedActor, ledgerAclResolver, newActorToken, openAuthAuthorityPlane, startAuthCallout } from "../src/index.js";

const privateRoot = "/home/cotal/hack-lanes/runtime/cloud-linux-acceptance/task84-clean-writer-sep13/interactive-callout-repro";
const run = join(privateRoot, `run-${Date.now()}-${process.pid}`);
mkdirSync(run, { recursive: true, mode: 0o700 });
const broker = "/home/cotal/hack-lanes/runtime/cloud-linux-acceptance/task84-clean-writer-sep13/dependency-isolation/mirror/node_modules/.pnpm/@eplightning+nats-server-linux-x64@2.14.0/node_modules/@eplightning/nats-server-linux-x64/bin/nats-server";
const port = 20000 + Math.floor(Math.random() * 20000);
const server = `nats://127.0.0.1:${port}`;
const space = `task84-interactive-${randomUUID().slice(0,8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
writeFileSync(join(run,"server.conf"), serverConfig(auth,[auth],{ transport:{kind:"plaintext"}, port, storeDir:join(run,"js"), extraAccounts:[{pub:callout.account.pub,jwt:callout.account.jwt}] }));
const child = spawn(broker,["-c",join(run,"server.conf")],{stdio:["ignore","pipe","pipe"]});
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const enc=(s:string)=>new TextEncoder().encode(s);
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>>|undefined;
let calloutNc:NatsConnection|undefined;
async function tryConnect(bearer:string):Promise<boolean>{
 try { const nc=await connect({servers:server,reconnect:false,...(standaloneConnectOpts({bearer,sentinelCreds:callout.sentinelCreds,tls:false}) as Partial<ConnectionOptions>)}); await nc.close(); return true; }
 catch { return false; }
}
try {
 let ready=false; for(let i=0;i<50;i++){ if(await isReachable(server)){ready=true;break;} await wait(100); }
 assert.equal(ready,true,"private broker ready control");
 const dir=join(run,"state");
 plane=await openAuthAuthorityPlane({server,space,dir,dataAccount:{pub:auth.account.pub,signingSeed:auth.account.signingSeed},log:()=>{}});
 const issuer=createUserTokenIssuer({issuer:"https://task84.fixture",key:await generateSigningKey()});
 calloutNc=await connect({servers:server,authenticator:credsAuthenticator(enc(callout.calloutCreds))});
 startAuthCallout(calloutNc as never,{xkeySeed:callout.xkey.seed,authAccount:{pub:callout.account.pub,signingSeed:callout.account.signingSeed},dataAccount:{pub:auth.account.pub,signingSeed:auth.account.signingSeed},space,token:{key:issuer.localKeySet(),issuer:issuer.issuer},prepareActorAuthorization:plane.prepareConnectAuthorization,authorizeActor:plane.authorizeConnect,permissionsFor:calloutPermissions(ledgerAclResolver(dir)),log:()=>{}});
 await calloutNc.flush();
 const owner=deriveOwnerToken("s".repeat(32),"fixture|human");
 const interactiveUid=mintLifecycleUid();
 grantActor(dir,{owner,actor:"cli",scope:[],allowSubscribe:[],allowPublish:[],lifecycleUid:interactiveUid} as never);
 const interactiveCred=await plane.mintConnectCredential({owner,actor:"cli",lifecycleUid:interactiveUid});
 const interactive=await issuer.issue({owner,space,actor:"cli",scope:[],lifecycleUid:interactiveUid,credentialId:interactiveCred});
 assert.equal(await tryConnect(interactive),true,"ordinary interactive actor must connect through shipped composition");
 const managedUid=mintLifecycleUid();
 grantManagedActor(dir,{owner,actor:"worker",scope:[],allowSubscribe:[],allowPublish:[],tokenHash:newActorToken().tokenHash,lifecycleUid:managedUid});
 const managedCred=await plane.mintConnectCredential({owner,actor:"worker",lifecycleUid:managedUid});
 const managed=await issuer.issue({owner,space,actor:"worker",scope:[],lifecycleUid:managedUid,credentialId:managedCred});
 assert.equal(await tryConnect(managed),true,"managed live control connects");
 console.log("TASK84 INTERACTIVE CALLOUT 3 passed, 0 failed");
} finally {
 await plane?.close().catch(()=>{}); await calloutNc?.close().catch(()=>{});
 child.kill("SIGTERM"); await Promise.race([new Promise<void>(r=>child.once("exit",()=>r())),wait(2000)]);
 if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await new Promise<void>(r=>child.once("exit",()=>r()));}
 rmSync(run,{recursive:true,force:true});
}
