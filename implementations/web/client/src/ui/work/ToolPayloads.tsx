import type { PayloadReadFailure } from "../../api/types.js";
import { payloadText } from "../../lib/toolPayload.js";
import type { ToolCall } from "../../lib/session.js";

/** Plain-text payload rails. Native details start closed and are keyboard accessible. */
export function ToolPayloads({ call, payloadRead }: { call: ToolCall; payloadRead?: PayloadReadFailure }) {
  const missing = payloadRead ? (payloadRead.status === "refused" ? "read refused" : "read failed") : "not received";
  return <div className="ox-payloads">{([['Input', call.input], ['Result', call.result]] as const).map(([label, value]) =>
    <details key={label} className="ox-payload">
      <summary>{label}{value === undefined ? ` · ${missing}` : ""}</summary>
      <pre>{value === undefined ? (payloadRead?.reason ?? "No payload received. It may be withheld or outside the retained window.") : payloadText(value)}</pre>
    </details>
  )}</div>;
}
