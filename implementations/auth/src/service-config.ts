/** Auth service input configuration and per-space manifest grammar. */
import { type ParsedArgs } from "@cotal-ai/core";
import { parseSpaceManifest, type SpaceSettings, type SpaceSettingsManifest } from "@cotal-ai/workspace";
import { calloutLimits, type AuthCalloutLimits } from "./callout.js";

type Values = Record<string, string | undefined>;

/** Pure native daemon input validation, shared with its explicit service launch plan. */
export function authServiceConfiguration(args: ParsedArgs) {
  const v = args.values as Values;
  // A callout replica serves no HTTP and hosts no service endpoint, so a flag for either is a
  // config error rather than a silently ignored option.
  const calloutOnly = v["callout-only"] !== undefined;
  // `--spaces` names a manifest of spaces one process serves, one lane each: callout lanes with
  // `--callout-only`, full services without. It stands in for `--space` rather than defaulting
  // beside it, so neither mode is ever entered by omission.
  const spaces = v.spaces;
  if (spaces !== undefined) {
    if (v.space !== undefined) throw new Error("auth-service: --space and --spaces are alternatives - name one space or a manifest of spaces, not both");
    if (spaces.trim() === "") throw new Error("auth-service: --spaces needs the path of a space manifest");
    // Each space's listeners are its own: an ephemeral loopback port, and the public face its
    // manifest entry names. A flag would set one value for every space.
    const perSpace = ["port", "exchange-public-port", "exchange-public-url", "exchange-trusted-proxy", "advertised-server", "agent-provisioning-url"]
      .filter((name) => v[name] !== undefined);
    if (!calloutOnly && perSpace.length > 0)
      throw new Error(`auth-service: --spaces gives each space an ephemeral loopback port and sets its public face in its manifest entry - drop ${perSpace.map((name) => `--${name}`).join(", ")}`);
    // Whether a space hosts service endpoints is its own setting too, so the flag would turn them on
    // for every space. The manifest entry alone says it, and the flag refuses rather than defaulting.
    if (!calloutOnly && v["service-endpoints"] !== undefined)
      throw new Error('auth-service: --spaces takes service endpoints per space - set "serviceEndpoints": true on the manifest entry of each space that hosts them and drop --service-endpoints');
    if (!calloutOnly && v.registry !== undefined)
      throw new Error('auth-service: --spaces takes registry per space - set "registry": true on each intended manifest entry and drop --registry');
  } else if (!v.space) {
    throw new Error("auth-service: --space is required (or --spaces <manifest> to serve several spaces from this one process)");
  }
  const space = v.space ?? "";
  const server = v.server;
  if (!server) throw new Error("auth-service: --server is required (the broker this callout serves)");
  if (calloutOnly) {
    const http = ["port", "exchange-public-port", "exchange-public-url", "exchange-trusted-proxy", "advertised-server", "agent-provisioning-url", "service-endpoints", "registry"]
      .filter((name) => v[name] !== undefined);
    if (http.length > 0)
      throw new Error(`auth-service: --callout-only answers the callout alone and serves no HTTP or service endpoint - drop ${http.map((name) => `--${name}`).join(", ")}`);
  }
  const port = v.port === undefined ? 0 : Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`auth-service: --port must be a port number, got "${v.port}"`);
  // The optional PUBLIC exchange face (see the module header). The three flags travel together:
  // a public URL or trusted-proxy setting without a listener to apply them to is a config error.
  const publicPortRaw = v["exchange-public-port"];
  const publicPort = publicPortRaw === undefined ? undefined : Number(publicPortRaw);
  if (publicPort !== undefined && (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535))
    throw new Error(`auth-service: --exchange-public-port must be a port number, got "${publicPortRaw}"`);
  const publicUrlFlag = v["exchange-public-url"];
  const trustedProxy = v["exchange-trusted-proxy"] !== undefined;
  if (publicPort === undefined && (publicUrlFlag !== undefined || trustedProxy))
    throw new Error("auth-service: --exchange-public-url/--exchange-trusted-proxy require --exchange-public-port");
  const advertisedServer = v["advertised-server"];
  if (advertisedServer !== undefined && publicPort === undefined)
    throw new Error("auth-service: --advertised-server rides the public bundle - it requires --exchange-public-port");
  const agentProvisioningUrl = v["agent-provisioning-url"];
  if (agentProvisioningUrl !== undefined && publicPort === undefined)
    throw new Error("auth-service: --agent-provisioning-url rides the public bundle - it requires --exchange-public-port");
  const publicFace = publicPort === undefined ? undefined : { port: publicPort, url: publicUrlFlag, trustedProxy, advertisedServer, agentProvisioningUrl };
  const badFace = publicFace && checkPublicFace(publicFace);
  if (badFace) throw new Error(badFace);
  // Service endpoints are off unless the flag names them (or, under --spaces, a space's manifest
  // entry): an absent flag opens no engine, no discovery connection and no door, and the routes
  // answer 404 as before.
  const serviceEndpoints = v["service-endpoints"] !== undefined;
  // The broker's `authorization { timeout }`, which `cotal up` renders and passes here from the same
  // value. Absent: the callout's default, which is nats-server's.
  const authTimeoutRaw = v["auth-timeout"];
  const authTimeout = authTimeoutRaw === undefined ? undefined : Number(authTimeoutRaw);
  if (authTimeout !== undefined && (!/^[1-9][0-9]*$/.test(authTimeoutRaw!) || !Number.isSafeInteger(authTimeout)))
    throw new Error(`auth-service: --auth-timeout must be a positive whole number of seconds, got "${authTimeoutRaw}"`);
  const limits: AuthCalloutLimits | undefined = authTimeout === undefined ? undefined : { authTimeoutMs: authTimeout * 1000 };
  if (limits !== undefined) calloutLimits(limits);

  return { space, spaces, server, port, publicFace, serviceEndpoints, registry: v.registry !== undefined, calloutOnly, calloutLimits: limits };
}

/** The public-face fields of an `auth-service --spaces` manifest entry: the public-face flags of
 *  `auth-service --space`, under the same names in camel case. */
const AUTH_HOST_FACE_FIELDS = ["exchangePublicPort", "exchangePublicUrl", "exchangeTrustedProxy", "advertisedServer", "agentProvisioningUrl"] as const;

/** The fields of an `auth-service --spaces` manifest entry besides `space`: the public face, and
 *  `serviceEndpoints`, the per-space form of `--service-endpoints`. */
const AUTH_HOST_ENTRY_FIELDS = [...AUTH_HOST_FACE_FIELDS, "serviceEndpoints", "registry"] as const;

/** One space's settings in an `auth-service --spaces` manifest, read from its entry. */
export interface AuthHostEntry {
  /** The space's public face, or `null` for an entry without `exchangePublicPort`. */
  publicFace: PublicFaceInput | null;
  /** Whether the space's lane hosts service endpoints, as `--service-endpoints` does for one space.
   *  An absent field is `false`. */
  serviceEndpoints: boolean;
  /** Default off; only this lane hosts the registry when true. */
  registry?: boolean;
}

/** Reads one space's public face from its entry's public-face fields, under the rules the flags
 *  follow. `null` is a space with no public face. */
function authHostPublicFace(fields: Readonly<Record<string, unknown>>): PublicFaceInput | null {
  const { exchangePublicPort: port, exchangePublicUrl: url, exchangeTrustedProxy: trustedProxy, advertisedServer, agentProvisioningUrl } = fields;
  if (port === undefined) {
    const riders = AUTH_HOST_FACE_FIELDS.slice(1).filter((k) => fields[k] !== undefined);
    if (riders.length) throw new Error(`${riders.join(", ")} ride${riders.length === 1 ? "s" : ""} the public face - set exchangePublicPort too`);
    return null;
  }
  if (typeof port !== "number") throw new Error(`exchangePublicPort must be a port number, got ${JSON.stringify(port)}`);
  for (const [name, value] of [["exchangePublicUrl", url], ["advertisedServer", advertisedServer], ["agentProvisioningUrl", agentProvisioningUrl]] as const)
    if (value !== undefined && typeof value !== "string") throw new Error(`${name} must be a string, got ${JSON.stringify(value)}`);
  if (trustedProxy !== undefined && typeof trustedProxy !== "boolean") throw new Error(`exchangeTrustedProxy must be true or false, got ${JSON.stringify(trustedProxy)}`);
  const face: PublicFaceInput = {
    port,
    ...(url !== undefined ? { url: url as string } : {}),
    trustedProxy: trustedProxy === true,
    ...(advertisedServer !== undefined ? { advertisedServer: advertisedServer as string } : {}),
    ...(agentProvisioningUrl !== undefined ? { agentProvisioningUrl: agentProvisioningUrl as string } : {}),
  };
  const bad = checkPublicFace(face);
  if (bad) throw new Error(bad.replace(/^auth-service: /, ""));
  return face;
}

/** Reads one space's settings from its version 2 manifest entry, under the rules the flags follow,
 *  and refuses two spaces naming one port. */
const authHostSettings: SpaceSettings<AuthHostEntry> = {
  parse(_space, fields) {
    const unknown = Object.keys(fields).filter((k) => !(AUTH_HOST_ENTRY_FIELDS as readonly string[]).includes(k));
    if (unknown.length) throw new Error(`unknown field(s) ${unknown.join(", ")}; an entry takes space, ${AUTH_HOST_ENTRY_FIELDS.join(", ")}`);
    const publicFace = authHostPublicFace(fields);
    const { serviceEndpoints, registry } = fields;
    if (serviceEndpoints !== undefined && typeof serviceEndpoints !== "boolean") throw new Error(`serviceEndpoints must be true or false, got ${JSON.stringify(serviceEndpoints)}`);
    if (registry !== undefined && typeof registry !== "boolean") throw new Error("registry must be true or false");
    return { publicFace, serviceEndpoints: serviceEndpoints === true, registry: registry === true };
  },
  across(settings) {
    const ports = new Map<number, string>();
    for (const [space, { publicFace: face }] of settings) {
      if (face === null || face.port === 0) continue;
      const other = ports.get(face.port);
      if (other !== undefined) throw new Error(`spaces "${other}" and "${space}" both name exchangePublicPort ${face.port}; each space's public face needs its own port`);
      ports.set(face.port, space);
    }
  },
};

/** Parse an `auth-service --spaces` manifest with the rules the host applies to every read of it:
 *  the version 2 grammar, each entry's fields and the checks across entries. Throws naming what is
 *  wrong, with the message the host logs. A writer checks a manifest with it before renaming the
 *  file into place. */
export function parseAuthHostManifest(text: string): SpaceSettingsManifest<AuthHostEntry> {
  return parseSpaceManifest(text, authHostSettings);
}

/** The optional public exchange face: the CLI's `--exchange-public-*`, `--advertised-server` and
 *  `--agent-provisioning-url` flags, or the hosted `publicFace` input. */
export interface PublicFaceInput {
  port: number;
  url?: string;
  trustedProxy: boolean;
  advertisedServer?: string;
  agentProvisioningUrl?: string;
}

/** The advertised broker address the public bundle carries — the URL participants will dial, so
 *  the same scheme family `cotal meshes add` accepts. Exported for the producer/consumer contract
 *  smoke; returns the refusal sentence, or undefined when the address is usable. */
export function checkAdvertisedServer(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `auth-service: --advertised-server is not a URL, got "${raw}"`;
  }
  if (!["nats:", "tls:", "ws:", "wss:"].includes(u.protocol))
    return `auth-service: --advertised-server must be a broker URL (nats://, tls://, ws:// or wss://), got ${u.protocol}//`;
  return undefined;
}

/** The public face's value rules, one set for the CLI flags and the hosted input. A public face
 *  without a port has no listener for the rest to apply to. */
function checkPublicFace(face: PublicFaceInput): string | undefined {
  if (!Number.isInteger(face.port) || face.port < 0 || face.port > 65535)
    return `auth-service: a public face needs a port number, got ${face.port}`;
  if (face.url !== undefined && !/^https:\/\//.test(face.url))
    return `auth-service: --exchange-public-url must be an https:// URL (TLS terminates at the reverse proxy), got "${face.url}"`;
  return (face.advertisedServer !== undefined ? checkAdvertisedServer(face.advertisedServer) : undefined)
    ?? (face.agentProvisioningUrl !== undefined ? checkAgentProvisioningUrl(face.agentProvisioningUrl) : undefined);
}

/** The advertised agent-provisioning endpoint: HTTPS only — spawn sends the login bearer to it,
 *  and a plaintext or non-URL value must be refused at startup, not discovered by a participant.
 *  Exported for the producer/consumer contract smoke; returns the refusal, or undefined when
 *  usable. */
export function checkAgentProvisioningUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `auth-service: --agent-provisioning-url is not a URL, got "${raw}"`;
  }
  if (u.protocol !== "https:")
    return `auth-service: --agent-provisioning-url must be https:// (the login bearer rides the request), got ${u.protocol}//`;
  return undefined;
}

export { authHostSettings, checkPublicFace };
