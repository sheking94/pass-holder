import { describe, expect, it } from "vitest";
import { formatSize } from "../src/files/format-size.ts";

describe("formatSize", () => {
  it("shows KB below 1 MiB, at least 1 KB", () => {
    expect(formatSize(483211)).toBe("472 KB");
    expect(formatSize(500)).toBe("1 KB");
    expect(formatSize(1)).toBe("1 KB");
    expect(formatSize(1024)).toBe("1 KB");
  });

  it("shows MB with one decimal and a decimal comma from 1 MiB", () => {
    expect(formatSize(4823449)).toBe("4,6 MB");
    expect(formatSize(1048576)).toBe("1,0 MB");
    expect(formatSize(10485760)).toBe("10,0 MB");
  });
});
