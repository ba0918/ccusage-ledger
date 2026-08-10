import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PeriodEntry } from "./types";
import {
  buildYearly,
  cacheHitRate,
  filterByAgent,
  filterByModel,
  filterByRange,
  getSection,
  allModels,
  allAgents,
  modelUnitPrice,
  buildModelCostSeries,
  buildCostBarSeries,
  buildModelMixSeries,
  buildUnitPriceSeries,
  buildCacheHitRateSeries,
  selectSectionEntries,
  buildDashboardSeries,
  buildKpiSummary,
  buildAgentShare,
  modelColor,
} from "./aggregate";

const DATA = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "usage.json"), "utf-8"));

function entryWithModels(period: string, costs: [string, number][]): PeriodEntry {
  return {
    period,
    totalCost: costs.reduce((sum, [, cost]) => sum + cost, 0),
    totalTokens: costs.length * 1000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelsUsed: costs.map(([name]) => name),
    modelBreakdowns: costs.map(([name, cost]) => ({
      modelName: name,
      cost,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })),
  };
}

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

  test("yearly の agents をエージェント別に合算する", () => {
    const yearly = buildYearly(getSection(DATA, "monthly"));
    const y2026 = yearly.find((e) => e.period === "2026")!;

    const claude = y2026.agents?.find((a) => a.agent === "claude");
    expect(claude?.totalCost).toBeCloseTo(1.4);
    expect(claude?.totalTokens).toBe(2500);
    const codex = y2026.agents?.find((a) => a.agent === "codex");
    expect(codex?.totalCost).toBeCloseTo(0.7);
  });

  test("device フィールドを引き継いでマージする", () => {
    const monthly: PeriodEntry[] = [
      {
        period: "2026-01",
        totalCost: 1,
        totalTokens: 100,
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 40,
        cacheCreationTokens: 10,
        modelsUsed: ["model-a"],
        modelBreakdowns: [
          { modelName: "model-a", cost: 1, inputTokens: 40, outputTokens: 10, cacheReadTokens: 40, cacheCreationTokens: 10 },
        ],
        device: "desktop",
      },
      {
        period: "2026-02",
        totalCost: 2,
        totalTokens: 200,
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheCreationTokens: 20,
        modelsUsed: ["model-a"],
        modelBreakdowns: [
          { modelName: "model-a", cost: 2, inputTokens: 80, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 20 },
        ],
      },
    ];

    const yearly = buildYearly(monthly);
    expect(yearly).toHaveLength(1);
    expect(yearly[0]!.device).toBe("desktop");
    expect(yearly[0]!.totalCost).toBeCloseTo(3);
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

  test("各エージェントの breakdown もモデルで絞り込み、エージェント合計を再集計する", () => {
    const daily = getSection(DATA, "daily");
    const filtered = filterByModel(daily, "model-a");
    const feb = filtered[1]!;

    const claude = feb.agents?.find((a) => a.agent === "claude");
    expect(claude?.totalCost).toBeCloseTo(0.9);
    expect(claude?.totalTokens).toBe(1500);
    expect(claude?.modelBreakdowns.map((b) => b.modelName)).toEqual(["model-a"]);

    const codex = feb.agents?.find((a) => a.agent === "codex");
    expect(codex).toBeUndefined();
  });

  test("エージェントのトークン合計も breakdown から再計算する", () => {
    const daily = getSection(DATA, "daily");
    const filtered = filterByModel(daily, "model-b");

    const claude = filtered[0]!.agents?.[0]!;
    expect(claude.totalCost).toBeCloseTo(0.2);
    expect(claude.totalTokens).toBe(400);
  });

  test("対象モデルを使わないエージェントは agents から除外される", () => {
    const daily = getSection(DATA, "daily");
    const filtered = filterByModel(daily, "model-b");

    expect(filtered[0]!.agents?.map((a) => a.agent)).toEqual(["claude"]);
    expect(filtered[1]!.agents).toEqual([]);
    expect(filtered[2]!.agents?.map((a) => a.agent)).toEqual(["codex"]);
  });
});

describe("filterByAgent", () => {
  test("エージェントの breakdown から期間を再構築して絞り込む", () => {
    const daily = getSection(DATA, "daily");
    const filtered = filterByAgent(daily, "claude");

    expect(filtered.map((e) => e.period)).toEqual(["2026-01-10", "2026-02-03"]);
    expect(filtered[0]!.totalCost).toBeCloseTo(0.5);
    expect(filtered[0]!.totalTokens).toBe(1000);
    expect(filtered[0]!.modelBreakdowns.map((b) => b.modelName)).toEqual(["model-a", "model-b"]);
    expect(filtered[0]!.agents?.map((a) => a.agent)).toEqual(["claude"]);
    expect(filtered[1]!.totalCost).toBeCloseTo(0.9);
    expect(filtered[1]!.totalTokens).toBe(1500);
    expect(filtered[1]!.modelBreakdowns.map((b) => b.modelName)).toEqual(["model-a"]);
  });

  test("対象エージェントの期間合計がエージェント内訳の合計と一致する", () => {
    const monthly = getSection(DATA, "monthly");
    const filtered = filterByAgent(monthly, "codex");

    expect(filtered.map((e) => e.period)).toEqual(["2026-02", "2026-03"]);
    expect(filtered[0]!.totalCost).toBeCloseTo(0.3);
    expect(filtered[1]!.totalCost).toBeCloseTo(0.4);
  });

  test("エージェントが存在しない期間は除外する", () => {
    const daily = getSection(DATA, "daily");
    const filtered = filterByAgent(daily, "codex");

    expect(filtered.map((e) => e.period)).toEqual(["2026-02-03", "2026-03-15"]);
    expect(filtered[0]!.totalCost).toBeCloseTo(0.3);
    expect(filtered[1]!.totalCost).toBeCloseTo(0.4);
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

describe("modelColor", () => {
  test("モデル順にパレットの色を割り当てる", () => {
    const models = ["model-a", "model-b", "model-c"];
    expect(modelColor("model-a", models)).toBe("#4e79a7");
    expect(modelColor("model-b", models)).toBe("#f28e2b");
    expect(modelColor("model-c", models)).toBe("#e15759");
  });

  test("未知のモデルは先頭の色にフォールバックする", () => {
    expect(modelColor("unknown", ["model-a"])).toBe("#4e79a7");
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

describe("buildKpiSummary", () => {
  test("対象期間の合計コスト・総トークン・アクティブモデル数を返す", () => {
    const daily = getSection(DATA, "daily");
    const kpi = buildKpiSummary(daily);

    expect(kpi.totalCost).toBeCloseTo(2.1);
    expect(kpi.totalTokens).toBe(3500);
    expect(kpi.activeModelCount).toBe(3);
  });

  test("yearly 集計結果からも合計を返す", () => {
    const yearly = buildYearly(getSection(DATA, "monthly"));
    const kpi = buildKpiSummary(yearly);
    expect(kpi.totalCost).toBeCloseTo(4.1);
    expect(kpi.activeModelCount).toBe(3);
  });
});

describe("buildAgentShare", () => {
  test("entry.agents からエージェント別のコスト・トークンを集計する", () => {
    const daily = getSection(DATA, "daily");
    const share = buildAgentShare(daily);

    expect(share.agents).toEqual(["claude", "codex"]);
    expect(share.cost[0]).toBeCloseTo(1.4);
    expect(share.cost[1]).toBeCloseTo(0.7);
    expect(share.tokens[0]).toBe(2500);
    expect(share.tokens[1]).toBe(1000);
    expect(share.totalCost).toBeCloseTo(2.1);
    expect(share.totalTokens).toBe(3500);
    expect(share.hasDetail).toBe(true);
  });

  test("コスト配分とトークン配分の比率を返す", () => {
    const daily = getSection(DATA, "daily");
    const share = buildAgentShare(daily);

    expect(share.costShare[0]).toBeCloseTo(0.6667, 3);
    expect(share.costShare[1]).toBeCloseTo(0.3333, 3);
    expect(share.tokenShare[0]).toBeCloseTo(0.7143, 3);
    expect(share.tokenShare[1]).toBeCloseTo(0.2857, 3);
  });

  test("agents が無い場合は metadata.agents の名前だけを listing として返す", () => {
    const entries: PeriodEntry[] = [
      {
        period: "2026-01-10",
        totalCost: 1,
        totalTokens: 1000,
        inputTokens: 400,
        outputTokens: 100,
        cacheReadTokens: 400,
        cacheCreationTokens: 100,
        modelsUsed: ["model-a"],
        modelBreakdowns: [
          { modelName: "model-a", cost: 1, inputTokens: 400, outputTokens: 100, cacheReadTokens: 400, cacheCreationTokens: 100 },
        ],
        metadata: { agents: ["claude", "codex"] },
      },
    ];

    const share = buildAgentShare(entries);

    expect(share.hasDetail).toBe(false);
    expect(share.agents.sort()).toEqual(["claude", "codex"]);
    expect(share.cost).toEqual([0, 0]);
    expect(share.costShare).toEqual([0, 0]);
  });
});

describe("selectSectionEntries", () => {
  test("yearly を選ぶと monthly を年集計した結果を返す", () => {
    const entries = selectSectionEntries(DATA, "yearly", { model: null, agent: null });
    expect(entries.map((e) => e.period)).toEqual(["2025", "2026"]);
  });

  test("モデルフィルタとエージェントフィルタを同時に適用する", () => {
    const entries = selectSectionEntries(DATA, "daily", { model: "model-a", agent: "claude" });
    expect(entries.map((e) => e.period)).toEqual(["2026-01-10", "2026-02-03"]);
    expect(entries[0]!.modelBreakdowns.map((b) => b.modelName)).toEqual(["model-a"]);
    expect(entries[1]!.modelBreakdowns.map((b) => b.modelName)).toEqual(["model-a"]);
  });

  test("fixed の月指定は daily をその月の期間だけに絞る", () => {
    const daily = selectSectionEntries(DATA, "daily", { model: null, agent: null, range: { kind: "fixed", year: 2026, month: 2 } });
    expect(daily.map((e) => e.period)).toEqual(["2026-02-03"]);
  });

  test("fixed の年指定は yearly をその年の期間だけに絞る", () => {
    const yearly = selectSectionEntries(DATA, "yearly", { model: null, agent: null, range: { kind: "fixed", year: 2026 } });
    expect(yearly.map((e) => e.period)).toEqual(["2026"]);
  });

  test("range 未指定は全期間を返す", () => {
    const daily = selectSectionEntries(DATA, "daily", { model: null, agent: null });
    expect(daily.map((e) => e.period)).toEqual(["2026-01-10", "2026-02-03", "2026-03-15"]);
  });
});

describe("filterByRange", () => {
  test("all は元の配列をそのまま返す", () => {
    const daily = getSection(DATA, "daily");
    expect(filterByRange(daily, { kind: "all" })).toEqual(daily);

    const monthly = getSection(DATA, "monthly");
    expect(filterByRange(monthly, { kind: "all" })).toEqual(monthly);
  });

  test("range 未指定は all として元の配列をそのまま返す", () => {
    const daily = getSection(DATA, "daily");
    expect(filterByRange(daily, undefined)).toEqual(daily);
  });

  test("fixed の月指定は daily をその月の期間だけに絞る", () => {
    const daily = getSection(DATA, "daily");
    expect(filterByRange(daily, { kind: "fixed", year: 2026, month: 2 }).map((e) => e.period)).toEqual(["2026-02-03"]);
  });

  test("fixed の月指定は monthly をその月の期間だけに絞る", () => {
    const monthly = getSection(DATA, "monthly");
    expect(filterByRange(monthly, { kind: "fixed", year: 2026, month: 2 }).map((e) => e.period)).toEqual(["2026-02"]);
  });

  test("fixed の年指定は daily をその年の期間だけに絞る", () => {
    const daily = getSection(DATA, "daily");
    expect(filterByRange(daily, { kind: "fixed", year: 2026 }).map((e) => e.period)).toEqual(["2026-01-10", "2026-02-03", "2026-03-15"]);
  });

  test("fixed の年指定は monthly をその年の期間だけに絞る", () => {
    const monthly = getSection(DATA, "monthly");
    expect(filterByRange(monthly, { kind: "fixed", year: 2026 }).map((e) => e.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  test("fixed の年指定は yearly をその年の期間だけに絞る", () => {
    const monthly = getSection(DATA, "monthly");
    expect(filterByRange(buildYearly(monthly), { kind: "fixed", year: 2026 }).map((e) => e.period)).toEqual(["2026"]);
  });
});

describe("buildDashboardSeries", () => {
  test("期間切替で全系列がフィルタの期間粒度に連動する", () => {
    const daily = buildDashboardSeries(DATA, { section: "daily", model: null, agent: null, range: { kind: "all" } });
    expect(daily.costStacked.labels).toEqual(["2026-01-10", "2026-02-03", "2026-03-15"]);
    expect(daily.modelMix.labels).toEqual(["2026-01-10", "2026-02-03", "2026-03-15"]);
    expect(daily.cacheHitRate.labels).toEqual(["2026-01-10", "2026-02-03", "2026-03-15"]);
    expect(daily.unitPrice.labels).toEqual(["model-b", "model-c", "model-a"]);

    const yearly = buildDashboardSeries(DATA, { section: "yearly", model: null, agent: null, range: { kind: "all" } });
    expect(yearly.costStacked.labels).toEqual(["2025", "2026"]);
    expect(yearly.modelMix.labels).toEqual(["2025", "2026"]);
    expect(yearly.cacheHitRate.labels).toEqual(["2025", "2026"]);
  });

  test("fixed 期間を指定すると全系列がその期間に絞られる", () => {
    const series = buildDashboardSeries(DATA, { section: "daily", model: null, agent: null, range: { kind: "fixed", year: 2026, month: 3 } });
    expect(series.costStacked.labels).toEqual(["2026-03-15"]);
    expect(series.modelMix.labels).toEqual(["2026-03-15"]);
    expect(series.cacheHitRate.labels).toEqual(["2026-03-15"]);
    expect(series.unitPrice.labels).toEqual(["model-b"]);
  });

  test("エージェント配分と KPI を系列とあわせて返す", () => {
    const series = buildDashboardSeries(DATA, { section: "daily", model: null, agent: null, range: { kind: "all" } });

    expect(series.agentShare.hasDetail).toBe(true);
    expect(series.agentShare.agents).toEqual(["claude", "codex"]);
    expect(series.kpi.totalCost).toBeCloseTo(2.1);
    expect(series.kpi.totalTokens).toBe(3500);
    expect(series.kpi.activeModelCount).toBe(3);
  });

  test("モデルフィルタで全系列がそのモデルのデータだけになる", () => {
    const series = buildDashboardSeries(DATA, { section: "daily", model: "model-a", agent: null, range: { kind: "all" } });

    expect(series.costStacked.datasets.map((d) => d.label)).toEqual(["model-a"]);
    expect(series.modelMix.datasets.map((d) => d.label)).toEqual(["model-a"]);
    expect(series.unitPrice.labels).toEqual(["model-a"]);
    expect(series.kpi.totalCost).toBeCloseTo(1.2);
  });

  test("yearly 表示でも選択期間の合計を返す", () => {
    const yearly = buildDashboardSeries(DATA, { section: "yearly", model: null, agent: null, range: { kind: "all" } });

    expect(yearly.kpi.totalCost).toBeCloseTo(4.1);
  });

  test("エージェント・範囲フィルタで KPI が連動する", () => {
    const codex = buildDashboardSeries(DATA, { section: "yearly", model: null, agent: "codex", range: { kind: "all" } });
    expect(codex.kpi.totalCost).toBeCloseTo(0.7);

    const ranged = buildDashboardSeries(DATA, { section: "yearly", model: null, agent: null, range: { kind: "fixed", year: 2026, month: 1 } });
    expect(ranged.kpi.totalCost).toBeCloseTo(0.5);
  });

  test("モデル＋エージェントの複合フィルタで KPI・ドーナツ・テーブル集計が一致する", () => {
    const filters = { section: "daily" as const, model: "model-a", agent: "claude", range: { kind: "all" } as const };
    const series = buildDashboardSeries(DATA, filters);
    const entries = selectSectionEntries(DATA, "daily", filters);

    const tableTotalCost = entries.reduce((sum, e) => sum + e.totalCost, 0);
    const tableTotalTokens = entries.reduce((sum, e) => sum + e.totalTokens, 0);

    expect(series.kpi.totalCost).toBeCloseTo(tableTotalCost);
    expect(series.kpi.totalCost).toBeCloseTo(1.2);
    expect(series.kpi.totalTokens).toBe(tableTotalTokens);
    expect(series.kpi.totalTokens).toBe(2100);

    expect(series.agentShare.totalCost).toBeCloseTo(series.kpi.totalCost);
    expect(series.agentShare.totalTokens).toBe(series.kpi.totalTokens);
    expect(series.agentShare.agents).toEqual(["claude"]);
    expect(series.agentShare.cost[0]).toBeCloseTo(1.2);
    expect(series.agentShare.costShare[0]).toBeCloseTo(1.0);

    for (const entry of entries) {
      const agentTotal = (entry.agents ?? []).reduce((sum, a) => sum + a.totalCost, 0);
      expect(entry.totalCost).toBeCloseTo(agentTotal);
      for (const agent of entry.agents ?? []) {
        const modelTotal = agent.modelBreakdowns.reduce((sum, b) => sum + b.cost, 0);
        expect(agent.totalCost).toBeCloseTo(modelTotal);
      }
    }
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

  test("上位5モデルを残し、残りのモデルを「その他」に集約する", () => {
    const entries = [
      entryWithModels("2026-01", [["m1", 5], ["m2", 4], ["m3", 3], ["m4", 2], ["m5", 1], ["m6", 0.1]]),
      entryWithModels("2026-02", [["m1", 5], ["m6", 0.5]]),
    ];
    const series = buildModelCostSeries(entries, 5);

    expect(series.datasets.map((d) => d.label)).toEqual(["m1", "m2", "m3", "m4", "m5", "その他"]);
    const other = series.datasets.find((d) => d.label === "その他")!;
    expect(other.data[0]).toBeCloseTo(0.1);
    expect(other.data[1]).toBeCloseTo(0.5);
  });

  test("モデルが5件以下なら「その他」を作らない", () => {
    const entries = [entryWithModels("2026-01", [["m3", 3], ["m1", 1], ["m2", 2]])];
    const series = buildModelCostSeries(entries);

    expect(series.datasets.map((d) => d.label)).toEqual(["m3", "m2", "m1"]);
  });
});

describe("buildCostBarSeries", () => {
  test("期間と合計コストを dataset に持つ", () => {
    const monthly = getSection(DATA, "monthly");
    const series = buildCostBarSeries(monthly);

    expect(series.labels).toEqual(["2025-12", "2026-01", "2026-02", "2026-03"]);
    expect(series.datasets[0]!.data).toEqual([2.0, 0.5, 1.2, 0.4]);
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

  test("比率トレンドでも上位5モデルと「その他」に集約する", () => {
    const entries = [
      entryWithModels("2026-01", [["m1", 50], ["m2", 30], ["m3", 10], ["m4", 5], ["m5", 3], ["m6", 2]]),
    ];
    const series = buildModelMixSeries(entries, 5);

    expect(series.datasets.map((d) => d.label)).toEqual(["m1", "m2", "m3", "m4", "m5", "その他"]);
    const m1 = series.datasets.find((d) => d.label === "m1")!;
    expect(m1.data[0]).toBeCloseTo(50);
    const other = series.datasets.find((d) => d.label === "その他")!;
    expect(other.data[0]).toBeCloseTo(2);
  });

  test("比率トレンドの「その他」は期間ごとに計算する", () => {
    const entries = [
      entryWithModels("2026-01", [["m1", 50], ["m6", 50]]),
      entryWithModels("2026-02", [["m1", 90], ["m6", 10]]),
    ];
    const series = buildModelMixSeries(entries, 1);

    expect(series.datasets.map((d) => d.label)).toEqual(["m1", "その他"]);
    const other = series.datasets.find((d) => d.label === "その他")!;
    expect(other.data[0]).toBeCloseTo(50);
    expect(other.data[1]).toBeCloseTo(10);
  });
});

describe("buildUnitPriceSeries", () => {
  test("期間全体を集計したモデル別実効単価($/MTok)を価格降順で返す", () => {
    const entries: PeriodEntry[] = [
      {
        period: "2026-01-10",
        totalCost: 3.5,
        totalTokens: 3_000_000,
        inputTokens: 3_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelsUsed: ["model-a", "model-b", "model-c"],
        modelBreakdowns: [
          { modelName: "model-a", cost: 2.0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "model-b", cost: 1.0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "model-c", cost: 0.5, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ],
      },
    ];

    const series = buildUnitPriceSeries(entries);

    expect(series.labels).toEqual(["model-a", "model-b", "model-c"]);
    expect(series.datasets[0]!.label).toBe("実効単価 ($/MTok)");
    expect(series.datasets[0]!.data).toEqual([2.0, 1.0, 0.5]);
  });

  test("複数期間にまたがってモデルごとにコスト・トークンを合算する", () => {
    const entries: PeriodEntry[] = [
      {
        period: "2026-01-10",
        totalCost: 1.0,
        totalTokens: 1_000_000,
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelsUsed: ["model-a"],
        modelBreakdowns: [
          { modelName: "model-a", cost: 1.0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ],
      },
      {
        period: "2026-01-11",
        totalCost: 2.5,
        totalTokens: 1_500_000,
        inputTokens: 1_500_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelsUsed: ["model-a", "model-b"],
        modelBreakdowns: [
          { modelName: "model-a", cost: 0.5, inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "model-b", cost: 2.0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ],
      },
    ];

    const series = buildUnitPriceSeries(entries);

    expect(series.labels).toEqual(["model-b", "model-a"]);
    expect(series.datasets[0]!.data).toEqual([2.0, 1.0]);
  });

  test("トークン 0 のモデルは単価 0 として返す", () => {
    const entries: PeriodEntry[] = [
      {
        period: "2026-01-10",
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelsUsed: ["model-x"],
        modelBreakdowns: [
          { modelName: "model-x", cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ],
      },
    ];

    const series = buildUnitPriceSeries(entries);

    expect(series.labels).toEqual(["model-x"]);
    expect(series.datasets[0]!.data).toEqual([0]);
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
