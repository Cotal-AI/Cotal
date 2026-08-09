/**
 * The broker's client-listener transport, and the checks that must pass before one is served.
 *
 * The shape here is deliberate. `BrokerTransport` is a REQUIRED discriminated union rather than an
 * optional `tls?:` field, because the failure this feature exists to prevent is a SILENT DOWNGRADE
 * TO PLAINTEXT. With an optional field, any future code path that regenerates the broker config and
 * forgets to thread it through renders a plaintext listener and says nothing; with a required union
 * that state is unrepresentable, and the compiler asks the question at every render site. The
 * protection is in the type, not in a test that someone has to remember to run.
 */
import { readFileSync, statSync } from "node:fs";
import { X509Certificate, createPrivateKey } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

/** How the broker serves its client port. Every `serverConfig` render must state one explicitly. */
export type BrokerTransport =
  | { readonly kind: "plaintext" }
  | { readonly kind: "tls-required"; readonly certFile: string; readonly keyFile: string };

export type TlsRequired = Extract<BrokerTransport, { kind: "tls-required" }>;

/** What a validated cert/key pair turned out to be. Returned so callers can log or compare it —
 *  notably the rotation path, which must prove the SERVED leaf matches the file on disk. */
export interface TlsMaterial {
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Colon-separated uppercase SHA-256 of the DER, exactly as `X509Certificate.fingerprint256`
   *  and `tls.PeerCertificate.fingerprint256` render it, so the two are directly comparable. */
  readonly fingerprint256: string;
  readonly subject: string;
}

/** Thrown for every rejected cert/key pair. A distinct type so callers can surface a
 *  CERTIFICATE cause to the operator rather than a generic "broker unreachable" — a TLS failure
 *  reported as unreachability invites exactly the wrong remedy. */
export class TlsMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsMaterialError";
  }
}

/**
 * Validate a cert/key pair BEFORE the broker is started or reloaded. Throws `TlsMaterialError`
 * on anything wrong; never returns a "degraded" result and never falls back to plaintext.
 *
 * This exists because nats-server's own checks are not sufficient. Missing, unreadable and
 * mismatched pairs do stop it before it opens a listener — but an EXPIRED certificate does not:
 * `nats-server -t` reports such a config valid, the process starts, logs "Server is ready" and
 * "TLS required for client connections", and only the CLIENT then fails with
 * `CERT_HAS_EXPIRED`. An expired cert must never be allowed to yield a "mesh up", so the validity
 * window is checked here.
 *
 * @param dialHost the hostname clients will DIAL and verify against, which is not the bind host:
 *                 a broker may bind `0.0.0.0` while clients verify `broker.example`. Omit only
 *                 when no dial name is known yet.
 */
export function validateTlsMaterial(t: TlsRequired, opts: { dialHost?: string; now?: Date } = {}): TlsMaterial {
  const now = opts.now ?? new Date();

  let certPem: string;
  try {
    certPem = readFileSync(t.certFile, "utf8");
  } catch (e) {
    throw new TlsMaterialError(`TLS certificate is not readable at ${t.certFile}: ${(e as Error).message}`);
  }

  let keyPem: string;
  try {
    keyPem = readFileSync(t.keyFile, "utf8");
  } catch (e) {
    throw new TlsMaterialError(`TLS private key is not readable at ${t.keyFile}: ${(e as Error).message}`);
  }

  // The private key must not be readable by group or other. The manager runs agent children under
  // the SAME OS uid, so file permissions are not a boundary against a hostile same-uid agent — but
  // a world-readable broker key is a much wider exposure than that, and refusing it is cheap.
  // POSIX mode bits do not map onto Windows ACLs, so the check applies where the concept exists.
  if (process.platform !== "win32") {
    const mode = statSync(t.keyFile).mode & 0o777;
    if (mode & 0o077)
      throw new TlsMaterialError(
        `TLS private key ${t.keyFile} is group/other-accessible (mode ${mode.toString(8).padStart(3, "0")}); ` +
        `tighten it to 600 before serving TLS`,
      );
  }

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch (e) {
    throw new TlsMaterialError(`TLS certificate at ${t.certFile} is not a parseable X.509 certificate: ${(e as Error).message}`);
  }

  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(keyPem);
  } catch (e) {
    throw new TlsMaterialError(`TLS private key at ${t.keyFile} is not a parseable private key: ${(e as Error).message}`);
  }

  if (!cert.checkPrivateKey(key))
    throw new TlsMaterialError(`TLS certificate ${t.certFile} and private key ${t.keyFile} are not a matching pair`);

  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  if (now < notBefore)
    throw new TlsMaterialError(`TLS certificate ${t.certFile} is not valid until ${notBefore.toISOString()} (now ${now.toISOString()})`);
  if (now > notAfter)
    throw new TlsMaterialError(`TLS certificate ${t.certFile} EXPIRED at ${notAfter.toISOString()} (now ${now.toISOString()}); nats-server would start and serve it anyway`);

  if (opts.dialHost !== undefined && cert.checkHost(opts.dialHost) === undefined)
    throw new TlsMaterialError(
      `TLS certificate ${t.certFile} does not cover the dial host "${opts.dialHost}" ` +
      `(subject ${cert.subject}, SAN ${cert.subjectAltName ?? "none"}); clients would fail hostname verification`,
    );

  return { notBefore, notAfter, fingerprint256: cert.fingerprint256, subject: cert.subject };
}

/** What the broker is actually serving right now, read off the wire. */
export interface ServedCert {
  readonly fingerprint256: string;
  readonly validTo: string;
  readonly subject: string;
}

/**
 * Open a real NATS STARTTLS connection and report the leaf certificate the broker is SERVING.
 *
 * This is the only honest proof that a rotation took effect. Renewing the files on disk does not
 * reload nats-server: the reference deployment renews its Let's Encrypt material on a timer and
 * the broker process has gone on serving the previous certificate for weeks, because nothing
 * signalled it. Comparing file mtimes, or trusting that a reload command exited zero, would both
 * have reported success there. Only reading back what the listener presents catches it.
 *
 * `rejectUnauthorized` is false on purpose: this call answers "which certificate is being served",
 * not "do I trust it". The caller compares the returned fingerprint to the file it intended to
 * install, which is a stronger and more specific check than chain validation.
 */
export async function probeServedCert(opts: {
  host: string;
  port: number;
  /** SNI/verification name, when it differs from the dial host. */
  servername?: string;
  timeoutMs?: number;
}): Promise<ServedCert> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  // The socket is carried out of this promise alongside the INFO because NATS STARTTLS upgrades
  // the SAME connection: reconnecting for the TLS half would probe a different socket, and on a
  // load-balanced or multi-listener deployment could read a different server's certificate.
  const { info, socket } = await new Promise<{ info: Record<string, unknown>; socket: net.Socket }>((resolve, reject) => {
    const sock = net.connect(opts.port, opts.host);
    let buf = "";
    const fail = (m: string) => { sock.destroy(); reject(new TlsMaterialError(m)); };
    sock.setTimeout(timeoutMs, () => fail(`no NATS INFO from ${opts.host}:${opts.port} within ${timeoutMs}ms`));
    sock.on("error", (e) => fail(`cannot reach ${opts.host}:${opts.port}: ${e.message}`));
    sock.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\r\n")[0];
      if (!line?.startsWith("INFO ")) return;
      try {
        resolve({ info: JSON.parse(line.slice(5)) as Record<string, unknown>, socket: sock });
      } catch (e) {
        fail(`unparseable NATS INFO from ${opts.host}:${opts.port}: ${(e as Error).message}`);
      }
    });
  });

  if (info.tls_required !== true) {
    socket.destroy();
    throw new TlsMaterialError(
      `${opts.host}:${opts.port} does not advertise tls_required — it is serving PLAINTEXT, so there is no served certificate to verify`,
    );
  }

  // Disarm the INFO phase before handing the socket over. Its inactivity timer is still running
  // and would destroy the connection mid-handshake on a slow peer, and its `data` handler would
  // otherwise keep consuming bytes that now belong to TLS.
  socket.setTimeout(0);
  socket.removeAllListeners("timeout");
  socket.removeAllListeners("data");
  socket.removeAllListeners("error");

  return await new Promise<ServedCert>((resolve, reject) => {
    const secure = tls.connect(
      { socket, servername: opts.servername ?? opts.host, rejectUnauthorized: false },
      () => {
        const peer = secure.getPeerCertificate();
        secure.destroy();
        if (!peer || !peer.fingerprint256)
          return reject(new TlsMaterialError(`${opts.host}:${opts.port} completed a TLS handshake but presented no leaf certificate`));
        resolve({ fingerprint256: peer.fingerprint256, validTo: peer.valid_to, subject: String(peer.subject?.CN ?? "") });
      },
    );
    secure.setTimeout(timeoutMs, () => { secure.destroy(); reject(new TlsMaterialError(`TLS handshake with ${opts.host}:${opts.port} timed out`)); });
    secure.on("error", (e) => reject(new TlsMaterialError(`TLS handshake with ${opts.host}:${opts.port} failed: ${e.message}`)));
  });
}

/**
 * Assert that the broker is serving exactly the certificate in `expected`. This is the rotation
 * gate: validate the new pair, install it, signal the broker, then call this. A mismatch means the
 * reload did not take, and the caller must fail loud and leave the previous listener in place —
 * never fall back to plaintext.
 */
export async function assertServedCertMatches(
  expected: TlsMaterial,
  where: { host: string; port: number; servername?: string; timeoutMs?: number },
): Promise<ServedCert> {
  const served = await probeServedCert(where);
  if (served.fingerprint256 !== expected.fingerprint256)
    throw new TlsMaterialError(
      `${where.host}:${where.port} is serving a DIFFERENT certificate than the one on disk — ` +
      `served ${served.fingerprint256} (expires ${served.validTo}), expected ${expected.fingerprint256} ` +
      `(expires ${expected.notAfter.toISOString()}). The reload did not take effect.`,
    );
  return served;
}
