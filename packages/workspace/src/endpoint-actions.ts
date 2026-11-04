import type { Extension } from "@cotal-ai/core";
import type { OutputWarning } from "./output.js";

/** An already-resolved local operator target. No credential bytes cross the action seam. */
export interface EndpointDeregisterRequest {
  readonly root: string;
  readonly space: string;
  readonly server: string;
  readonly tlsRequired: boolean;
  readonly account: string;
  readonly endpoint: string;
  readonly instanceId: string;
}

export interface EndpointDeregisterResult {
  readonly kind: "endpoint-deregistered";
  readonly space: string;
  readonly endpoint: string;
  readonly instanceId: string;
  readonly probe: "broker-affirmed-gone";
  readonly removedSpecRevision: number;
  readonly removedStatusRevision: number | null;
  readonly processStopped: false;
  readonly issuanceGateChanged: false;
  readonly warnings: readonly OutputWarning[];
}

/** A workstation provider over the existing native guard, not a wire command or broader grant. */
export interface EndpointDeregisterAction extends Extension {
  readonly kind: "endpoint-action";
  readonly name: "deregister";
  run(request: EndpointDeregisterRequest): Promise<EndpointDeregisterResult>;
}
