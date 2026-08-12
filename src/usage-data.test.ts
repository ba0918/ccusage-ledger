import { describe, expect, test } from "bun:test";
import { isUsageData, MAX_SECTION_ENTRIES, MAX_MODELS_USED, MAX_MODEL_BREAKDOWNS, MAX_AGENTS, MAX_STRING_LENGTH } from "./usage-data";

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

  test("セクションのエントリ数が上限を超えるデータは false（巨大キャッシュによる DoS を拒否）", () => {
    const many = Array.from({ length: MAX_SECTION_ENTRIES + 1 }, (_, i) => ({
      ...VALID_ENTRY,
      period: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    expect(isUsageData({ daily: many, monthly: [] })).toBe(false);
    expect(isUsageData({ daily: many.slice(0, MAX_SECTION_ENTRIES), monthly: [] })).toBe(true);
  });

  test("modelName / agent / device の文字列長が上限を超えるデータは false", () => {
    const long = "x".repeat(MAX_STRING_LENGTH + 1);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelsUsed: [long] }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelBreakdowns: [{ modelName: long, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }] }], monthly: [] })).toBe(false);
    const withAgent = (agent: unknown) => ({ daily: [{ ...VALID_ENTRY, agents: [{ agent, totalCost: 1, totalTokens: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelsUsed: [], modelBreakdowns: [] }] }], monthly: [] });
    expect(isUsageData(withAgent(long))).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, device: long }], monthly: [] })).toBe(false);
  });

  test("modelBreakdowns / modelsUsed / agents の件数が上限を超えるデータは false", () => {
    const manyModels = Array.from({ length: MAX_MODELS_USED + 1 }, (_, i) => `model-${i}`);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelsUsed: manyModels }], monthly: [] })).toBe(false);

    const manyBreakdowns = Array.from({ length: MAX_MODEL_BREAKDOWNS + 1 }, (_, i) => ({
      modelName: `model-${i}`,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }));
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelBreakdowns: manyBreakdowns }], monthly: [] })).toBe(false);

    const manyAgents = Array.from({ length: MAX_AGENTS + 1 }, (_, i) => ({
      agent: `agent-${i}`,
      totalCost: 1,
      totalTokens: 1,
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelsUsed: [],
      modelBreakdowns: [],
    }));
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, agents: manyAgents }], monthly: [] })).toBe(false);
  });
});
