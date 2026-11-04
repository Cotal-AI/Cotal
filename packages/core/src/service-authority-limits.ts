export const SERVICE_ACCESS_TTL_SECONDS = 60;
export const SERVICE_RENEWAL_TTL_SECONDS = 24 * 60 * 60;
export const SERVICE_AUTHORITY_MAX_BYTES = 2 * 1024 * 1024;
/** A bound on the header block of one caller-policy create or CAS, which a broker's `max_payload`
 *  counts with the body. The subject and publish line count against `max_control_line`, which is
 *  asserted separately, so this bound is conservative. */
export const SERVICE_CALLER_PAYLOAD_OVERHEAD = 1024;
/** The smallest broker `max_payload` under which every caller-policy row the headroom rule admits
 *  fits in one write. The auth host asserts it before caller issuance and `cotal up --max-payload`
 *  refuses a smaller limit on a space that admits service endpoints, so both read one number. */
export const SERVICE_CALLER_PAYLOAD_FLOOR = SERVICE_AUTHORITY_MAX_BYTES + SERVICE_CALLER_PAYLOAD_OVERHEAD;
export const SERVICE_DESCRIBE_QUERY_BUDGET_MS = 2_000;
