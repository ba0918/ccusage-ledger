import { describe, expect, test } from "bun:test";
import { isUsageData, projectUsageData, MAX_SECTION_ENTRIES, MAX_MODELS_USED, MAX_MODEL_BREAKDOWNS, MAX_AGENTS, MAX_STRING_LENGTH } from "./usage-data";

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

  test("period・model・agent の全 cost/token 数値フィールドで負値を拒否する", () => {
    const periodFields = ["totalCost", "totalTokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;
    for (const field of periodFields) {
      expect(isUsageData({ daily: [{ ...VALID_ENTRY, [field]: -1 }], monthly: [] })).toBe(false);
    }

    const model = { modelName: "m", cost: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 };
    const modelFields = ["cost", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;
    for (const field of modelFields) {
      expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelBreakdowns: [{ ...model, [field]: -1 }] }], monthly: [] })).toBe(false);
    }

    const agent = { agent: "codex", totalCost: 1, totalTokens: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1, modelsUsed: [], modelBreakdowns: [] };
    for (const field of periodFields) {
      expect(isUsageData({ daily: [{ ...VALID_ENTRY, agents: [{ ...agent, [field]: -1 }] }], monthly: [] })).toBe(false);
    }
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

  test("metadata.agents も agents と同じ上限で検証する（キャップ迂回の DoS を拒否）", () => {
    const many = Array.from({ length: MAX_AGENTS + 1 }, () => "agent");
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, metadata: { agents: many } }], monthly: [] })).toBe(false);
    const long = "x".repeat(MAX_STRING_LENGTH + 1);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, metadata: { agents: [long] } }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, metadata: { agents: ["ok"] } }], monthly: [] })).toBe(true);
  });

  test("metadata が存在する場合は非 null のオブジェクトだけを受理する", () => {
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, metadata: null }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, metadata: [] }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, metadata: "agents" }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, metadata: {} }], monthly: [] })).toBe(true);
  });

  test("NaN / Infinity の数値は false（集計が Infinity/NaN に化けて描画が壊れるのを防ぐ）", () => {
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, totalCost: Number.NaN }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, totalTokens: Number.POSITIVE_INFINITY }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelBreakdowns: [{ modelName: "m", cost: Number.NEGATIVE_INFINITY, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }] }], monthly: [] })).toBe(false);
  });

  test("絶対値が上限（1e12）を超える数値は false（加算で Infinity に溢れて全チャートが壊れるのを防ぐ）", () => {
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, totalCost: 1e308 }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, totalTokens: Number.MAX_VALUE }], monthly: [] })).toBe(false);
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, modelBreakdowns: [{ modelName: "m", cost: 1e308, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }] }], monthly: [] })).toBe(false);
    // 上限ちょうどは通す
    expect(isUsageData({ daily: [{ ...VALID_ENTRY, totalCost: 1e12 }], monthly: [] })).toBe(true);
  });

  test("全期間を通した distinct モデル名が上限を超えるデータは false（クライアントの選択肢生成 OOM を防ぐ）", () => {
    // 各エントリは個別上限内でも、エントリ横断で無数の distinct 名を作れる。allModels() が
    // 全名を Set 化して fillSelect が <option> を 1 名ずつ生やすため、横断 cap で守る
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ...VALID_ENTRY,
      period: `2026-08-${String(i + 1).padStart(2, "0")}`,
      modelBreakdowns: Array.from({ length: 50 }, (_, j) => ({
        modelName: `model-${i}-${j}`,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })),
    }));
    // 50 distinct は通す
    expect(isUsageData({ daily: entries, monthly: [] })).toBe(true);
    // 上限（MAX_DISTINCT_NAMES = 1000）を超える distinct 名は false
    const overflow = Array.from({ length: 21 }, (_, i) => ({
      ...VALID_ENTRY,
      period: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      modelBreakdowns: Array.from({ length: 50 }, (_, j) => ({
        modelName: `model-${i}-${j}`,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })),
    }));
    expect(isUsageData({ daily: overflow, monthly: [] })).toBe(false);
  });

  test("全期間を通した distinct エージェント名が上限を超えるデータは false", () => {
    const withAgents = (count: number) => ({
      daily: Array.from({ length: count }, (_, i) => ({
        ...VALID_ENTRY,
        period: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
        agents: [{
          agent: `agent-${i}`,
          totalCost: 1,
          totalTokens: 1,
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          modelsUsed: [],
          modelBreakdowns: [],
        }],
      })),
      monthly: [],
    });
    expect(isUsageData(withAgents(10))).toBe(true);
    // 上限を超える distinct エージェント名は false
    const overflow = withAgents(1001);
    expect(isUsageData(overflow)).toBe(false);
  });
});

describe("projectUsageData", () => {
  test("device はクライアントが未消費のため投影から落とす（totals と同様の白リスト原則）", () => {
    const entry = { ...VALID_ENTRY, device: "my-hostname", metadata: { agents: ["claude"] } };
    const projected = projectUsageData({ daily: [entry], monthly: [] });
    expect(projected.daily![0]!.device).toBeUndefined();
    // 検証は維持しつつ、投影で公開する既知フィールド（metadata.agents）は残す
    expect(projected.daily![0]!.metadata).toEqual({ agents: ["claude"] });
  });
});
