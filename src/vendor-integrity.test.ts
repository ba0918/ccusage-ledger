import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHART_SHA256 = "473ee39a9f53b54448837634192b17bce499078fe13229b458e8d4461ea1c003";

describe("vendored assets integrity", () => {
  test("Chart.js の sha256 が固定値と一致する（更新時は明示的にハッシュを更新する）", () => {
    const buffer = readFileSync(join(import.meta.dir, "..", "public", "vendor", "chart.umd.min.js"));
    const hash = createHash("sha256").update(buffer).digest("hex");
    expect(hash).toBe(CHART_SHA256);
  });
});
