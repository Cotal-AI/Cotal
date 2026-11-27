/**
 * Connect limits (SPEC §10): the callout's per-actor, per-owner and per-host token buckets, the
 * signed `RATE_LIMITED` denial it journals, and the exchange's typed 429, against a REAL
 * operator-mode nats-server.
 *
 *   L1  the limiter alone, on an injected clock: burst, refill, an owner across its actors, a
 *       refusal spends nothing, `check` spends nothing, hosts apart, and bad limits refused.
 *   L2  the callout with counting hooks: an actor's connects pass up to its limit, and the next is a
 *       prompt Authorization Violation journaled as `RATE_LIMITED` with its retry-after, actor and
 *       owner, after no ledger or issuance work. The owner limit names the owner and the actor. An
 *       expired bearer is charged to its actor, and a bearer that does not verify to its host.
 *   L3  the shipped auth service started in this process with small limits: once the callout has
 *       limited an actor, its human exchange and its managed-agent exchange answer 429 with
 *       `{code, retryAfterSeconds, error}` and `Retry-After`, while another actor still mints.
 *   L4  the clients: the 429 becomes a `rate-limited` failure with its seconds, the bearer command's
 *       `retry-after` line rides its error, an endpoint whose bearer the broker refuses says so and
 *       retries inside its first backoff step, and a bearer source's `retryAfterSeconds` is waited out
 *       by the refresh timer and by a rebuild inside the wait.
 *
 * Run: pnpm smoke:connect-limit:auth  (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { CotalEndpoint, bearerCommandFailure, mintCreds, mintLifecycleUid, newIdentity, runAgentBearer, setupSpaceStreams } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import {
  ConnectLimiter, ConnectRateLimited, USER_TOKEN_VER, calloutPermissions, deriveOwnerForIdpSubject, deriveOwnerToken, grantActor,
  grantManagedActor, loadCalloutAuth, loadOwnerSecret, newActorToken, startAuthCallout, startAuthService, type AuthServiceHandle,
} from "../src/index.js";
import { credentialFailure } from "@cotal-ai/workspace";
import { exchangeRateLimit } from "../src/response-json.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const now = () => Math.floor(Date.now() / 1000);
/** The principal and reason of each `outcome=denied` line the callout writes. */
const denials = (lines: string[]) => lines.flatMap((l) => {
  const m = /^auth callout: level=\w+ outcome=denied .* owner=(\S+) actor=(\S+) .* reason=("(?:[^"\\]|\\.)*")$/.exec(l);
  return m ? [{ owner: m[1]!, actor: m[2]!, reason: JSON.parse(m[3]!) as string }] : [];
});
const refusal = (fn: () => void): ConnectRateLimited | undefined => {
  try { fn(); return undefined; } catch (e) { if (e instanceof ConnectRateLimited) return e; throw e; }
};

// ---- L1: the limiter alone ------------------------------------------------------------------------
console.log("L1) the limiter on an injected clock");
{
  const t0 = 1_000_000;
  const lim = new ConnectLimiter({ actorPerMinute: 3, ownerPerMinute: 5, hostPerMinute: 2 });
  const a = { owner: "u_owner", actor: "a" }, b = { owner: "u_owner", actor: "b" };
  for (let i = 0; i < 3; i++) lim.take(a, t0);
  const r = refusal(() => lim.take(a, t0));
  check("an actor's burst is its per-minute limit, and the next connect is refused", r?.code === "RATE_LIMITED", r);
  check("the refusal waits one refill: 60s / 3 = 20s", r?.retryAfterSeconds === 20, r?.retryAfterSeconds);
  check("the refusal names the actor and the owner, and its limit is the actor's", r?.message === "actor a of owner u_owner is over its limit of 3 connects a minute" && r.limit === "actor", r);
  check("refusals spend nothing: the owner still has 2 of 5 for another actor", refusal(() => { lim.take(b, t0); lim.take(b, t0); }) === undefined);
  const o = refusal(() => lim.take(b, t0));
  check("the owner's limit holds across its actors and names both, and its limit is the owner's", o?.message === "owner u_owner is over its limit of 5 connects a minute (actor b)" && o.limit === "owner", o);
  check("a bucket refills at its rate: one connect for the actor after 20s", refusal(() => lim.check(a, t0 + 20_000)) === undefined);
  check("the longer wait wins when both buckets are short", refusal(() => lim.check(a, t0 + 5_000))?.retryAfterSeconds === 15);
  const lim2 = new ConnectLimiter({ actorPerMinute: 1 });
  lim2.check({ owner: "u_x", actor: "c" }, t0);
  lim2.check({ owner: "u_x", actor: "c" }, t0);
  check("check spends nothing", refusal(() => lim2.take({ owner: "u_x", actor: "c" }, t0)) === undefined);
  lim.take({ host: "10.0.0.1" }, t0); lim.take({ host: "10.0.0.1" }, t0);
  const h = refusal(() => lim.take({ host: "10.0.0.1" }, t0));
  check("a host's bucket refuses a bearer that does not verify", h?.message === "host 10.0.0.1 is over its limit of 2 connects a minute with a bearer that does not verify" && h.limit === "host", h);
  check("another host has its own bucket", refusal(() => lim.take({ host: "10.0.0.2" }, t0)) === undefined);
  check("the defaults are 60, 600 and 60 a minute", JSON.stringify(new ConnectLimiter().limits) === JSON.stringify({ actorPerMinute: 60, ownerPerMinute: 600, hostPerMinute: 60 }));
  let bad: unknown;
  try { new ConnectLimiter({ ownerPerMinute: 0 }); } catch (e) { bad = e; }
  check("a limit that is not a positive integer is refused at construction", /ownerPerMinute must be a positive integer/.test(String(bad)), bad);
}

const fx = await startHostedAuthFixture("connlimit", 1);
const a = fx.accounts[0]!;
let calloutNc: NatsConnection | undefined;
let service: AuthServiceHandle | undefined;
let idpServer: Server | undefined;
const realConsoleError = console.error;
try {
  /** One user-mode connect: ok, or the client's error message. */
  const dial = async (bearer: string): Promise<{ ok: boolean; msg: string; ms: number }> => {
    const nonce = `ibx${randomUUID().replace(/-/g, "")}`, t = Date.now();
    try {
      const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(enc(a.sentinelCreds)), tokenAuthenticator(bearer)],
        name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: 15_000, maxReconnectAttempts: 0 });
      await nc.close();
      return { ok: true, msg: "connected", ms: Date.now() - t };
    } catch (e) {
      return { ok: false, msg: (e as Error).message, ms: Date.now() - t };
    }
  };

  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });

  // ---- L2: the callout with counting hooks --------------------------------------------------------
  console.log("L2) the callout charges each connect before any ledger or issuance work");
  const calloutAuth = (await loadCalloutAuth(a.store, a.space))!;
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const ISS = "https://auth.cotal.test";
  const uid = mintLifecycleUid();
  const ownerOf = (who: string) => deriveOwnerToken("c".repeat(32), `better-auth|${who}`);
  const sign = (owner: string, actor: string, key: CryptoKey, exp = now() + 300) =>
    new SignJWT({ sub: owner, ver: USER_TOKEN_VER, act: { owner, actor, scope: [], lifecycleUid: uid } }).setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(ISS).setAudience(a.space).setSubject(owner).setIssuedAt(exp - 360).setNotBefore(exp - 360).setExpirationTime(exp).sign(key);
  let authorized = 0, recorded = 0;
  const journal: string[] = [];
  calloutNc = await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc(calloutAuth.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    xkeySeed: calloutAuth.xkey.seed,
    authAccount: { pub: calloutAuth.account.pub, signingSeed: calloutAuth.account.signingSeed },
    dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
    space: a.space,
    token: { key: publicKey as never, issuer: ISS },
    authorizeActor: () => { authorized++; },
    recordIssuance: async () => { recorded++; },
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: uid, scope: [] })),
    connectLimiter: new ConnectLimiter({ actorPerMinute: 3, ownerPerMinute: 5, hostPerMinute: 2 }),
    log: (l) => journal.push(l),
  });
  await calloutNc.flush();
  const lastDenial = () => denials(journal).at(-1) ?? { owner: "", actor: "", reason: "" };

  const owner = ownerOf("limit-human");
  const loop = await sign(owner, "loop", privateKey as CryptoKey);
  const first = [await dial(loop), await dial(loop), await dial(loop)];
  check("an actor's connects up to its limit are minted", first.every((r) => r.ok) && authorized === 3 && recorded === 3, { first, authorized, recorded, journal });
  const limited = await dial(loop);
  check("the next connect is a prompt Authorization Violation", !limited.ok && /authorization violation/i.test(limited.msg) && limited.ms < 7_500, limited);
  const line = lastDenial();
  const m = new RegExp(`^RATE_LIMITED retry-after (\\d+)s: actor loop of owner ${owner} is over its limit of 3 connects a minute$`).exec(line.reason);
  check("its journal line names RATE_LIMITED, the retry-after, the actor and the owner", m !== null && line.owner === owner && line.actor === "loop", line);
  check("the retry-after is the time to one refill", Number(m?.[1]) >= 18 && Number(m?.[1]) <= 20, m?.[1]);
  check("the limited connect did no ledger read and no issuance write", authorized === 3 && recorded === 3, { authorized, recorded });

  const other = await sign(owner, "other", privateKey as CryptoKey);
  const second = [await dial(other), await dial(other)];
  const ownerLimited = await dial(other);
  check("another actor of the owner connects until the owner's limit", second.every((r) => r.ok), second);
  check("then the owner's limit refuses it, naming the owner and the actor",
    !ownerLimited.ok && new RegExp(`^RATE_LIMITED retry-after \\d+s: owner ${owner} is over its limit of 5 connects a minute \\(actor other\\)$`).test(lastDenial().reason), lastDenial());

  const lateOwner = ownerOf("late-human");
  const expired = await sign(lateOwner, "late", privateKey as CryptoKey, now() - 60);
  const exp3 = [await dial(expired), await dial(expired), await dial(expired)];
  const expDenials = denials(journal).filter((d) => d.reason.includes('"exp" claim timestamp check failed')).length;
  check("an expired bearer is refused for its expiry while its actor has connects left", exp3.every((r) => !r.ok) && expDenials === 3, { exp3, expDenials });
  await dial(expired);
  check("then its retries are charged to the actor its signature names",
    new RegExp(`^RATE_LIMITED retry-after \\d+s: actor late of owner ${lateOwner} is over its limit of 3 connects a minute$`).test(lastDenial().reason) &&
      lastDenial().owner === lateOwner && lastDenial().actor === "late", lastDenial());
  check("an expired bearer reaches no ledger read", authorized === 5, authorized);

  const { privateKey: foreign } = await generateKeyPair("EdDSA");
  const forged = await sign(ownerOf("forger"), "x", foreign as CryptoKey);
  await dial(forged); await dial(forged);
  const hostDenials = denials(journal).filter((d) => /signature verification failed/.test(d.reason)).length;
  await dial(forged);
  check("a bearer that does not verify is refused for its signature, then charged to its client host",
    hostDenials === 2 && /^RATE_LIMITED retry-after \d+s: host 127\.0\.0\.1 is over its limit of 2 connects a minute with a bearer that does not verify$/.test(lastDenial().reason), { hostDenials, last: lastDenial() });

  // ---- L4: the clients ------------------------------------------------------------------------------
  console.log("L4) the clients wait out a rate limit and name a refused bearer");
  const typed = exchangeRateLimit(429, { code: "RATE_LIMITED", retryAfterSeconds: 7, limit: "actor", error: "actor a of owner u_x is over its limit of 60 connects a minute - retry in 7s" }, "a");
  check("the exchange's 429 is a rate limit with its sentence, seconds and bucket",
    typed?.message.endsWith("retry in 7s") === true && typed.retryAfterSeconds === 7 && typed.limit === "actor", typed);
  check("an actor's limit says only that actor is limited",
    typed?.remedy === `only actor "a" is limited, not the account's other actors`, typed?.remedy);
  const ownerTyped = exchangeRateLimit(429, { code: "RATE_LIMITED", retryAfterSeconds: 1, limit: "owner", error: "owner u_x is over its limit of 600 connects a minute (actor a) - retry in 1s" }, "a");
  check("an owner's limit says the whole account is limited",
    ownerTyped?.remedy === "the account is limited, so every one of its actors is" && ownerTyped.limit === "owner", ownerTyped);
  check("a 429 without the typed body or bucket, or another status, is not read as a rate limit",
    exchangeRateLimit(429, { error: "too many refused exchanges" }, "a") === undefined && exchangeRateLimit(429, { code: "RATE_LIMITED", retryAfterSeconds: 7 }, "a") === undefined &&
    exchangeRateLimit(401, { code: "RATE_LIMITED", retryAfterSeconds: 7, limit: "actor" }, "a") === undefined);
  const failure = credentialFailure("rate-limited", typed!.message, typed!.remedy, { retryAfterSeconds: 7, limit: "actor" }) as Error & { code?: unknown; retryAfterSeconds?: unknown; rateLimit?: unknown };
  check("the provider's rate-limited failure carries the seconds where an endpoint reads them, and the bucket",
    failure.code === "rate-limited" && failure.retryAfterSeconds === 7 && JSON.stringify(failure.rateLimit) === JSON.stringify({ retryAfterSeconds: 7, limit: "actor" }), failure);
  const sentence = "agent-bearer: actor seat of owner u_x is over its limit of 60 connects a minute - retry in 7s";
  const ran = await runAgentBearer([process.execPath, "-e", `process.stdout.write("retry-after 7\\n"); process.stderr.write(${JSON.stringify(sentence)}); process.exit(2)`])
    .then(() => undefined, (e: Error & { retryAfterSeconds?: unknown }) => e);
  check("the bearer command's retry-after line rides its error beside its one sentence", ran?.message === sentence && ran.retryAfterSeconds === 7, ran);
  const definitive = "agent-bearer: exchange refused: agent exchange refused: unknown agent or wrong secret";
  const hasDefinitiveRefusal = async (status: string, text: string) => (await runAgentBearer([
    process.execPath, "-e", `if (${JSON.stringify(status)}) process.stdout.write(${JSON.stringify(status)} + "\\n"); console.error(${JSON.stringify(text)}); process.exit(1)`,
  ])
    .then(() => undefined, (e: Error & { bearerRefused?: boolean }) => e))?.bearerRefused === true;
  check("the same identity refusal is definitive on HTTP 401 and 403",
    await hasDefinitiveRefusal("http-status 401", definitive) && await hasDefinitiveRefusal("http-status 403", definitive));
  check("a restart response, a 5xx, or no exchange response is not a definitive identity refusal",
    !(await hasDefinitiveRefusal("http-status 401", "agent-bearer: exchange refused: the auth service is momentarily unavailable (it detected a fault and is restarting); retry shortly")) &&
    !(await hasDefinitiveRefusal("http-status 503", definitive)) &&
    !(await hasDefinitiveRefusal("", definitive)) &&
    !(await hasDefinitiveRefusal("", "agent-bearer: the pinned exchange did not answer (TimeoutError)")));

  // Exhaustive source-scraped sentence classification across every throw site reachable from the
  // managed agent exchange path: any new or changed refusal sentence fails this cell until it is
  // explicitly classified as definitive (self-close) vs retryable (keep and retry) and matches
  // bearerCommandFailure's actual verdict.
  {
    const smokeDir = fileURLToPath(new URL(".", import.meta.url));
    const scrapeTargets: Array<{ file: string; functions: string[] }> = [
      { file: join(smokeDir, "../src/service-exchange-routes.ts"), functions: ["handleExchange", "selectExchangeManagerInstance"] },
      { file: join(smokeDir, "../src/ledger.ts"), functions: ["ledgerAuthorizeAgentExchange", "assertWithinSpawnerGrant"] },
      { file: join(smokeDir, "../src/root-credential.ts"), functions: ["ensureRootCredential", "readCredRow"] },
      { file: join(smokeDir, "../../../packages/core/src/lifecycle-saga.ts"), functions: ["runActivationSagaAtUid", "headSetCurrentRootCredential", "gateCreateFrozen", "gateReopen"] },
      { file: join(smokeDir, "../../../packages/core/src/native-uid-custody.ts"), functions: ["assertOrdinaryNativeMutation", "invalid"] },
      { file: join(smokeDir, "../src/credential-ledger.ts"), functions: ["stageAgentMint", "finalizeAgentMint"] },
    ];
    const renderExpr = (node: ts.Expression, sf: ts.SourceFile, env: Map<string, string[]>): string[] => {
      if (ts.isParenthesizedExpression(node)) return renderExpr(node.expression, sf, env);
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isIdentifier(node)) return env.get(node.text) ?? [`<${node.text}>`];
      if (ts.isTemplateExpression(node)) {
        let acc = [node.head.text];
        for (const span of node.templateSpans) {
          const vals = renderExpr(span.expression, sf, env);
          acc = acc.flatMap((prefix) => vals.map((v) => `${prefix}${v}${span.literal.text}`));
        }
        return acc;
      }
      if (ts.isConditionalExpression(node)) {
        const cond = node.condition.getText(sf);
        if (cond === 'boundary === "spawn"') return renderExpr(node.whenFalse, sf, env);
        return [...renderExpr(node.whenTrue, sf, env), ...renderExpr(node.whenFalse, sf, env)];
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = renderExpr(node.left, sf, env), right = renderExpr(node.right, sf, env);
        return left.flatMap((l) => right.map((r) => `${l}${r}`));
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        if (callee.endsWith(".join")) return ["sample_token"];
        const argc = node.arguments.length;
        if (argc === 1) return renderExpr(node.arguments[0]!, sf, env);
        if (argc >= 2 && /EpEnvelopeError|lifecycleBlocked|RequestBodyError|definitiveLedgerRefusal/.test(callee))
          return renderExpr(node.arguments[1]!, sf, env);
      }
      if (ts.isNewExpression(node) && node.arguments?.length) {
        const callee = node.expression.getText(sf);
        const idx = callee === "EpEnvelopeError" || callee === "RequestBodyError" ? 1 : 0;
        if (node.arguments[idx]) return renderExpr(node.arguments[idx]!, sf, env);
      }
      return ["sample_token"];
    };
    const scraped = new Map<string, string>();
    for (const { file, functions } of scrapeTargets) {
      const text = readFileSync(file, "utf8");
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const shortFile = file.replace(/^.*\/(implementations|packages)\//, "$1/");
      const visitDecl = (node: ts.Node) => {
        const name = (ts.isFunctionDeclaration(node) && node.name?.text)
          || (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? node.name.text : undefined);
        if (name && functions.includes(name)) {
          const env = new Map<string, string[]>([
            ["actor", ["seat"]], ["leaf", ["seat"]], ["owner", ["u_owner"]], ["space", ["sp"]],
            ["lifecycleUid", ["uid00000000000000000000001"]], ["credid", ["cred0000000000000000000001"]],
            ["key", ["cred.uid.cid"]], ["parentKey", ["u_owner.cli"]], ["childKey", ["u_owner.mid"]],
          ]);
          const walk = (n: ts.Node) => {
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !env.has(n.name.text)) {
              if (ts.isArrowFunction(n.initializer) && n.initializer.body && !ts.isBlock(n.initializer.body))
                env.set(n.name.text, renderExpr(n.initializer.body, sf, env));
              else if (!ts.isArrowFunction(n.initializer) && !ts.isFunctionExpression(n.initializer))
                env.set(n.name.text, renderExpr(n.initializer, sf, env));
            }
            if (ts.isThrowStatement(n) && n.expression) {
              const exprText = n.expression.getText(sf);
              if (!/^(?:e|err|error)$/.test(exprText) && !exprText.startsWith("invalid(")) {
                const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
                const samples = exprText === "deny()" ? (env.get("deny") ?? []) : renderExpr(n.expression, sf, env);
                for (const s of samples) {
                  const full = name === "invalid" ? `native UID custody ${s}; reconcile the authority stores` : s;
                  scraped.set(`${shortFile}:${line}:${full}`, full);
                }
              }
            }
            ts.forEachChild(n, walk);
          };
          walk(node);
        }
        ts.forEachChild(node, visitDecl);
      };
      visitDecl(sf);
    }
    const sentenceClasses: ReadonlyArray<{ pattern: RegExp; expectedDefinitive: boolean }> = [
      // Definitive identity / grant / delegation / lifecycle terminal refusals -> close resident socket:
      { pattern: /^agent exchange refused: unknown agent or wrong secret - /, expectedDefinitive: true },
      { pattern: /^agent "[^"]+": its delegation chain contains a cycle at /, expectedDefinitive: true },
      { pattern: /^agent "[^"]+": spawner "[^"]+"(?: \(an ancestor\))? is no longer granted - /, expectedDefinitive: true },
      { pattern: /^agent "[^"]+" cannot be delegated by spawner "[^"]+" of a different owner - /, expectedDefinitive: true },
      { pattern: /^agent "[^"]+" exceeds its spawner's CURRENT grant \(narrowed since spawn\): /, expectedDefinitive: true },
      { pattern: /^agent "[^"]+": its ancestor "[^"]+" exceeds its spawner's CURRENT grant \(narrowed since spawn\): /, expectedDefinitive: true },
      { pattern: /^actor "[^"]+" has no lifecycleUid on its ledger row - /, expectedDefinitive: true },
      { pattern: /^the root credential for "[^"]+" \([^)]+\) is \S+; rotating a root credential /, expectedDefinitive: true },
      { pattern: /^the root credential for "[^"]+" expired at /, expectedDefinitive: true },
      { pattern: /^uid \S+ has a terminally retired issuance gate;/, expectedDefinitive: true },
      { pattern: /^uid \S+ is reserved by /, expectedDefinitive: true },
      { pattern: /^lifecycle "[^"]+" is retiring \(op /, expectedDefinitive: true },
      { pattern: /^lifecycle "[^"]+" is active at uid /, expectedDefinitive: true },
      { pattern: /^lifecycle \S+ has immutable service custody;/, expectedDefinitive: true },
      { pattern: /^lifecycle head \S+ carries service custody;/, expectedDefinitive: true },
      // Non-definitive / transient / barrier-in-flight / corruption / manager-selection / syntax -> keep & retry:
      { pattern: /^too many (?:pinned )?manager-caller selection refusals - /, expectedDefinitive: false },
      { pattern: /^the credential row \S+ carries a \S+ marker;/, expectedDefinitive: false },
      { pattern: /^the head for "[^"]+" (?:names root credential|already names root credential)/, expectedDefinitive: false },
      { pattern: /^the root credential row for "[^"]+" binds /, expectedDefinitive: false },
      { pattern: /^the root-credential ensure for "[^"]+" at uid \S+ keeps losing /, expectedDefinitive: false },
      { pattern: /^activateLifecycleAtUid requires a managerInstance /, expectedDefinitive: false },
      { pattern: /^(?:activation|the gate touch) for .* (?:keeps losing|lost the head CAS|is ambiguous)/, expectedDefinitive: false },
      { pattern: /^the issuance gate for \S+ (?:is frozen by|is open but|does not exist|is "\S+", not frozen|was terminalized)/, expectedDefinitive: false },
      { pattern: /^an issuance gate is born only under an activation intent/, expectedDefinitive: false },
      { pattern: /^(?:no uid reservation exists|the uid reservation for \S+ carries|uid \S+ has immutable service custody; an ordinary gate)/, expectedDefinitive: false },
      { pattern: /^(?:setCurrentRootCredential requires|stamping the root credential for)/, expectedDefinitive: false },
      { pattern: /^native UID custody .* reconcile the authority stores$/, expectedDefinitive: false },
      { pattern: /^(?:exp .* is not a non-negative safe integer|lifecycle \S+ has no (?:uid reservation|issuance gate)|the mint's holderPrincipal|the issuance gate for \S+ is "\S+"; only an open gate|the presented handle|the source gate for handle|the staged mint|the gate \S+ was observed at two revisions|the mint for \S+ lost its fence)/, expectedDefinitive: false },
    ];
    const sentences = [...new Set([...scraped.values()].filter((s) => !s.startsWith("sample_token")))];
    const unclassified: string[] = [];
    const mismatched: Array<{ sentence: string; expected: boolean; actual: boolean }> = [];
    let sawDirectNarrow = false, sawAncestorNarrow = false;
    for (const text of sentences) {
      if (/^agent "seat" exceeds its spawner's CURRENT grant/.test(text)) sawDirectNarrow = true;
      if (/^agent "seat": its ancestor "u_owner\.mid" exceeds its spawner's CURRENT grant/.test(text)) sawAncestorNarrow = true;
      const rule = sentenceClasses.find((c) => c.pattern.test(text));
      if (!rule) { unclassified.push(text); continue; }
      const err = bearerCommandFailure({ name: "Error", message: "exit 1", code: 1 } as never, `agent-bearer: exchange refused: ${text}\n`, 15_000, "http-status 401\n") as Error & { bearerRefused?: boolean };
      const actual = err.bearerRefused === true;
      if (actual !== rule.expectedDefinitive) mismatched.push({ sentence: text, expected: rule.expectedDefinitive, actual });
    }
    check("source-scraped exchange refusal inventory covers both direct-spawner and ancestor narrowing",
      sentences.length >= 25 && sawDirectNarrow && sawAncestorNarrow, { count: sentences.length, sawDirectNarrow, sawAncestorNarrow });
    check("every source-scraped exchange refusal sentence is classified and matches bearerCommandFailure",
      unclassified.length === 0 && mismatched.length === 0, { unclassified, mismatched });
  }

  const epOwner = ownerOf("endpoint-human");
  const endpointOf = (owner: string, actor: string, source: () => Promise<string>) => new CotalEndpoint({
    space: a.space, servers: fx.servers, sentinelCreds: a.sentinelCreds, bearer: source,
    card: { owner, actor, name: actor, kind: "agent" }, channels: ["general"],
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  const refusedEp = endpointOf(epOwner, "ep", () => sign(epOwner, "ep", privateKey as CryptoKey));
  const warnings: Array<{ at: number; msg: string }> = [];
  refusedEp.on("warning", (e: Error) => warnings.push({ at: Date.now(), msg: e.message }));
  refusedEp.on("error", () => {});
  await refusedEp.start();
  const epBearer = await sign(epOwner, "ep", privateKey as CryptoKey);
  await dial(epBearer); await dial(epBearer); // the actor's other two connects this minute
  const kicked = Date.now();
  await refusedEp.reconnect().catch(() => {});
  const refusedLine = new RegExp(`^the broker refused this endpoint's bearer for ${epOwner}\\.ep - retrying in (\\d+)s; the space's auth service logs why$`);
  for (let i = 0; i < 100 && !warnings.some((w) => refusedLine.test(w.msg)); i++) await new Promise((r) => setTimeout(r, 100));
  const said = warnings.find((w) => refusedLine.test(w.msg));
  check("an endpoint whose bearer the broker refuses says so, and where the reason is", said !== undefined, warnings);
  const firstWait = Number(refusedLine.exec(said?.msg ?? "")?.[1]);
  check("its first retry waits a random point in the upper half of the 3s step", firstWait >= 2 && firstWait <= 3, { firstWait, after: (said?.at ?? 0) - kicked });
  await refusedEp.stop();

  const calls: number[] = [];
  const pacedOwner = ownerOf("endpoint-paced");
  const pacedEp = endpointOf(pacedOwner, "rf", async () => {
    calls.push(Date.now());
    if (calls.length === 2) throw Object.assign(new Error("actor rf is over its limit of 3 connects a minute - retry in 7s"), { retryAfterSeconds: 7 });
    return sign(pacedOwner, "rf", privateKey as CryptoKey, now() + 10); // past its renewal window at once, so renewed at the 5s floor
  });
  pacedEp.on("warning", () => {});
  pacedEp.on("error", () => {});
  await pacedEp.start();
  for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  const rebuilt = await pacedEp.reconnect().then(() => true, () => false);
  check("a rebuild inside that wait dials on the held bearer without asking the source", calls.length === 2 && rebuilt, { calls: calls.length, rebuilt });
  for (let i = 0; i < 400 && calls.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  const gap = (calls[2] ?? Infinity) - (calls[1] ?? 0);
  // Its tokens are born past their renewal window, so the rebuild after the third call may renew at
  // once: the cell grades the gap the wait set, not how many calls followed it.
  check("a bearer source's retryAfterSeconds is kept exactly: asked again after 7s, not on the 2.5-5s backoff", calls.length >= 3 && gap >= 7_000 && gap < 9_000, { calls: calls.length, gap });
  await pacedEp.stop();

  await calloutNc.close();
  calloutNc = undefined;

  // ---- L3: the shipped service, its callout and its exchange share one limiter ---------------------
  console.log("L3) the exchange refuses an actor the callout has limited");
  const idpKeys = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(idpKeys.publicKey), kid: "limit-idp", alg: "EdDSA" };
  idpServer = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((r) => idpServer!.listen(0, "127.0.0.1", r));
  const IDP = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;
  writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${IDP}/api/auth`, issuer: IDP, audience: IDP, jwksUri: `${IDP}/jwks` }), { mode: 0o600 });
  const human = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, IDP, "limit-human");
  for (const actor of ["cli", "loop", "other"]) grantActor(a.stateDir, { owner: human, actor, scope: [], allowSubscribe: ["general"], allowPublish: ["general"] });
  const secret = newActorToken();
  grantManagedActor(a.stateDir, { custody: { kind: "foreground" }, owner: human, actor: "seat", scope: [], allowSubscribe: ["general"], allowPublish: ["general"],
    parent: `${human}.cli`, tokenHash: secret.tokenHash, lifecycleUid: mintLifecycleUid() });
  const serviceJournal: string[] = [];
  console.error = (...args: unknown[]) => { serviceJournal.push(args.map(String).join(" ")); };
  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity,
    connectLimits: { actorPerMinute: 2 },
  });
  const proof = () => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "limit-idp" }).setSubject("limit-human").setIssuer(IDP)
    .setAudience(IDP).setIssuedAt(now()).setExpirationTime(now() + 600).sign(idpKeys.privateKey);
  const exchange = async (body: Record<string, unknown>) => {
    const res = await fetch(`${service!.url}/exchange`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify(body) });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() as Record<string, unknown> };
  };
  const human1 = await exchange({ idpToken: await proof(), actor: "loop" });
  const agent1 = await exchange({ owner: human, actor: "seat", actorToken: secret.actorToken });
  check("before any connect, the human and agent exchanges mint", human1.status === 200 && agent1.status === 200, { human1, agent1 });
  const hb = String(human1.body.token), ab = String(agent1.body.token);
  const minted = [await dial(hb), await dial(hb), await dial(ab), await dial(ab)];
  const over = [await dial(hb), await dial(ab)];
  check("the service's callout mints each actor up to its limit and then refuses it", minted.every((r) => r.ok) && over.every((r) => !r.ok), { minted, over });
  check("the service journals each limited connect with its owner and actor",
    denials(serviceJournal).filter((d) => d.owner === human && /^RATE_LIMITED retry-after \d+s: actor (loop|seat) of owner /.test(d.reason)).length === 2, serviceJournal.slice(-4));
  const human2 = await exchange({ idpToken: await proof(), actor: "loop" });
  check("the human exchange for the limited actor answers 429 RATE_LIMITED naming the actor's limit", human2.status === 429 && human2.body.code === "RATE_LIMITED" && human2.body.limit === "actor", human2);
  const secs = human2.body.retryAfterSeconds;
  check("its retryAfterSeconds is a whole number of seconds, sent again as Retry-After", Number.isSafeInteger(secs) && (secs as number) >= 1 && (secs as number) <= 30 && human2.retryAfter === String(secs), human2);
  check("its error is one sentence naming the actor, the owner, the limit and the wait",
    human2.body.error === `actor loop of owner ${human} is over its limit of 2 connects a minute - retry in ${secs}s`, human2.body.error);
  const agent2 = await exchange({ owner: human, actor: "seat", actorToken: secret.actorToken });
  check("the managed-agent exchange for its limited actor answers the same 429", agent2.status === 429 && agent2.body.code === "RATE_LIMITED" && agent2.retryAfter === String(agent2.body.retryAfterSeconds), agent2);
  const other2 = await exchange({ idpToken: await proof(), actor: "other" });
  check("another actor of the same owner still mints", other2.status === 200 && typeof other2.body.token === "string", other2.status);
  check("the 429 is journaled as an exchange refusal", serviceJournal.some((l) => /auth-service: refused an exchange: RATE_LIMITED retry-after \d+s: actor loop of owner /.test(l)), serviceJournal.slice(-4));
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? String(e)}`, false);
} finally {
  console.error = realConsoleError;
  await service?.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  idpServer?.close();
  await fx.close();
}
finish();
