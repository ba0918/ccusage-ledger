import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PeriodEntry } from "./types";
import {
  buildYearly,
  cacheHitRate,
  filterByAgent,
  filterByModel,
  getSection,
  allModels,
  allAgents,
  modelUnitPrice,
  buildModelCostSeries,
  buildModelMixSeries,
  buildUnitPriceSeries,
  buildCacheHitRateSeries,
} from "./aggregate";

const DATA = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "usage.json"), "utf-8"));

describe("buildYearly", () => {
  test("monthly を年でグループ化してコスト・トークンを集計する", () => {
    const monthly = getSection(DATA, "monthly");
    const yearly = buildYearly(monthly);

    expect(yearly.map((e) => e.period)).toEqual(["2025", "2026"]);
    const y2026 = yearly.find((e) => e.period === "2026")!;
    expect(y2026.totalCost).toBeCloseTo(2.1);
    expect(y2026.totalTokens).toBe(3500);
  });

  test("yearly の modelBreakdowns をモデルごとに合算する", () => {
    const yearly = buildYearly(getSection(DATA, "monthly"));
    const y2026 = yearly.find((e) => e.period === "2026")!;

    expect(y2026.modelsUsed.sort()).toEqual(["model-a", "model-b", "model-c"]);
    const costs: Record<string, number> = {};
    for (const b of y2026.modelBreakdowns) costs[b.modelName] = b.cost;
    expect(costs["model-a"]).toBeCloseTo(1.2);
    expect(costs["model-b"]).toBeCloseTo(0.6);
    expect(costs["model-c"]).toBeCloseTo(0.3);
  });

  test("yearly の metadata.agents を和集合でまとめる", () => {
    const yearly = buildYearly(getSection(DATA, "monthly"));
    const y2026 = yearly.find((e) => e.period === "2026")!;

    expect(y2026.metadata?.agents?.sort()).toEqual(["claude", "codex"]);
  });

  test("年順にソートして返す", () => {
    const yearly = buildYearly(getSection(DATA, "monthly"));
    expect(yearly[0]!.period).toBe("2025");
  });
});

describe("filterByModel", () => {
  test("対象モデルのみの breakdowns でコスト・トークンを再集計する", () => {
    const daily = getSection(DATA, "daily");
    const filtered = filterByModel(daily, "model-a");

    expect(filtered).toHaveLength(3);
    expect(filtered[0]!.totalCost).toBeCloseTo(0.3);
    expect(filtered[0]!.totalTokens).toBe(600);
    expect(filtered[0]!.modelBreakdowns.map((b) => b.modelName)).toEqual(["model-a"]);
    expect(filtered[0]!.modelsUsed).toEqual(["model-a"]);
  });

  test("対象モデルを含まない期間はコスト 0 になる", () => {
    const daily = getSection(DATA, "daily");
    const filtered = filterByModel(daily, "model-a");

    expect(filtered[2]!.totalCost).toBe(0);
    expect(filtered[2]!.totalTokens).toBe(0);
  });

  test("model 指定なしは元の配列を返す", () => {
    const daily = getSection(DATA, "daily");
    expect(filterByModel(daily, null)).toEqual(daily);
  });
});

describe("filterByAgent", () => {
  test("metadata.agents を含む期間だけに絞り込む", () => {
    const daily = getSection(DATA, "daily");
    const filtered = filterByAgent(daily, "claude");

    expect(filtered.map((e) => e.period)).toEqual(["2026-01-10", "2026-02-03"]);
  });

  test("agent 指定なしは元の配列を返す", () => {
    const daily = getSection(DATA, "daily");
    expect(filterByAgent(daily, null)).toEqual(daily);
  });
});

describe("allModels / allAgents", () => {
  test("全モデルの和集合を返す", () => {
    const daily = getSection(DATA, "daily");
    expect(allModels(daily)).toEqual(["model-a", "model-b", "model-c"]);
  });

  test("全エージェントの和集合を返す", () => {
    const daily = getSection(DATA, "daily");
    expect(allAgents(daily)).toEqual(["claude", "codex"]);
  });
});

describe("modelUnitPrice / cacheHitRate", () => {
  test("単価は cost / totalTokens * 1e6 で計算する", () => {
    const daily = getSection(DATA, "daily");
    const bd = daily[0]!.modelBreakdowns.find((b) => b.modelName === "model-a")!;
    expect(modelUnitPrice(bd)).toBeCloseTo(500);
  });

  test("トークン 0 の単価は 0 を返す", () => {
    const bd = {
      modelName: "model-x",
      cost: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(modelUnitPrice(bd)).toBe(0);
  });

  test("キャッシュヒット率は cacheRead / 全トークンで計算する", () => {
    const daily = getSection(DATA, "daily");
    expect(cacheHitRate(daily[0]!)).toBeCloseTo(0.4);
  });

  test("全トークン 0 のキャッシュヒット率は 0 を返す", () => {
    const entry: PeriodEntry = {
      period: "2026-01-01",
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelsUsed: [],
      modelBreakdowns: [],
    };
    expect(cacheHitRate(entry)).toBe(0);
  });
});

describe("buildModelCostSeries", () => {
  test("期間をラベルに、モデル別コストを dataset に持つ", () => {
    const daily = getSection(DATA, "daily");
    const series = buildModelCostSeries(daily);

    expect(series.labels).toEqual(["2026-01-10", "2026-02-03", "2026-03-15"]);
    const modelA = series.datasets.find((d) => d.label === "model-a")!;
    expect(modelA.data).toEqual([0.3, 0.9, 0]);
    const modelB = series.datasets.find((d) => d.label === "model-b")!;
    expect(modelB.data).toEqual([0.2, 0, 0.4]);
  });
});

describe("buildModelMixSeries", () => {
  test("期間ごとにモデル別コスト比率(0-100)を計算する", () => {
    const daily = getSection(DATA, "daily");
    const series = buildModelMixSeries(daily);

    const modelA = series.datasets.find((d) => d.label === "model-a")!;
    expect(modelA.data[0]).toBeCloseTo(60);
    expect(modelA.data[1]).toBeCloseTo(75);
    expect(modelA.data[2]).toBeCloseTo(0);
    const modelB = series.datasets.find((d) => d.label === "model-b")!;
    expect(modelB.data[2]).toBeCloseTo(100);
  });
});

describe("buildUnitPriceSeries", () => {
  test("モデル別の単価推移を返し、不在期間は null にする", () => {
    const daily = getSection(DATA, "daily");
    const series = buildUnitPriceSeries(daily);

    const modelA = series.datasets.find((d) => d.label === "model-a")!;
    expect(modelA.data[0]).toBeCloseTo(500);
    expect(modelA.data[1]).toBeCloseTo(600);
    expect(modelA.data[2]).toBeNull();
  });
});

describe("buildCacheHitRateSeries", () => {
  test("期間ごとのキャッシュヒット率を返す", () => {
    const daily = getSection(DATA, "daily");
    const series = buildCacheHitRateSeries(daily);

    expect(series.labels).toEqual(["2026-01-10", "2026-02-03", "2026-03-15"]);
    expect(series.datasets[0]!.data[0]).toBeCloseTo(0.4);
    expect(series.datasets[0]!.data[2]).toBeCloseTo(0);
  });
});
