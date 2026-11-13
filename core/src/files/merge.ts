import type { Attachment } from "./attachment.ts";

/**
 * Attachment lists of two conflicting versions of an entry: the winner's list, then the loser's descriptors
 * whose id the winner does not have, in the loser's order. A missing list counts as empty.
 */
export function mergeAttachments(
  winner: readonly Attachment[] | undefined,
  loser: readonly Attachment[] | undefined,
): Attachment[] {
  const merged = [...(winner ?? [])];
  const ids = new Set(merged.map((a) => a.id));
  for (const a of loser ?? []) if (!ids.has(a.id)) merged.push(a);
  return merged;
}
