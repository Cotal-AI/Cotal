/** The delivery-admin eviction seam moved to `@cotal-ai/workspace`, where the delivery daemon's
 *  endpoint registration also uses it. Re-exported here so the manager's importers stay unchanged. */
export {
  DELIVERY_ADMIN_BOOT_WAIT_MS,
  isUnansweredDeliveryAdmin,
  makeManagerEndpointEvictionEvidence,
  makeManagerEndpointHolderEvictor,
  untilDeliveryAdminAnswers,
  withScopedEndpoint,
} from "@cotal-ai/workspace";
