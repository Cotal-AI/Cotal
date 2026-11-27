import type { EndpointAnycast } from "./endpoint-anycast.js";
import type { EndpointBootMemberships } from "./endpoint-boot-memberships.js";
import type { EndpointChannelDiscovery } from "./endpoint-channel-discovery.js";
import type { EndpointConnection } from "./endpoint-connection.js";
import type { EndpointConsumers } from "./endpoint-consumers.js";
import type { EndpointControlPlane } from "./endpoint-control-plane.js";
import type { EndpointCredentials } from "./endpoint-credentials.js";
import type { EndpointDeliveryLease } from "./endpoint-delivery-lease.js";
import type { EndpointDeliveryPlane } from "./endpoint-delivery-plane.js";
import type { EndpointDurableBackstop } from "./endpoint-durable-backstop.js";
import type { EndpointDurable } from "./endpoint-durable.js";
import type { EndpointHistory } from "./endpoint-history.js";
import type { EndpointLiveness } from "./endpoint-liveness.js";
import type { EndpointPresence } from "./endpoint-presence.js";
import type { EndpointPrincipalServe } from "./endpoint-principal-serve.js";
import type { EndpointProvisioning } from "./endpoint-provisioning.js";
import type { EndpointReconnect } from "./endpoint-reconnect.js";
import type { EndpointSubscriptions } from "./endpoint-subscriptions.js";

/** The endpoint's parts, by name. The endpoint builds every part, then fills this record at the end of
 *  its constructor, so a part reads a peer from it at use and never in its own constructor. Each part
 *  types its view as a `Pick` of the peers it calls. */
export interface EndpointParts {
  anycastRail: EndpointAnycast;
  bootMemberships: EndpointBootMemberships;
  channelDiscovery: EndpointChannelDiscovery;
  connection: EndpointConnection;
  consumers: EndpointConsumers;
  controlPlane: EndpointControlPlane;
  credentials: EndpointCredentials;
  deliveryLease: EndpointDeliveryLease;
  deliveryPlane: EndpointDeliveryPlane;
  durable: EndpointDurable;
  durableBackstop: EndpointDurableBackstop;
  history: EndpointHistory;
  liveness: EndpointLiveness;
  presence: EndpointPresence;
  principalServe: EndpointPrincipalServe;
  provisioning: EndpointProvisioning;
  reconnection: EndpointReconnect;
  subscriptions: EndpointSubscriptions;
}
