import { describe, expect, test } from "bun:test";
import { isUsageData } from "./usage-data";

const VALID_ENTRY = {
  period: "2026-08-11",
  totalCost: 1.5,
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  modelsUsed: ["claude"],
  modelBreakdowns: [],
};

describe("isUsageData", () => {
  test("有効な UsageData は true", () => {
    expect(isUsageData({ daily: [VALID_ENTRY], monthly: [] })).toBe(true);
    expect(isUsageData({ daily: [], monthly: [] })).toBe(true);
  });

  test("daily / monthly が配列でない場合は false", () => {
    expect(isUsageData({ daily: "not-array", monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [], monthly: null })).toBe(false);
    expect(isUsageData(null)).toBe(false);
  });

  test("数値フィールドが型不一致のエントリは false", () => {
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, totalCost: "abc" }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, totalTokens: null }], monthly: [] })).toBe(false);
  });

  test("配列フィールドが配列でないエントリは false", () => {
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelsUsed: "claude" }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelBreakdowns: {} }], monthly: [] })).toBe(false);
  });
});
