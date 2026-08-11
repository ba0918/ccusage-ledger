import type { AgentBreakdown, ModelBreakdown, PeriodEntry, UsageData } from "./types";

export const TOP_N = 5;

// 上位 N モデル以外をまとめる「その他」バケットのラベル。client 側（datasetColor / tooltipLabel）と共有する
export const OTHER_LABEL = "その他";

// 末尾（最新）max 件を返す。描画行数のキャップに使う（Data 由来の巨大配列で DOM を固めない）
export function sliceLatest<T>(values: readonly T[], max: number): readonly T[] {
  if (values.length <= max) { return values; }
  return values.slice(values.length - max);
}

// Math.max(...arr) は要素数が多いとスタック超過、NaN が混ざると結果が NaN になる。
// データ由来の値で最大値を計算する場合はこちらを使う。
export function maxFinite(values: number[], fallback: number): number {
  let max = fallback;
  for (const value of values) {
    if (Number.isFinite(value) && value > max) { max = value; }
  }
  return max;
}

export type Section = "daily" | "monthly";

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;

export function totalTokensOf(entry: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number {
  return TOKEN_FIELDS.reduce((sum, field) => sum + entry[field], 0);
}

export function getSection(data: UsageData, section: Section): PeriodEntry[] {
  return data[section] ?? [];
}

export function selectSectionEntries(
  data: UsageData,
  section: "daily" | "monthly" | "yearly",
  filters: { model: string | null; agent: string | null; range?: PeriodRange },
): PeriodEntry[] {
  // range は集計前のソース（daily/monthly）に適用する。yearly は月次を年集計してから
  // モデル・エージェントで絞る（yearly 集計後に range を適用すると固定月が年と一致しない）。
  const source = section === "yearly" ? getSection(data, "monthly") : getSection(data, section);
  const ranged = filterByRange(source, filters.range);
  const entries = section === "yearly" ? buildYearly(ranged) : ranged;
  return filterByAgent(filterByModel(entries, filters.model), filters.agent);
}

export function buildYearly(monthly: PeriodEntry[]): PeriodEntry[] {
  const byYear = new Map<string, PeriodEntry[]>();
  for (const entry of monthly) {
    const year = entry.period.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push(entry);
    byYear.set(year, bucket);
  }

  return [...byYear.entries()]
    .map(([year, entries]) => mergeEntries(year, entries))
    .sort((a, b) => a.period.localeCompare(b.period));
}

// モデル別 breakdown を Map へ累積する（get-or-create して 6 フィールドを加算する）
function accumulateModelBreakdown(map: Map<string, ModelBreakdown>, breakdown: ModelBreakdown): void {
  const merged = map.get(breakdown.modelName) ?? {
    modelName: breakdown.modelName,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  merged.cost += breakdown.cost;
  merged.inputTokens += breakdown.inputTokens;
  merged.outputTokens += breakdown.outputTokens;
  merged.cacheReadTokens += breakdown.cacheReadTokens;
  merged.cacheCreationTokens += breakdown.cacheCreationTokens;
  map.set(breakdown.modelName, merged);
}

// 数値 Map への累積（get-or-create）を 1 行で表す。topModelsByCost / buildAgentShare / buildModelCostRanking で共通
function accumulateNumber(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

type AgentAccumulator = { merged: AgentBreakdown; modelsUsed: Set<string>; modelNames: Map<string, ModelBreakdown> };

// エージェント別 breakdown を Map へ累積する（accumulateModelBreakdown と対称。accumulated エージェント同士の合算に使う）
function accumulateAgentBreakdown(map: Map<string, AgentAccumulator>, agent: AgentBreakdown): void {
  const acc = map.get(agent.agent) ?? {
    merged: {
      agent: agent.agent,
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelsUsed: [],
      modelBreakdowns: [],
    },
    modelsUsed: new Set<string>(),
    modelNames: new Map<string, ModelBreakdown>(),
  };
  acc.merged.totalCost += agent.totalCost;
  acc.merged.totalTokens += agent.totalTokens;
  acc.merged.inputTokens += agent.inputTokens;
  acc.merged.outputTokens += agent.outputTokens;
  acc.merged.cacheReadTokens += agent.cacheReadTokens;
  acc.merged.cacheCreationTokens += agent.cacheCreationTokens;
  for (const model of agent.modelsUsed) { acc.modelsUsed.add(model); }
  for (const breakdown of agent.modelBreakdowns) {
    accumulateModelBreakdown(acc.modelNames, breakdown);
  }
  map.set(agent.agent, acc);
}

function mergeEntries(year: string, entries: PeriodEntry[]): PeriodEntry {
  const modelNames = new Map<string, ModelBreakdown>();
  const agents = new Set<string>();
  const modelsUsed = new Set<string>();
  // agent 別の合算は Map で持ち、最後に配列へ変換する（find()/includes() の O(n^2) を避ける）
  const agentBreakdowns = new Map<string, AgentAccumulator>();
  let totalCost = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (const entry of entries) {
    totalCost += entry.totalCost;
    totalTokens += entry.totalTokens;
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    cacheReadTokens += entry.cacheReadTokens;
    cacheCreationTokens += entry.cacheCreationTokens;
    for (const model of entry.modelsUsed) { modelsUsed.add(model); }
    for (const agent of entry.metadata?.agents ?? []) { agents.add(agent); }
    for (const breakdown of entry.modelBreakdowns) {
      accumulateModelBreakdown(modelNames, breakdown);
    }
    for (const agent of entry.agents ?? []) {
      accumulateAgentBreakdown(agentBreakdowns, agent);
    }
  }

  const merged: PeriodEntry = {
    period: year,
    totalCost,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    modelsUsed: [...modelsUsed],
    modelBreakdowns: [...modelNames.values()],
    metadata: { agents: [...agents] },
    agents: [...agentBreakdowns.values()].map((acc) => {
      acc.merged.modelsUsed = [...acc.modelsUsed];
      acc.merged.modelBreakdowns = [...acc.modelNames.values()];
      return acc.merged;
    }),
    device: entries.find((e) => e.device !== undefined)?.device,
  };
  return merged;
}

// breakdown 配列から 6 フィールドの合計を計算する（1 パスで累積する）
function summarizeModelBreakdowns(breakdowns: readonly ModelBreakdown[]): {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} {
  let totalCost = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const b of breakdowns) {
    totalCost += b.cost;
    totalTokens += b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens;
    inputTokens += b.inputTokens;
    outputTokens += b.outputTokens;
    cacheReadTokens += b.cacheReadTokens;
    cacheCreationTokens += b.cacheCreationTokens;
  }
  return { totalCost, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

export function filterByModel(entries: PeriodEntry[], model: string | null): PeriodEntry[] {
  if (model === null) { return entries; }
  return entries.map((entry) => {
    const modelBreakdowns = entry.modelBreakdowns.filter((b) => b.modelName === model);
    const agents = (entry.agents ?? [])
      .map((agent) => {
        const agentModelBreakdowns = agent.modelBreakdowns.filter((b) => b.modelName === model);
        return {
          ...agent,
          ...summarizeModelBreakdowns(agentModelBreakdowns),
          modelsUsed: agentModelBreakdowns.map((b) => b.modelName),
          modelBreakdowns: agentModelBreakdowns,
        };
      })
      .filter((agent) => agent.modelBreakdowns.length > 0);
    return {
      ...entry,
      ...summarizeModelBreakdowns(modelBreakdowns),
      modelsUsed: modelBreakdowns.map((b) => b.modelName),
      modelBreakdowns,
      agents,
    };
  });
}

export function filterByAgent(entries: PeriodEntry[], agent: string | null): PeriodEntry[] {
  if (agent === null) { return entries; }
  return entries.flatMap((entry) => {
    const breakdown = entry.agents?.find((a) => a.agent === agent);
    if (!breakdown) { return []; }
    const filtered: PeriodEntry = {
      period: entry.period,
      totalCost: breakdown.totalCost,
      totalTokens: breakdown.totalTokens,
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      cacheReadTokens: breakdown.cacheReadTokens,
      cacheCreationTokens: breakdown.cacheCreationTokens,
      modelsUsed: breakdown.modelsUsed,
      modelBreakdowns: breakdown.modelBreakdowns,
      metadata: { agents: [breakdown.agent] },
      agents: [breakdown],
      device: entry.device,
    };
    return [filtered];
  });
}

export type PeriodRange =
  | { kind: "all" }
  | { kind: "fixed"; year: number; month?: number };

export function filterByRange(entries: PeriodEntry[], range: PeriodRange | undefined): PeriodEntry[] {
  const target = range ?? { kind: "all" };
  if (target.kind === "all") { return entries; }
  const prefix =
    target.month === undefined
      ? `${target.year}`
      : `${target.year}-${String(target.month).padStart(2, "0")}`;
  return entries.filter((entry) => entry.period.startsWith(prefix));
}

export function allModels(entries: PeriodEntry[]): string[] {
  const models = new Set<string>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) { models.add(breakdown.modelName); }
  }
  return [...models].sort();
}

// エージェントの情報源は agents[] 優先、metadata.agents はフォールバック。
// allAgents / buildAgentShare（経由で countAgents）がこの 1 箇所を使うことで、
// フィルタの選択肢とドーナツ・テーブルに表示されるエージェントが乖離しない
function agentNamesOf(entry: PeriodEntry): string[] {
  return entry.agents && entry.agents.length > 0
    ? entry.agents.map((agent) => agent.agent)
    : entry.metadata?.agents ?? [];
}

export function allAgents(entries: PeriodEntry[]): string[] {
  const agents = new Set<string>();
  for (const entry of entries) {
    for (const name of agentNamesOf(entry)) { agents.add(name); }
  }
  return [...agents].sort();
}

export const MODEL_PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
] as const;

export function modelColor(modelName: string, models: string[]): string {
  const index = models.indexOf(modelName);
  return MODEL_PALETTE[index % MODEL_PALETTE.length] ?? MODEL_PALETTE[0]!;
}

// キャッシュヒット率 = cacheRead / 全トークン。全トークン 0 のときは 0 を返す
export function hitRate(cacheReadTokens: number, totalTokens: number): number {
  return totalTokens === 0 ? 0 : cacheReadTokens / totalTokens;
}

export function cacheHitRate(entry: PeriodEntry): number {
  return hitRate(entry.cacheReadTokens, totalTokensOf(entry));
}

// 実効単価（$/MTok）= cost / tokens × 1e6。トークン 0 は単価を計算できないため 0 を返す
function effectiveUnitPrice(cost: number, tokens: number): number {
  return tokens === 0 ? 0 : (cost / tokens) * 1_000_000;
}

export interface ChartSeries {
  labels: string[];
  datasets: { label: string; data: (number | null)[] }[];
}

export function topModelsByCost(entries: PeriodEntry[], topN: number): string[] {
  const costByModel = new Map<string, number>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) {
      accumulateNumber(costByModel, breakdown.modelName, breakdown.cost);
    }
  }
  return [...costByModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([modelName]) => modelName);
}

export interface OtherBreakdownItem {
  modelName: string;
  cost: number;
  ratio: number;
}

export function otherBreakdown(entry: PeriodEntry, top: ReadonlySet<string>): OtherBreakdownItem[] {
  return entry.modelBreakdowns
    .filter((b) => !top.has(b.modelName))
    .map((b) => ({
      modelName: b.modelName,
      cost: b.cost,
      ratio: entry.totalCost === 0 ? 0 : (b.cost / entry.totalCost) * 100,
    }))
    .filter((b) => b.cost > 0)
    .sort((a, b) => b.cost - a.cost);
}

function distinctModelCount(entries: PeriodEntry[]): number {
  const models = new Set<string>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) { models.add(breakdown.modelName); }
  }
  return models.size;
}

export interface DashboardFilters {
  section: "daily" | "monthly" | "yearly";
  model: string | null;
  agent: string | null;
  range: PeriodRange;
}

export interface KpiSummary {
  totalCost: number;
  totalTokens: number;
  activeModelCount: number;
}

export function buildKpiSummary(entries: PeriodEntry[]): KpiSummary {
  const models = new Set<string>();
  let totalCost = 0;
  let totalTokens = 0;

  for (const entry of entries) {
    totalCost += entry.totalCost;
    totalTokens += entry.totalTokens;
    for (const breakdown of entry.modelBreakdowns) { models.add(breakdown.modelName); }
  }

  return { totalCost, totalTokens, activeModelCount: models.size };
}

export interface AgentShareData {
  agents: string[];
  cost: number[];
  tokens: number[];
  costShare: number[];
  tokenShare: number[];
  totalCost: number;
  totalTokens: number;
  hasDetail: boolean;
}

export interface AgentEfficiency {
  agent: string;
  cost: number;
  tokens: number;
  unitPrice: number;
  hitRate: number;
}

export function buildAgentEfficiency(entries: PeriodEntry[]): AgentEfficiency[] {
  const byAgent = new Map<string, { cost: number; tokens: number; cacheRead: number }>();
  for (const entry of entries) {
    for (const breakdown of entry.agents ?? []) {
      const agg = byAgent.get(breakdown.agent) ?? { cost: 0, tokens: 0, cacheRead: 0 };
      agg.cost += breakdown.totalCost;
      agg.tokens += breakdown.totalTokens;
      agg.cacheRead += breakdown.cacheReadTokens;
      byAgent.set(breakdown.agent, agg);
    }
  }
  return [...byAgent.entries()]
    .map(([agent, agg]) => ({
      agent,
      cost: agg.cost,
      tokens: agg.tokens,
      unitPrice: effectiveUnitPrice(agg.cost, agg.tokens),
      hitRate: hitRate(agg.cacheRead, agg.tokens),
    }))
    .sort((a, b) => b.cost - a.cost);
}

// ドーナツの内訳値を cost / token で切り替える（図・中央値・表で同じ値を使うための単一経路）
export function agentDonutData(efficiency: AgentEfficiency[], seg: "cost" | "token"): number[] {
  return efficiency.map((e) => (seg === "cost" ? e.cost : e.tokens));
}

export function buildAgentShare(entries: PeriodEntry[]): AgentShareData {
  const costByAgent = new Map<string, number>();
  const tokensByAgent = new Map<string, number>();
  let hasDetail = false;

  for (const entry of entries) {
    if (entry.agents && entry.agents.length > 0) {
      hasDetail = true;
      for (const agent of entry.agents) {
        accumulateNumber(costByAgent, agent.agent, agent.totalCost);
        accumulateNumber(tokensByAgent, agent.agent, agent.totalTokens);
      }
    } else {
      for (const name of agentNamesOf(entry)) {
        if (!costByAgent.has(name)) { costByAgent.set(name, 0); }
        if (!tokensByAgent.has(name)) { tokensByAgent.set(name, 0); }
      }
    }
  }

  const agents = [...costByAgent.keys()].sort(
    (a, b) => (costByAgent.get(b) ?? 0) - (costByAgent.get(a) ?? 0),
  );
  const agentCostTotal = agents.reduce((sum, name) => sum + (costByAgent.get(name) ?? 0), 0);
  const agentTokenTotal = agents.reduce((sum, name) => sum + (tokensByAgent.get(name) ?? 0), 0);

  return {
    agents,
    cost: agents.map((name) => costByAgent.get(name) ?? 0),
    tokens: agents.map((name) => tokensByAgent.get(name) ?? 0),
    costShare: agents.map((name) => (agentCostTotal === 0 ? 0 : (costByAgent.get(name) ?? 0) / agentCostTotal)),
    tokenShare: agents.map((name) => (agentTokenTotal === 0 ? 0 : (tokensByAgent.get(name) ?? 0) / agentTokenTotal)),
    totalCost: entries.reduce((sum, e) => sum + e.totalCost, 0),
    totalTokens: entries.reduce((sum, e) => sum + e.totalTokens, 0),
    hasDetail,
  };
}

export interface DashboardSeries {
  costStacked: ChartSeries;
  modelMix: ChartSeries;
  unitPrice: ChartSeries;
  unitPrices: ModelUnitPrice[];
  agentShare: AgentShareData;
  cacheHitRate: ChartSeries;
  kpi: KpiSummary;
  entries: PeriodEntry[];
}

export function buildDashboardSeries(data: UsageData, filters: DashboardFilters): DashboardSeries {
  return buildDashboardSeriesFromEntries(selectSectionEntries(data, filters.section, filters));
}

// 事前に選択済み entries を受け取り、全系列を組み立てる。
// render 側が selectSectionEntries を二重実行せず、選別結果と集計結果を共有できる
export function buildDashboardSeriesFromEntries(entries: PeriodEntry[]): DashboardSeries {
  const unitPrices = buildModelUnitPrices(entries);
  return {
    costStacked: buildModelCostSeries(entries, TOP_N),
    modelMix: buildModelMixSeries(entries, TOP_N),
    unitPrice: unitPriceSeries(unitPrices),
    unitPrices,
    agentShare: buildAgentShare(entries),
    cacheHitRate: buildCacheHitRateSeries(entries),
    kpi: buildKpiSummary(entries),
    entries,
  };
}

// 上位トップNモデル + 「その他」バケットの期間系列を組み立てる共通ヘルパー。
// cost と ratio（構成比）の 2 系統が値の計算式だけ異なるため、valueFor で差し替える
function buildTopModelSeries(
  entries: PeriodEntry[],
  topN: number,
  valueFor: (entry: PeriodEntry, modelName: string | null, top: ReadonlySet<string>) => number,
): ChartSeries {
  const labels = entries.map((e) => e.period);
  const top = topModelsByCost(entries, topN);
  const topSet = new Set(top);
  const datasets = top.map((model) => ({
    label: model,
    data: entries.map((entry) => valueFor(entry, model, topSet)),
  }));
  if (top.length < distinctModelCount(entries)) {
    datasets.push({
      label: OTHER_LABEL,
      data: entries.map((entry) => valueFor(entry, null, topSet)),
    });
  }
  return { labels, datasets };
}

export function buildModelCostSeries(entries: PeriodEntry[], topN: number = TOP_N): ChartSeries {
  return buildTopModelSeries(entries, topN, (entry, modelName, top) => {
    if (modelName === null) {
      return entry.modelBreakdowns.filter((b) => !top.has(b.modelName)).reduce((sum, b) => sum + b.cost, 0);
    }
    return entry.modelBreakdowns.find((b) => b.modelName === modelName)?.cost ?? 0;
  });
}

export function buildModelMixSeries(entries: PeriodEntry[], topN: number = TOP_N): ChartSeries {
  return buildTopModelSeries(entries, topN, (entry, modelName, top) => {
    if (entry.totalCost === 0) { return 0; }
    if (modelName === null) {
      const rest = entry.modelBreakdowns.filter((b) => !top.has(b.modelName));
      return (rest.reduce((sum, b) => sum + b.cost, 0) / entry.totalCost) * 100;
    }
    const breakdown = entry.modelBreakdowns.find((b) => b.modelName === modelName);
    return breakdown ? (breakdown.cost / entry.totalCost) * 100 : 0;
  });
}

export interface ModelUnitPrice {
  modelName: string;
  unitPrice: number;
  hitRate: number;
}

export interface ModelCostRank {
  modelName: string;
  cost: number;
  ratio: number;
}

export function buildModelCostRanking(entries: PeriodEntry[]): ModelCostRank[] {
  const costByModel = new Map<string, number>();
  let totalCost = 0;
  for (const entry of entries) {
    totalCost += entry.totalCost;
    for (const breakdown of entry.modelBreakdowns) {
      accumulateNumber(costByModel, breakdown.modelName, breakdown.cost);
    }
  }
  return [...costByModel.entries()]
    .map(([modelName, cost]) => ({
      modelName,
      cost,
      ratio: totalCost === 0 ? 0 : (cost / totalCost) * 100,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export function buildModelUnitPrices(entries: PeriodEntry[]): ModelUnitPrice[] {
  const byModel = new Map<string, { cost: number; tokens: number; cacheRead: number }>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) {
      const agg = byModel.get(breakdown.modelName) ?? { cost: 0, tokens: 0, cacheRead: 0 };
      agg.cost += breakdown.cost;
      agg.tokens += totalTokensOf(breakdown);
      agg.cacheRead += breakdown.cacheReadTokens;
      byModel.set(breakdown.modelName, agg);
    }
  }
  return [...byModel.entries()]
    .map(([modelName, agg]) => ({
      modelName,
      unitPrice: effectiveUnitPrice(agg.cost, agg.tokens),
      hitRate: hitRate(agg.cacheRead, agg.tokens),
    }))
    .sort((a, b) => b.unitPrice - a.unitPrice);
}

function unitPriceSeries(prices: ModelUnitPrice[]): ChartSeries {
  return {
    labels: prices.map((p) => p.modelName),
    datasets: [{ label: "実効単価 ($/MTok)", data: prices.map((p) => p.unitPrice) }],
  };
}

export function buildUnitPriceSeries(entries: PeriodEntry[]): ChartSeries {
  // 実効単価の集計は buildModelUnitPrices と共有する（同一ロジックの二重実装を避ける）
  return unitPriceSeries(buildModelUnitPrices(entries));
}

export function buildCacheHitRateSeries(entries: PeriodEntry[]): ChartSeries {
  const labels = entries.map((e) => e.period);
  return {
    labels,
    datasets: [{ label: "キャッシュヒット率", data: entries.map((e) => cacheHitRate(e)) }],
  };
}
