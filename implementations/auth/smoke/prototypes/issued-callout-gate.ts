import { decode, type AuthorizationResponse } from "@nats-io/jwt";
import { fromCurveSeed } from "@nats-io/nkeys";
import { startAuthCallout, type CalloutMsg, type StartAuthCalloutOpts } from "../../src/callout.js";
import type { ValidatedUserToken } from "../../src/token.js";

export function issuedCalloutName(generation: string, inboxNonce: string): string {
  if (!/^[a-f0-9]{32}$/.test(generation) || !/^[a-f0-9]{32}$/.test(inboxNonce))
    throw new Error("prototype callout requires separate 32-hex generation and inbox nonce");
  return `ia1_${generation}_${inboxNonce}`;
}
export function readIssuedCalloutName(name: string): { generation: string; inboxNonce: string } {
  const match = /^ia1_([a-f0-9]{32})_([a-f0-9]{32})$/.exec(name);
  if (!match) throw new Error("unsupported issued callout connection name");
  return Object.freeze({ generation: match[1], inboxNonce: match[2] });
}
export interface PreparedCalloutSuccess {
  token: ValidatedUserToken;
  connectionName: string;
  userJwt: string;
}

// Test-only transport. The shipped handler still owns request authentication and all
// response cryptography. Each invocation handles exactly one original broker message.
async function prepare(msg: CalloutMsg, opts: StartAuthCalloutOpts) {
  let response: Uint8Array | undefined;
  let context: { token: ValidatedUserToken; connectionName: string } | undefined;
  const single = {
    async *subscribe() {
      yield {
        data: msg.data, headers: msg.headers,
        respond(data: Uint8Array) {
          if (response) throw new Error("multiple responses for one callout request");
          response = new Uint8Array(data);
        },
      };
    },
  };
  await startAuthCallout(single, {
    ...opts,
    permissionsFor(token, connectionName) {
      context = { token, connectionName };
      return opts.permissionsFor(token, connectionName);
    },
  }).done;
  if (!response) return undefined; // The unchanged handler dropped an untrusted request.
  const peer = msg.headers?.get("Nats-Server-Xkey");
  if (!peer) throw new Error("prepared callout response has no server key");
  const curve = fromCurveSeed(new TextEncoder().encode(opts.xkeySeed));
  const plain = curve.open(response, peer);
  if (!plain) throw new Error("prepared callout response cannot be reopened");
  const claims = decode<AuthorizationResponse>(new TextDecoder().decode(plain));
  if (claims.nats.jwt) {
    if (!context || claims.nats.error) throw new Error("invalid prepared success context");
    return { bytes: response, success: { ...context, userJwt: claims.nats.jwt } };
  }
  if (!claims.nats.error) throw new Error("prepared callout response is neither success nor denial");
  return { bytes: response, success: undefined };
}

export async function gateIssuedCallout(
  msg: CalloutMsg,
  opts: StartAuthCalloutOpts,
  release: (success: PreparedCalloutSuccess) => Promise<void>,
): Promise<void> {
  const prepared = await prepare(msg, opts);
  if (!prepared) return;
  if (!prepared.success) { msg.respond(prepared.bytes); return; }
  try {
    await release(prepared.success);
  } catch {
    const denied = await prepare(msg, {
      ...opts,
      authorizeActor() { throw new Error("issued authority release refused; use a fresh authorized generation"); },
    });
    if (!denied || denied.success) throw new Error("failed to prepare a signed issuance denial");
    msg.respond(denied.bytes);
    return;
  }
  msg.respond(prepared.bytes);
}
