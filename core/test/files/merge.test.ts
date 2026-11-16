import { describe, expect, it } from "vitest";
import { toBase64 } from "../../src/encoding.ts";
import { mergeAttachments, type Attachment } from "../../src/files/index.ts";

const KEY = toBase64(new Uint8Array(32).fill(7));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const att = (n: number, name = `f${n}.txt`): Attachment => ({
  id: uuid(n),
  name,
  mime: "text/plain",
  size: 10,
  chunks: 1,
  sha256: "a".repeat(64),
  key: KEY,
});
const ids = (list: Attachment[]) => list.map((a) => a.id);

describe("mergeAttachments", () => {
  const [a, b, c] = [att(1), att(2), att(3)];

  it("keeps the winner's list, then the loser's missing ids in their order", () => {
    expect(ids(mergeAttachments([a, b], [b, c]))).toEqual(ids([a, b, c]));
    expect(ids(mergeAttachments([c], [b, a]))).toEqual(ids([c, b, a]));
  });

  it("treats a missing list as empty", () => {
    expect(mergeAttachments(undefined, [c])).toEqual([c]);
    expect(mergeAttachments([a], undefined)).toEqual([a]);
    expect(mergeAttachments(undefined, undefined)).toEqual([]);
  });

  it("takes the winner's descriptor when both have the same id", () => {
    const renamed = att(2, "renamed.txt");
    expect(mergeAttachments([renamed], [b, a])).toEqual([renamed, a]);
  });

  it("does not modify its inputs", () => {
    const winner = [a];
    const loser = [b];
    mergeAttachments(winner, loser);
    expect(winner).toEqual([a]);
    expect(loser).toEqual([b]);
  });
});
