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
  buildModelCostSeries,
  buildModelTokenSeries,
  buildModelMixSeries,
  buildUnitPriceSeries,
  buildCacheHitRateSeries,
  selectSectionEntries,
  buildDashboardSeries,
  buildDashboardSeriesFromEntries,
  buildKpiSummary,
  buildAgentShare,
  buildAgentEfficiency,
  buildModelCostRanking,
  modelColor,
  otherBreakdown,
  modelTokenBreakdown,
  buildModelUnitPrices,
  agentDonutData,
  maxFinite,
  sliceLatest,
  REF_TOKEN_THRESHOLD,
  buildModelPeriodDetails,
  compareModelDetails,
  effectiveUnitPrice,
  type ModelPeriodDetail,
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
    for (const b of y2026.modelBreakdowns) {
      costs[b.modelName] = b.cost;
    }
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

    const claude = filtered[0]!.agents![0]!;
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

  test("agents[] があるエントリは agents[] を優先し、metadata.agents はフォールバックとして使う", () => {
    const onlyMetadata: PeriodEntry = {
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
    };
    expect(allAgents([onlyMetadata])).toEqual(["claude", "codex"]);

    const withDetail: PeriodEntry = {
      ...onlyMetadata,
      metadata: { agents: ["stale-agent"] },
      agents: [
        {
          agent: "claude",
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
        },
      ],
    };
    // metadata.agents が古くても agents[] の内容を選択肢にする（ドーナツ・テーブルと一致させる）
    expect(allAgents([withDetail])).toEqual(["claude"]);
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

describe("otherBreakdown", () => {
  test("上位モデル以外の内訳とコスト・構成比を返す", () => {
    const entry = getSection(DATA, "daily")[0]!;
    const breakdown = otherBreakdown(entry, new Set(["model-a"]));
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]!.modelName).toBe("model-b");
    expect(breakdown[0]!.cost).toBeCloseTo(0.2);
    expect(breakdown[0]!.ratio).toBeCloseTo(40);
  });

  test("top に含まれるモデルは除外される", () => {
    const entry = getSection(DATA, "daily")[0]!;
    expect(otherBreakdown(entry, new Set(["model-a", "model-b"]))).toHaveLength(0);
  });

  test("コスト 0 のモデルは除外される", () => {
    const daily = getSection(DATA, "daily");
    for (const entry of daily) {
      for (const item of otherBreakdown(entry, new Set(["model-a", "model-b"]))) {
        expect(item.cost).toBeGreaterThan(0);
      }
    }
  });
});

describe("cacheHitRate", () => {
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

describe("buildAgentEfficiency", () => {
  test("エージェント別のコスト・トークン・実効単価・ヒット率を返す", () => {
    const daily = getSection(DATA, "daily");
    const eff = buildAgentEfficiency(daily);

    const claude = eff.find((e) => e.agent === "claude")!;
    expect(claude.cost).toBeCloseTo(1.4);
    expect(claude.tokens).toBe(2500);
    expect(claude.unitPrice).toBeCloseTo(560);
    expect(claude.hitRate).toBeCloseTo(0.4);

    const codex = eff.find((e) => e.agent === "codex")!;
    expect(codex.cost).toBeCloseTo(0.7);
    expect(codex.tokens).toBe(1000);
    expect(codex.unitPrice).toBeCloseTo(700);
    expect(codex.hitRate).toBeCloseTo(0.2);
  });
});

describe("agentDonutData", () => {
  test("cost 指定はコスト配列、token 指定はトークン配列を返す（図と表の値が一致する）", () => {
    const eff = [
      { agent: "claude", cost: 1.4, tokens: 2500, unitPrice: 560, hitRate: 0.4 },
      { agent: "codex", cost: 0.7, tokens: 1000, unitPrice: 700, hitRate: 0.2 },
    ];
    expect(agentDonutData(eff, "cost")).toEqual([1.4, 0.7]);
    expect(agentDonutData(eff, "token")).toEqual([2500, 1000]);
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

  test("buildDashboardSeriesFromEntries に渡したラベルを全系列のデータセットラベルに使う", () => {
    const daily = getSection(DATA, "daily");
    const labels = { other: "Others", unitPrice: "Price", cacheHit: "Hit" };
    const series = buildDashboardSeriesFromEntries(daily, labels);

    expect(series.costStacked.datasets[0]!.label).toBe("model-a");
    expect(series.unitPrice.datasets[0]!.label).toBe("Price");
    expect(series.cacheHitRate.datasets[0]!.label).toBe("Hit");
  });

  test("Cost と Tokens の積み上げ系列で同じコスト上位モデルと「その他」の区分を使う", () => {
    const entries: PeriodEntry[] = [
      {
        ...entryWithModels("2026-01", [["m1", 6], ["m2", 5], ["m3", 4], ["m4", 3], ["m5", 2], ["m6", 1]]),
        modelBreakdowns: [
          { modelName: "m1", cost: 6, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "m2", cost: 5, inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "m3", cost: 4, inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "m4", cost: 3, inputTokens: 4, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "m5", cost: 2, inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "m6", cost: 1, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ],
      },
    ];

    const series = buildDashboardSeriesFromEntries(entries);

    expect(series.costStacked.datasets.map((dataset) => dataset.label)).toEqual(["m1", "m2", "m3", "m4", "m5", "Others"]);
    expect(series.tokensStacked.datasets.map((dataset) => dataset.label)).toEqual(
      series.costStacked.datasets.map((dataset) => dataset.label),
    );
    expect(series.tokensStacked.datasets.at(-1)?.data).toEqual([1000]);
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

  test("上位5モデルを残し、残りのモデルを渡した otherLabel に集約する", () => {
    const entries = [
      entryWithModels("2026-01", [["m1", 5], ["m2", 4], ["m3", 3], ["m4", 2], ["m5", 1], ["m6", 0.1]]),
      entryWithModels("2026-02", [["m1", 5], ["m6", 0.5]]),
    ];
    const series = buildModelCostSeries(entries, 5, "Others");

    expect(series.datasets.map((d) => d.label)).toEqual(["m1", "m2", "m3", "m4", "m5", "Others"]);
    const other = series.datasets.find((d) => d.label === "Others")!;
    expect(other.data[0]).toBeCloseTo(0.1);
    expect(other.data[1]).toBeCloseTo(0.5);
  });

  test("実モデル名が otherLabel と同じでも集約バケットだけを意味情報で識別できる", () => {
    const entries = [
      entryWithModels("2026-01", [["Others", 10], ["m2", 5], ["m3", 1]]),
    ];

    const series = buildModelCostSeries(entries, 1, "Others");

    expect(series.datasets).toEqual([
      { label: "Others", data: [10] },
      { label: "Others", data: [6], isOther: true },
    ]);
  });

  test("モデルが5件以下なら「その他」を作らない", () => {
    const entries = [entryWithModels("2026-01", [["m3", 3], ["m1", 1], ["m2", 2]])];
    const series = buildModelCostSeries(entries);

    expect(series.datasets.map((d) => d.label)).toEqual(["m3", "m2", "m1"]);
  });
});

describe("buildModelTokenSeries", () => {
  test("モデル別に Input・Output・Cache Read・Cache Creation の合計を期間系列として返す", () => {
    const entries: PeriodEntry[] = [
      {
        period: "2026-01",
        totalCost: 1,
        totalTokens: 999,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        modelsUsed: ["model-a"],
        modelBreakdowns: [
          { modelName: "model-a", cost: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 },
        ],
      },
    ];

    const series = buildModelTokenSeries(entries);

    expect(series.labels).toEqual(["2026-01"]);
    expect(series.datasets).toEqual([{ label: "model-a", data: [100] }]);
  });

  test("コスト上位モデルの指定を共有し、残りを同じ「その他」区分へ集約する", () => {
    const entries: PeriodEntry[] = [
      {
        ...entryWithModels("2026-01", [["expensive", 10], ["token-heavy", 1]]),
        inputTokens: 1001,
        modelBreakdowns: [
          { modelName: "expensive", cost: 10, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          { modelName: "token-heavy", cost: 1, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        ],
      },
    ];

    const series = buildModelTokenSeries(entries, 1, "Others", ["expensive"], 2);

    expect(series.datasets).toEqual([
      { label: "expensive", data: [1] },
      { label: "Others", data: [1000], isOther: true },
    ]);
  });
});

describe("modelTokenBreakdown", () => {
  test("「その他」に含まれる各モデルの Total と4種類の内訳を返す", () => {
    const entry: PeriodEntry = {
      ...entryWithModels("2026-01", [["top", 10], ["other-a", 2], ["other-b", 1]]),
      modelBreakdowns: [
        { modelName: "top", cost: 10, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
        { modelName: "other-a", cost: 2, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 },
        { modelName: "other-b", cost: 1, inputTokens: 5, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 2 },
      ],
    };

    expect(modelTokenBreakdown(entry, null, new Set(["top"]))).toEqual([
      {
        modelName: "other-a",
        totalTokens: 100,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
      },
      {
        modelName: "other-b",
        totalTokens: 14,
        inputTokens: 5,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
      },
    ]);
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

  test("比率トレンドでも上位5モデルと渡した otherLabel に集約する", () => {
    const entries = [
      entryWithModels("2026-01", [["m1", 50], ["m2", 30], ["m3", 10], ["m4", 5], ["m5", 3], ["m6", 2]]),
    ];
    const series = buildModelMixSeries(entries, 5, "Others");

    expect(series.datasets.map((d) => d.label)).toEqual(["m1", "m2", "m3", "m4", "m5", "Others"]);
    const m1 = series.datasets.find((d) => d.label === "m1")!;
    expect(m1.data[0]).toBeCloseTo(50);
    const other = series.datasets.find((d) => d.label === "Others")!;
    expect(other.data[0]).toBeCloseTo(2);
  });

  test("比率トレンドの otherLabel は期間ごとに計算する", () => {
    const entries = [
      entryWithModels("2026-01", [["m1", 50], ["m6", 50]]),
      entryWithModels("2026-02", [["m1", 90], ["m6", 10]]),
    ];
    const series = buildModelMixSeries(entries, 1, "Others");

    expect(series.datasets.map((d) => d.label)).toEqual(["m1", "Others"]);
    const other = series.datasets.find((d) => d.label === "Others")!;
    expect(other.data[0]).toBeCloseTo(50);
    expect(other.data[1]).toBeCloseTo(10);
  });
});

describe("buildModelCostRanking", () => {
  test("モデル別の累積コストを降順で返す", () => {
    const daily = getSection(DATA, "daily");
    const ranking = buildModelCostRanking(daily);

    expect(ranking.map((r) => r.modelName)).toEqual(["model-a", "model-b", "model-c"]);
    expect(ranking[0]!.cost).toBeCloseTo(1.2);
    expect(ranking[0]!.ratio).toBeCloseTo(57.14);
    expect(ranking[2]!.cost).toBeCloseTo(0.3);
  });
});

describe("buildModelUnitPrices", () => {
  test("モデル別の実効単価とキャッシュヒット率を価格降順で返す", () => {
    const daily = getSection(DATA, "daily");
    const prices = buildModelUnitPrices(daily);

    const modelA = prices.find((p) => p.modelName === "model-a")!;
    expect(modelA.unitPrice).toBeCloseTo(571.43);
    expect(modelA.hitRate).toBeCloseTo(0.4);

    const modelB = prices.find((p) => p.modelName === "model-b")!;
    expect(modelB.unitPrice).toBeCloseTo(666.67);
    expect(modelB.hitRate).toBeCloseTo(0.178);

    expect(prices.map((p) => p.modelName)).toEqual(["model-b", "model-c", "model-a"]);
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

    const series = buildUnitPriceSeries(entries, "Effective unit price ($/MTok)");

    expect(series.labels).toEqual(["model-a", "model-b", "model-c"]);
    expect(series.datasets[0]!.label).toBe("Effective unit price ($/MTok)");
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

    const series = buildUnitPriceSeries(entries, "Price ($/MTok)");

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

  test("渡した datasetLabel をデータセットラベルに使う", () => {
    const daily = getSection(DATA, "daily");
    const series = buildCacheHitRateSeries(daily, "Cache hit rate");

    expect(series.datasets[0]!.label).toBe("Cache hit rate");
  });
});

describe("maxFinite", () => {
  test("有限値の最大を返す", () => {
    expect(maxFinite([1, 3, 2], 0)).toBe(3);
  });

  test("NaN や無限大を無視し、すべて無効なら fallback を返す", () => {
    expect(maxFinite([NaN, Infinity, -Infinity], 1)).toBe(1);
    expect(maxFinite([NaN, 5], 1)).toBe(5);
  });
});

describe("sliceLatest", () => {
  test("max 件数以内ならそのまま返す", () => {
    expect(sliceLatest([1, 2], 3)).toEqual([1, 2]);
  });

  test("max を超える場合は末尾（最新）max 件を返す", () => {
    expect(sliceLatest([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
    expect(sliceLatest([], 3)).toEqual([]);
  });
});

// 単一期間のモデル詳細・比較のテスト用エントリ。tokens は inputTokens にまとめて総トークンを
// 決める（unitPrice = cost ÷ tokens × 1e6 の検証が読みやすい）
function makeDetailEntry(period: string, breakdowns: [modelName: string, cost: number, tokens: number][]): PeriodEntry {
  const modelBreakdowns = breakdowns.map(([modelName, cost, tokens]) => ({
    modelName,
    cost,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }));
  return {
    period,
    totalCost: breakdowns.reduce((sum, [, cost]) => sum + cost, 0),
    totalTokens: breakdowns.reduce((sum, [, , tokens]) => sum + tokens, 0),
    inputTokens: breakdowns.reduce((sum, [, , tokens]) => sum + tokens, 0),
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelsUsed: breakdowns.map(([modelName]) => modelName),
    modelBreakdowns,
  };
}

// breakdowns から buildModelPeriodDetails を経由して modelName → detail の Map を作る
// （compareModelDetails の入力は実装の出力と同じ型を使う）
function detailsOf(breakdowns: [modelName: string, cost: number, tokens: number][]): Map<string, ModelPeriodDetail> {
  return new Map(
    buildModelPeriodDetails(makeDetailEntry("2026-08-13", breakdowns)).map((d) => [d.modelName, d]),
  );
}

describe("buildModelPeriodDetails", () => {
  const ENTRY = makeDetailEntry("2026-08-13", [
    ["model-expensive", 9, 1_000_000],
    ["model-mid", 4, 1_000_000],
    ["model-small", 1, 500_000],
    ["model-cheap", 1, 2_000_000],
    ["model-free", 0, 5_000_000],
    ["model-tiny", 0.5, 0],
  ]);

  test("単一期間の全モデルが実効単価の降順で並ぶ（上位5を超えても全件含む）", () => {
    const details = buildModelPeriodDetails(ENTRY);

    expect(details.map((d) => d.modelName)).toEqual([
      "model-expensive",
      "model-mid",
      "model-small",
      "model-cheap",
      "model-free",
      "model-tiny",
    ]);
  });

  test("実効単価が cost ÷ totalTokens × 1e6 で計算される", () => {
    const details = buildModelPeriodDetails(ENTRY);
    const byName = new Map(details.map((d) => [d.modelName, d]));

    expect(byName.get("model-expensive")!.unitPrice).toBeCloseTo(9);
    expect(byName.get("model-cheap")!.unitPrice).toBeCloseTo(0.5);
  });

  test("トークン 0 のモデルの実効単価は 0 になる", () => {
    const details = buildModelPeriodDetails(ENTRY);
    expect(details.find((d) => d.modelName === "model-tiny")!.unitPrice).toBe(0);
  });

  test("総トークンが閾値未満のモデルに参考値フラグが付き、閾値ちょうどは付かない", () => {
    expect(REF_TOKEN_THRESHOLD).toBe(1_000_000);
    const byName = new Map(buildModelPeriodDetails(ENTRY).map((d) => [d.modelName, d]));

    expect(byName.get("model-small")!.isRef).toBe(true);
    expect(byName.get("model-tiny")!.isRef).toBe(true);
    expect(byName.get("model-expensive")!.isRef).toBe(false);
    expect(byName.get("model-free")!.isRef).toBe(false);
  });

  test("各モデルのトークン内訳と総トークンを breakdown から引き継ぐ", () => {
    const details = buildModelPeriodDetails(ENTRY);
    const expensive = details[0]!;

    expect(expensive.totalTokens).toBe(1_000_000);
    expect(expensive.inputTokens).toBe(1_000_000);
    expect(expensive.outputTokens).toBe(0);
    expect(expensive.cacheReadTokens).toBe(0);
    expect(expensive.cacheCreationTokens).toBe(0);
    expect(expensive.cost).toBe(9);
  });
});

describe("effectiveUnitPrice", () => {
  test("cost ÷ totalTokens × 1e6 を返し、トークン 0 は 0 を返す", () => {
    expect(effectiveUnitPrice(2, 1_000_000)).toBe(2);
    expect(effectiveUnitPrice(3, 0)).toBe(0);
  });
});

describe("compareModelDetails", () => {
  test("倍率（大きい側 ÷ 小さい側）と低減率（%）を指標ごとに計算する", () => {
    const details = detailsOf([
      ["expensive", 9, 1_000_000],
      ["small", 1, 500_000],
    ]);
    const cmp = compareModelDetails(details.get("expensive")!, details.get("small")!);

    expect(cmp.unitPriceRatio).toBeCloseTo(4.5);
    expect(cmp.unitPriceReduction).toBeCloseTo(77.78);
    expect(cmp.costRatio).toBeCloseTo(9);
    expect(cmp.costReduction).toBeCloseTo(88.89);
    expect(cmp.tokensRatio).toBeCloseTo(2);
    expect(cmp.tokensReduction).toBeCloseTo(50);
  });

  test("両方 0 の指標は倍率 1・低減率 0 になる（0 除算を回避）", () => {
    const details = detailsOf([
      ["zero-a", 0, 0],
      ["zero-b", 0, 0],
    ]);
    const cmp = compareModelDetails(details.get("zero-a")!, details.get("zero-b")!);

    expect(cmp.unitPriceRatio).toBe(1);
    expect(cmp.unitPriceReduction).toBe(0);
    expect(cmp.costRatio).toBe(1);
    expect(cmp.costReduction).toBe(0);
    expect(cmp.tokensRatio).toBe(1);
    expect(cmp.tokensReduction).toBe(0);
  });

  test("片側だけ 0 の指標は倍率 Infinity・低減率 100 になる（NaN にならない）", () => {
    const details = detailsOf([
      ["zero", 0, 0],
      ["real", 2, 1_000_000],
    ]);
    const cmp = compareModelDetails(details.get("zero")!, details.get("real")!);

    expect(cmp.unitPriceRatio).toBe(Infinity);
    expect(cmp.unitPriceReduction).toBe(100);
    expect(cmp.costRatio).toBe(Infinity);
    expect(cmp.costReduction).toBe(100);
    expect(cmp.tokensRatio).toBe(Infinity);
    expect(cmp.tokensReduction).toBe(100);
  });

  test("等しい指標は倍率 1・低減率 0 になる", () => {
    const details = detailsOf([
      ["same-a", 2, 1_000_000],
      ["same-b", 2, 1_000_000],
    ]);
    const cmp = compareModelDetails(details.get("same-a")!, details.get("same-b")!);

    expect(cmp.unitPriceRatio).toBe(1);
    expect(cmp.unitPriceReduction).toBe(0);
  });
});
