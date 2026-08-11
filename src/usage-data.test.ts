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

  test("modelsUsed / modelBreakdowns が欠落したエントリは false（必須フィールドの契約）", () => {
    const { modelsUsed, modelBreakdowns, ...missing } = VALID_ENTRY;
    expect(isUsageData({ daily: [{ ...missing, modelsUsed }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...missing, modelBreakdowns }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelsUsed: undefined }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelBreakdowns: undefined }], monthly: [] })).toBe(false);
  });

  test("文字列フィールドが文字列でないエントリは false（描画クラッシュ防止）", () => {
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, period: 20260811 }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelsUsed: [42] }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelBreakdowns: [{ modelName: "x", cost: "y" }] }], monthly: [] })).toBe(false);
  });

  test("エージェント別内訳の文字列・数値フィールドも検証する", () => {
    const withAgents = (agents: unknown) => ({ daily: [{ ...VALID_ENTRY, agents }], monthly: [] });
    expect(isUsageData(withAgents([{ agent: "claude-code", totalCost: 1, totalTokens: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelsUsed: [], modelBreakdowns: [] }]))).toBe(true);
    expect(isUsageData(withAgents([{ agent: 42, totalCost: 1, totalTokens: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelsUsed: [], modelBreakdowns: [] }]))).toBe(false);
    expect(isUsageData(withAgents([{ agent: "claude-code", totalCost: "1", totalTokens: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelsUsed: [], modelBreakdowns: [] }]))).toBe(false);
  });

  test("period の形式が daily は YYYY-MM-DD、monthly は YYYY-MM でないと false（集計前提の形式を検証）", () => {
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, period: "2026/01/10" }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, period: "2026-01" }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [], monthly: [{ ...VALID_ENTRY, period: "2026-01-10" }] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, period: "2026-01-10" }], monthly: [{ ...VALID_ENTRY, period: "2026-01" }] })).toBe(true);
  });
});
