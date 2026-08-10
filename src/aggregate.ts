import type { AgentBreakdown, ModelBreakdown, PeriodEntry, UsageData } from "./types";

export const TOP_N = 5;

export type Section = "daily" | "monthly";

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;

function totalTokensOf(entry: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number {
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

function mergeEntries(year: string, entries: PeriodEntry[]): PeriodEntry {
  const modelNames = new Map<string, ModelBreakdown>();
  const agents = new Set<string>();
  const modelsUsed = new Set<string>();
  const agentBreakdowns = new Map<string, AgentBreakdown>();
  let totalCost = 0;

  for (const entry of entries) {
    totalCost += entry.totalCost;
    for (const model of entry.modelsUsed) modelsUsed.add(model);
    for (const agent of entry.metadata?.agents ?? []) agents.add(agent);
    for (const breakdown of entry.modelBreakdowns) {
      const merged = modelNames.get(breakdown.modelName) ?? {
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
      modelNames.set(breakdown.modelName, merged);
    }
    for (const agent of entry.agents ?? []) {
      const merged = agentBreakdowns.get(agent.agent) ?? {
        agent: agent.agent,
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelsUsed: [],
        modelBreakdowns: [],
      };
      merged.totalCost += agent.totalCost;
      merged.totalTokens += agent.totalTokens;
      merged.inputTokens += agent.inputTokens;
      merged.outputTokens += agent.outputTokens;
      merged.cacheReadTokens += agent.cacheReadTokens;
      merged.cacheCreationTokens += agent.cacheCreationTokens;
      for (const model of agent.modelsUsed) {
        if (!merged.modelsUsed.includes(model)) merged.modelsUsed.push(model);
      }
      for (const breakdown of agent.modelBreakdowns) {
        const agentModel = merged.modelBreakdowns.find((b) => b.modelName === breakdown.modelName);
        if (agentModel) {
          agentModel.cost += breakdown.cost;
          agentModel.inputTokens += breakdown.inputTokens;
          agentModel.outputTokens += breakdown.outputTokens;
          agentModel.cacheReadTokens += breakdown.cacheReadTokens;
          agentModel.cacheCreationTokens += breakdown.cacheCreationTokens;
        } else {
          merged.modelBreakdowns.push({ ...breakdown });
        }
      }
      agentBreakdowns.set(agent.agent, merged);
    }
  }

  const merged: PeriodEntry = {
    period: year,
    totalCost,
    totalTokens: entries.reduce((sumTokens, e) => sumTokens + e.totalTokens, 0),
    inputTokens: entries.reduce((s, e) => s + e.inputTokens, 0),
    outputTokens: entries.reduce((s, e) => s + e.outputTokens, 0),
    cacheReadTokens: entries.reduce((s, e) => s + e.cacheReadTokens, 0),
    cacheCreationTokens: entries.reduce((s, e) => s + e.cacheCreationTokens, 0),
    modelsUsed: [...modelsUsed],
    modelBreakdowns: [...modelNames.values()],
    metadata: { agents: [...agents] },
    agents: [...agentBreakdowns.values()],
    device: entries.find((e) => e.device !== undefined)?.device,
  };
  return merged;
}

export function filterByModel(entries: PeriodEntry[], model: string | null): PeriodEntry[] {
  if (model === null) return entries;
  return entries.map((entry) => {
    const modelBreakdowns = entry.modelBreakdowns.filter((b) => b.modelName === model);
    const agents = (entry.agents ?? [])
      .map((agent) => {
        const agentModelBreakdowns = agent.modelBreakdowns.filter((b) => b.modelName === model);
        return {
          ...agent,
          totalCost: agentModelBreakdowns.reduce((s, b) => s + b.cost, 0),
          totalTokens: agentModelBreakdowns.reduce((s, b) => s + totalTokensOf(b), 0),
          inputTokens: agentModelBreakdowns.reduce((s, b) => s + b.inputTokens, 0),
          outputTokens: agentModelBreakdowns.reduce((s, b) => s + b.outputTokens, 0),
          cacheReadTokens: agentModelBreakdowns.reduce((s, b) => s + b.cacheReadTokens, 0),
          cacheCreationTokens: agentModelBreakdowns.reduce((s, b) => s + b.cacheCreationTokens, 0),
          modelsUsed: agentModelBreakdowns.map((b) => b.modelName),
          modelBreakdowns: agentModelBreakdowns,
        };
      })
      .filter((agent) => agent.modelBreakdowns.length > 0);
    return {
      ...entry,
      totalCost: modelBreakdowns.reduce((s, b) => s + b.cost, 0),
      totalTokens: modelBreakdowns.reduce((s, b) => s + totalTokensOf(b), 0),
      inputTokens: modelBreakdowns.reduce((s, b) => s + b.inputTokens, 0),
      outputTokens: modelBreakdowns.reduce((s, b) => s + b.outputTokens, 0),
      cacheReadTokens: modelBreakdowns.reduce((s, b) => s + b.cacheReadTokens, 0),
      cacheCreationTokens: modelBreakdowns.reduce((s, b) => s + b.cacheCreationTokens, 0),
      modelsUsed: modelBreakdowns.map((b) => b.modelName),
      modelBreakdowns,
      agents,
    };
  });
}

export function filterByAgent(entries: PeriodEntry[], agent: string | null): PeriodEntry[] {
  if (agent === null) return entries;
  return entries.flatMap((entry) => {
    const breakdown = entry.agents?.find((a) => a.agent === agent);
    if (!breakdown) return [];
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
  if (target.kind === "all") return entries;
  const prefix =
    target.month === undefined
      ? `${target.year}`
      : `${target.year}-${String(target.month).padStart(2, "0")}`;
  return entries.filter((entry) => entry.period.startsWith(prefix));
}

export function allModels(entries: PeriodEntry[]): string[] {
  const models = new Set<string>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) models.add(breakdown.modelName);
  }
  return [...models].sort();
}

export function allAgents(entries: PeriodEntry[]): string[] {
  const agents = new Set<string>();
  for (const entry of entries) {
    for (const agent of entry.metadata?.agents ?? []) agents.add(agent);
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

export function modelUnitPrice(breakdown: ModelBreakdown): number {
  const tokens = totalTokensOf(breakdown);
  if (tokens === 0) return 0;
  return (breakdown.cost / tokens) * 1_000_000;
}

export function cacheHitRate(entry: PeriodEntry): number {
  const tokens = totalTokensOf(entry);
  if (tokens === 0) return 0;
  return entry.cacheReadTokens / tokens;
}

export interface ChartSeries {
  labels: string[];
  datasets: { label: string; data: (number | null)[] }[];
}

export function topModelsByCost(entries: PeriodEntry[], topN: number): string[] {
  const costByModel = new Map<string, number>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) {
      costByModel.set(breakdown.modelName, (costByModel.get(breakdown.modelName) ?? 0) + breakdown.cost);
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
    for (const breakdown of entry.modelBreakdowns) models.add(breakdown.modelName);
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
    for (const breakdown of entry.modelBreakdowns) models.add(breakdown.modelName);
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
      unitPrice: agg.tokens === 0 ? 0 : (agg.cost / agg.tokens) * 1_000_000,
      hitRate: agg.tokens === 0 ? 0 : agg.cacheRead / agg.tokens,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export function buildAgentShare(entries: PeriodEntry[]): AgentShareData {
  const costByAgent = new Map<string, number>();
  const tokensByAgent = new Map<string, number>();
  let hasDetail = false;

  for (const entry of entries) {
    if (entry.agents && entry.agents.length > 0) {
      hasDetail = true;
      for (const agent of entry.agents) {
        costByAgent.set(agent.agent, (costByAgent.get(agent.agent) ?? 0) + agent.totalCost);
        tokensByAgent.set(agent.agent, (tokensByAgent.get(agent.agent) ?? 0) + agent.totalTokens);
      }
    } else {
      for (const name of entry.metadata?.agents ?? []) {
        if (!costByAgent.has(name)) costByAgent.set(name, 0);
        if (!tokensByAgent.has(name)) tokensByAgent.set(name, 0);
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
  agentShare: AgentShareData;
  cacheHitRate: ChartSeries;
  kpi: KpiSummary;
}

export function buildDashboardSeries(data: UsageData, filters: DashboardFilters): DashboardSeries {
  const entries = selectSectionEntries(data, filters.section, filters);

  return {
    costStacked: buildModelCostSeries(entries, TOP_N),
    modelMix: buildModelMixSeries(entries, TOP_N),
    unitPrice: buildUnitPriceSeries(entries),
    agentShare: buildAgentShare(entries),
    cacheHitRate: buildCacheHitRateSeries(entries),
    kpi: buildKpiSummary(entries),
  };
}

export function buildModelCostSeries(entries: PeriodEntry[], topN: number = TOP_N): ChartSeries {
  const labels = entries.map((e) => e.period);
  const top = topModelsByCost(entries, topN);
  const datasets = top.map((model) => ({
    label: model,
    data: entries.map((entry) => entry.modelBreakdowns.find((b) => b.modelName === model)?.cost ?? 0),
  }));
  if (top.length < distinctModelCount(entries)) {
    datasets.push({
      label: "その他",
      data: entries.map((entry) =>
        entry.modelBreakdowns.filter((b) => !top.includes(b.modelName)).reduce((sum, b) => sum + b.cost, 0),
      ),
    });
  }
  return { labels, datasets };
}

export function buildCostBarSeries(entries: PeriodEntry[]): ChartSeries {
  const labels = entries.map((e) => e.period);
  return {
    labels,
    datasets: [{ label: "コスト", data: entries.map((e) => e.totalCost) }],
  };
}

export function buildModelMixSeries(entries: PeriodEntry[], topN: number = TOP_N): ChartSeries {
  const labels = entries.map((e) => e.period);
  const top = topModelsByCost(entries, topN);
  const datasets = top.map((model) => ({
    label: model,
    data: entries.map((entry) => {
      if (entry.totalCost === 0) return 0;
      const breakdown = entry.modelBreakdowns.find((b) => b.modelName === model);
      return breakdown ? (breakdown.cost / entry.totalCost) * 100 : 0;
    }),
  }));
  if (top.length < distinctModelCount(entries)) {
    datasets.push({
      label: "その他",
      data: entries.map((entry) => {
        if (entry.totalCost === 0) return 0;
        const rest = entry.modelBreakdowns.filter((b) => !top.includes(b.modelName));
        return (rest.reduce((sum, b) => sum + b.cost, 0) / entry.totalCost) * 100;
      }),
    });
  }
  return { labels, datasets };
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
      costByModel.set(breakdown.modelName, (costByModel.get(breakdown.modelName) ?? 0) + breakdown.cost);
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
      unitPrice: agg.tokens === 0 ? 0 : (agg.cost / agg.tokens) * 1_000_000,
      hitRate: agg.tokens === 0 ? 0 : agg.cacheRead / agg.tokens,
    }))
    .sort((a, b) => b.unitPrice - a.unitPrice);
}

export function buildUnitPriceSeries(entries: PeriodEntry[]): ChartSeries {
  const costByModel = new Map<string, number>();
  const tokensByModel = new Map<string, number>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) {
      costByModel.set(breakdown.modelName, (costByModel.get(breakdown.modelName) ?? 0) + breakdown.cost);
      tokensByModel.set(breakdown.modelName, (tokensByModel.get(breakdown.modelName) ?? 0) + totalTokensOf(breakdown));
    }
  }
  const rows = [...costByModel.entries()]
    .map(([modelName, cost]) => {
      const tokens = tokensByModel.get(modelName) ?? 0;
      return { modelName, price: tokens === 0 ? 0 : (cost / tokens) * 1_000_000 };
    })
    .sort((a, b) => b.price - a.price);

  return {
    labels: rows.map((row) => row.modelName),
    datasets: [{ label: "実効単価 ($/MTok)", data: rows.map((row) => row.price) }],
  };
}

export function buildCacheHitRateSeries(entries: PeriodEntry[]): ChartSeries {
  const labels = entries.map((e) => e.period);
  return {
    labels,
    datasets: [{ label: "キャッシュヒット率", data: entries.map((e) => cacheHitRate(e)) }],
  };
}
