/**
 * The `<run-context>` render: what a workflow's notices look like in an agent's context.
 *
 * **Every notice is a fixed key→value table row, never a sentence.** The property this buys is the
 * whole reason `notify` exists in its bounded form: a notice reads as DATA in the receiving agent's
 * context and cannot be mistaken for an instruction from the workflow. Prose would be an
 * instruction whatever intended, because an agent reading prose in its prompt has no way to tell
 * who wrote it. The one sentence this file can emit is the empty-set constant below, which no
 * notice contributes to.
 *
 * Eight short scalars in a labelled table is not enough room to write an instruction. That is the
 * bound's purpose rather than a side effect of it, and it is enforced at the effect boundary
 * (L3043) before a notice is ever written — so this renderer never has to decide what to do with a
 * value it cannot render. It REFUSES one instead: a value that could end a line could forge a row
 * or a closing tag, and a renderer that quietly escaped it would be the one place where the bound
 * is a formatting convention rather than a rule.
 */
import type { RunNoticeRead } from "@cotal-ai/core";

/** A value that would break out of one table row — a control character, a line separator, or one
 *  of the characters the header line is built from. The effect boundary already excludes these from
 *  a notice; this is the second reader of the same rule, at the point where breaking out matters. */
const UNRENDERABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029"<>]/;

/** A notice this renderer cannot put in one row. Loud, because the alternative is a forged row. */
export class UnrenderableNotice extends Error {
  constructor(readonly noticeId: string, readonly field: string) {
    super(
      `notice ${noticeId} carries a line break, a control character or a delimiter in ${field}; ` +
        `a run-context row is one line, and a value that can end a line can forge a row or the closing tag`,
    );
    this.name = "UnrenderableNotice";
  }
}

export interface RunContextRender {
  /** The run whose notices these are. */
  readonly run: string;
  /** The step the addressee is about to take — the coordinates of the turn this precedes, not of
   *  the steps that decided the notices. Each notice's own step is a fact about the program's
   *  history and belongs to the run, not to this header. */
  readonly step: string;
  readonly notices: readonly RunNoticeRead[];
}

interface Row {
  readonly decision: string;
  readonly outcome: string;
  readonly detail: string;
}

const HEADER: Row = { decision: "decision", outcome: "outcome", detail: "detail" };

/** What an empty notice set says. A constant: no notice contributes to it, so nothing an author
 *  writes can reach this line. */
const NO_NOTICES = "no decisions have been recorded for you in this run";

/**
 * Render the notices addressed to one agent, ahead of one turn.
 *
 * Columns are padded to a fixed layout so the table reads as a table; the detail column is
 * `key=value` pairs in the order the notice recorded them, which is the order the program wrote
 * them. An empty set still renders, because "no decisions were told to you" and "nobody rendered
 * your context" are different facts and only one of them is this renderer's to state. It renders
 * as one fixed sentence rather than as a bare header row: a header with nothing under it reads to
 * an agent as a payload that failed to arrive, and two live seats treated it as one. The sentence
 * is a constant with no notice data in it, so it carries nothing an author could forge.
 */
export function renderRunContext(req: RunContextRender): string {
  for (const [field, value] of [["run", req.run], ["step", req.step]] as const)
    if (UNRENDERABLE.test(value)) throw new UnrenderableNotice(`<${field}>`, field);

  const rows: Row[] = req.notices.map((n) => {
    const fact = n.spec.fact;
    for (const [field, value] of [["decision", fact.decision], ["outcome", fact.outcome]] as const)
      if (UNRENDERABLE.test(value)) throw new UnrenderableNotice(n.noticeId, field);
    const detail = Object.entries(fact.detail ?? {}).map(([k, v]) => {
      if (UNRENDERABLE.test(k)) throw new UnrenderableNotice(n.noticeId, `detail key ${k}`);
      if (typeof v === "string" && UNRENDERABLE.test(v)) throw new UnrenderableNotice(n.noticeId, `detail.${k}`);
      return `${k}=${String(v)}`;
    });
    return { decision: fact.decision, outcome: fact.outcome, detail: detail.join("  ") };
  });

  const body = rows.length === 0 ? [NO_NOTICES] : tableLines(rows);

  return [
    `<run-context run="${req.run}" step="${req.step}">`,
    ...body,
    "</run-context>",
  ].join("\n");
}

/** The padded table: the header plus one line per notice. */
function tableLines(rows: readonly Row[]): string[] {
  const all = [HEADER, ...rows];
  const dW = Math.max(...all.map((r) => r.decision.length));
  const oW = Math.max(...all.map((r) => r.outcome.length));
  const line = (r: Row): string => `${r.decision.padEnd(dW)}  ${r.outcome.padEnd(oW)}  ${r.detail}`.trimEnd();
  return all.map(line);
}
