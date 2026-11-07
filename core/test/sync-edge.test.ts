import { describe, expect, it } from "vitest";
import { MemorySyncStore, processSync } from "../src/protocol.ts";

describe("processSync (host side)", () => {
  it("rejects two changes for the same entry in one request", () => {
    const store = new MemorySyncStore();
    const change = { id: "1", baseRevision: 0, deleted: false, blob: "AQ==" };
    expect(() => processSync(store, { sinceRevision: 0, changes: [change, change] })).toThrow("Duplicate");
  });

  it("rejects a base revision for an entry it never had", () => {
    expect(() =>
      processSync(new MemorySyncStore(), { sinceRevision: 0, changes: [{ id: "1", baseRevision: 3, deleted: false, blob: "AQ==" }] }),
    ).toThrow("Unknown base revision");
  });

  it("gives revisions that strictly increase and never reuses one", () => {
    const store = new MemorySyncStore();
    const r1 = processSync(store, { sinceRevision: 0, changes: [{ id: "a", baseRevision: 0, deleted: false, blob: "AQ==" }] });
    const r2 = processSync(store, {
      sinceRevision: 1,
      changes: [
        { id: "a", baseRevision: 1, deleted: true, blob: "AQ==" },
        { id: "b", baseRevision: 0, deleted: false, blob: "AQ==" },
      ],
    });
    expect(r1.accepted).toEqual([{ id: "a", revision: 1 }]);
    expect(r2.accepted).toEqual([
      { id: "a", revision: 2 },
      { id: "b", revision: 3 },
    ]);
    expect(r2.changes).toEqual([]); // own changes are not echoed back
  });

  it("returns only what changed after sinceRevision, oldest first", () => {
    const store = new MemorySyncStore();
    for (const id of ["a", "b", "c"]) processSync(store, { sinceRevision: 0, changes: [{ id, baseRevision: 0, deleted: false, blob: "AQ==" }] });
    expect(processSync(store, { sinceRevision: 1, changes: [] }).changes.map((r) => r.id)).toEqual(["b", "c"]);
    expect(processSync(store, { sinceRevision: 3, changes: [] }).changes).toEqual([]);
  });
});
