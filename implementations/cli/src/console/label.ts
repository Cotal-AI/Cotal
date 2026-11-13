import { peerLabel } from "@cotal-ai/core";

/** A name the console prints. A blank name is not one, so the row uses the id when it has one. */
export function consoleLabel(card: { name: string; id?: string; role?: string }): string {
  const name = card.name.trim() ? card.name : card.id ?? card.name;
  return peerLabel({ name, ...(card.role ? { role: card.role } : {}) });
}
