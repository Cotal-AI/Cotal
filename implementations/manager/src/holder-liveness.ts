/** The freeze-holder liveness probe moved to `@cotal-ai/workspace`, where the delivery daemon's
 *  endpoint registration also uses it to recover a frozen registration. Re-exported here so the
 *  manager's importers stay unchanged. */
export { holderLivenessFromReply, makeManagerHolderLivenessProbe } from "@cotal-ai/workspace";
