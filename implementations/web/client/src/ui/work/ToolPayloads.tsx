import { payloadText } from "../../lib/toolPayload.js";
import type { ToolCall } from "../../lib/session.js";

/** Plain-text payload rails. Native details start closed and are keyboard accessible. */
export function ToolPayloads({ call }: { call: ToolCall }) {
  return <div className="ox-payloads">{([['Input', call.input], ['Result', call.result]] as const).map(([label, value]) =>
    <details key={label} className="ox-payload">
      <summary>{label}{value === undefined ? " · not received" : ""}</summary>
      <pre>{value === undefined ? "No payload received. It may be withheld or outside the retained window." : payloadText(value)}</pre>
    </details>
  )}</div>;
}
