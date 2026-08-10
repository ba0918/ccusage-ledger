import { describe, expect, test } from "bun:test";
import type { UsageData } from "../types";
import { isUsageData, loadUsageData } from "./load-data";

const VALID: UsageData = {
  daily: [
    {
      period: "2026-08-11",
      totalCost: 1,
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelsUsed: ["claude"],
      modelBreakdowns: [],
      agents: [],
    },
  ],
  monthly: [],
};

describe("loadUsageData", () => {
  test("埋め込みデータがあれば fetch せずにそれを使う", async () => {
    let fetched = false;
    const data = await loadUsageData(VALID, async () => {
      fetched = true;
      return { daily: [], monthly: [] };
    });
    expect(fetched).toBe(false);
    expect(data).toBe(VALID);
  });

  test("埋め込みデータが無ければ fetch で取得する", async () => {
    const data = await loadUsageData(undefined, async () => VALID);
    expect(data).toBe(VALID);
  });

  test("埋め込みデータがスキーマ不一致なら fetch にフォールバックする", async () => {
    const data = await loadUsageData({ daily: "not-an-array" }, async () => VALID);
    expect(data).toBe(VALID);
  });
});

describe("isUsageData", () => {
  test("daily / monthly の配列を持つオブジェクトを受理する", () => {
    expect(isUsageData(VALID)).toBe(true);
  });

  test("null / プリミティブ / daily が配列でない値を拒否する", () => {
    expect(isUsageData(null)).toBe(false);
    expect(isUsageData(42)).toBe(false);
    expect(isUsageData({ daily: 1, monthly: [] })).toBe(false);
  });
});
