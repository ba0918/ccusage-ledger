import type { ModelBreakdown, PeriodEntry, UsageData } from "./types";

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
  filters: { model: string | null; agent: string | null },
): PeriodEntry[] {
  const entries = section === "yearly" ? buildYearly(getSection(data, "monthly")) : getSection(data, section);
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
    device: entries.find((e) => e.device !== undefined)?.device,
  };
  return merged;
}

export function filterByModel(entries: PeriodEntry[], model: string | null): PeriodEntry[] {
  if (model === null) return entries;
  return entries.map((entry) => {
    const modelBreakdowns = entry.modelBreakdowns.filter((b) => b.modelName === model);
    const filtered: PeriodEntry = {
      ...entry,
      totalCost: modelBreakdowns.reduce((s, b) => s + b.cost, 0),
      totalTokens: modelBreakdowns.reduce((s, b) => s + totalTokensOf(b), 0),
      inputTokens: modelBreakdowns.reduce((s, b) => s + b.inputTokens, 0),
      outputTokens: modelBreakdowns.reduce((s, b) => s + b.outputTokens, 0),
      cacheReadTokens: modelBreakdowns.reduce((s, b) => s + b.cacheReadTokens, 0),
      cacheCreationTokens: modelBreakdowns.reduce((s, b) => s + b.cacheCreationTokens, 0),
      modelsUsed: modelBreakdowns.map((b) => b.modelName),
      modelBreakdowns,
    };
    return filtered;
  });
}

export function filterByAgent(entries: PeriodEntry[], agent: string | null): PeriodEntry[] {
  if (agent === null) return entries;
  return entries.filter((entry) => entry.metadata?.agents?.includes(agent) ?? false);
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

function orderedModels(entries: PeriodEntry[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) {
      if (!seen.has(breakdown.modelName)) {
        seen.add(breakdown.modelName);
        order.push(breakdown.modelName);
      }
    }
  }
  return order;
}

export interface DashboardFilters {
  section: "daily" | "monthly" | "yearly";
  model: string | null;
  agent: string | null;
}

export interface DashboardSeries {
  dailyCost: ChartSeries;
  monthlyCost: ChartSeries;
  modelMix: ChartSeries;
  unitPrice: ChartSeries;
  cacheHitRate: ChartSeries;
}

export function buildDashboardSeries(data: UsageData, filters: DashboardFilters): DashboardSeries {
  const daily = selectSectionEntries(data, "daily", filters);
  const monthly = selectSectionEntries(data, "monthly", filters);
  const section = selectSectionEntries(data, filters.section, filters);

  return {
    dailyCost: buildModelCostSeries(daily),
    monthlyCost: buildCostBarSeries(monthly),
    modelMix: buildModelMixSeries(section),
    unitPrice: buildUnitPriceSeries(section),
    cacheHitRate: buildCacheHitRateSeries(section),
  };
}

export function buildModelCostSeries(entries: PeriodEntry[]): ChartSeries {
  const labels = entries.map((e) => e.period);
  const models = orderedModels(entries);
  const datasets = models.map((model) => ({
    label: model,
    data: entries.map((entry) => {
      const bd = entry.modelBreakdowns.find((b) => b.modelName === model);
      return bd ? bd.cost : 0;
    }),
  }));
  return { labels, datasets };
}

export function buildCostBarSeries(entries: PeriodEntry[]): ChartSeries {
  const labels = entries.map((e) => e.period);
  return {
    labels,
    datasets: [{ label: "コスト", data: entries.map((e) => e.totalCost) }],
  };
}

export function buildModelMixSeries(entries: PeriodEntry[]): ChartSeries {
  const labels = entries.map((e) => e.period);
  const models = orderedModels(entries);
  const datasets = models.map((model) => ({
    label: model,
    data: entries.map((entry) => {
      const bd = entry.modelBreakdowns.find((b) => b.modelName === model);
      if (!bd || entry.totalCost === 0) return 0;
      return (bd.cost / entry.totalCost) * 100;
    }),
  }));
  return { labels, datasets };
}

export function buildUnitPriceSeries(entries: PeriodEntry[]): ChartSeries {
  const labels = entries.map((e) => e.period);
  const models = orderedModels(entries);
  const datasets = models.map((model) => ({
    label: model,
    data: entries.map((entry) => {
      const bd = entry.modelBreakdowns.find((b) => b.modelName === model);
      return bd ? modelUnitPrice(bd) : null;
    }),
  }));
  return { labels, datasets };
}

export function buildCacheHitRateSeries(entries: PeriodEntry[]): ChartSeries {
  const labels = entries.map((e) => e.period);
  return {
    labels,
    datasets: [{ label: "キャッシュヒット率", data: entries.map((e) => cacheHitRate(e)) }],
  };
}
