import type { NatsConnection } from "@nats-io/transport-node";

/** One connection as the broker names it: the public key of the server that holds it and the
 *  client id that server assigned. A host matches bindings against a complete native account
 *  census. A binding carries no credential and grants nothing. */
export interface NativeConnectionBinding {
  serverId: string;
  cid: number;
}

/** Read a connection's binding from the server's INFO. Throws when the connection is closed or the
 *  INFO lacks a server public key or a positive client id. A connection that is redialing still
 *  holds its previous INFO, so a caller that keeps the connection follows its status with
 *  {@link watchNativeConnection} and reads the binding through that. */
export function nativeConnectionBinding(nc: NatsConnection, what: string): NativeConnectionBinding {
  const serverId = nc.info?.server_id, cid = nc.info?.client_id;
  if (nc.isClosed() || typeof serverId !== "string" || !/^N[A-Z2-7]{55}$/.test(serverId) || !Number.isSafeInteger(cid) || cid! <= 0)
    throw new Error(`${what} has no settled native binding`);
  return { serverId, cid: cid! };
}

/** Whether a status event leaves the connection without a binding (`false`), gives it one (`true`),
 *  or says nothing about it (`undefined`). A requested reconnect is reported before the socket
 *  closes, so the previous binding stops being reported from the request on. */
export function nativeBindingAfter(type: string): boolean | undefined {
  if (type === "reconnect") return true;
  if (type === "disconnect" || type === "forceReconnect" || type === "staleConnection" || type === "close") return false;
  return undefined;
}

/** Follow one connection's status stream. `binding()` returns the connection's binding while it is
 *  connected and throws while it is down, redialing or closed. Start it on a connected client. */
export function watchNativeConnection(nc: NatsConnection, what: string): { binding(): NativeConnectionBinding } {
  let bound = !nc.isClosed();
  void (async () => {
    for await (const status of nc.status()) bound = nativeBindingAfter(status.type) ?? bound;
    bound = false;
  })().catch(() => { bound = false; });
  return {
    binding: () => {
      if (!bound) throw new Error(`${what} is not connected, so it has no settled native binding`);
      return nativeConnectionBinding(nc, what);
    },
  };
}
