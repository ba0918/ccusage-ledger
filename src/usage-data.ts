import type { UsageData } from "./types";

const SECTIONS = ["daily", "monthly"] as const;

const STRING_FIELDS = ["period"] as const;

const NUMERIC_FIELDS = [
  "totalCost",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;

const BREAKDOWN_NUMERIC_FIELDS = ["cost", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;

function isModelBreakdown(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.modelName !== "string") return false;
  return BREAKDOWN_NUMERIC_FIELDS.every((field) => typeof record[field] === "number");
}

function isAgentBreakdown(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.agent !== "string") return false;
  if (!NUMERIC_FIELDS.every((field) => typeof record[field] === "number")) return false;
  if (!Array.isArray(record.modelsUsed) || !record.modelsUsed.every((name) => typeof name === "string")) return false;
  if (!Array.isArray(record.modelBreakdowns) || !record.modelBreakdowns.every(isModelBreakdown)) return false;
  return true;
}

function isValidPeriodEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!STRING_FIELDS.every((field) => typeof record[field] === "string")) return false;
  if (!NUMERIC_FIELDS.every((field) => typeof record[field] === "number")) return false;
  if (record.modelsUsed !== undefined && (!Array.isArray(record.modelsUsed) || !record.modelsUsed.every((name) => typeof name === "string"))) return false;
  if (record.modelBreakdowns !== undefined && (!Array.isArray(record.modelBreakdowns) || !record.modelBreakdowns.every(isModelBreakdown))) return false;
  if (record.agents !== undefined && (!Array.isArray(record.agents) || !record.agents.every(isAgentBreakdown))) return false;
  return true;
}

// 型不一致の JSON（totalCost が文字列など）を起動時・ロード時に弾き、
// 描画途中でクラッシュしないようにする
export function isUsageData(value: unknown): value is UsageData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  for (const section of SECTIONS) {
    const entries = record[section];
    if (!Array.isArray(entries) || !entries.every(isValidPeriodEntry)) return false;
  }
  return true;
}

// クライアントが消費する既知フィールドだけを抽出した projection を返す。
// /api/usage で未知フィールド（ccusage が将来追加する項目など）をそのまま公開しないための「白リスト投影」
export function projectUsageData(value: UsageData): UsageData {
  const sectionEntries = (section: "daily" | "monthly") =>
    (value[section] ?? []).map((entry) => ({
      period: entry.period,
      totalCost: entry.totalCost,
      totalTokens: entry.totalTokens,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      modelsUsed: entry.modelsUsed,
      modelBreakdowns: entry.modelBreakdowns.map((b) => ({
        modelName: b.modelName,
        cost: b.cost,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheReadTokens: b.cacheReadTokens,
        cacheCreationTokens: b.cacheCreationTokens,
      })),
      metadata: entry.metadata ? { agents: entry.metadata.agents } : undefined,
      agents: entry.agents?.map((a) => ({
        agent: a.agent,
        totalCost: a.totalCost,
        totalTokens: a.totalTokens,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        cacheReadTokens: a.cacheReadTokens,
        cacheCreationTokens: a.cacheCreationTokens,
        modelsUsed: a.modelsUsed,
        modelBreakdowns: a.modelBreakdowns.map((b) => ({
          modelName: b.modelName,
          cost: b.cost,
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          cacheReadTokens: b.cacheReadTokens,
          cacheCreationTokens: b.cacheCreationTokens,
        })),
      })),
      device: entry.device,
    }));

  return {
    daily: sectionEntries("daily"),
    monthly: sectionEntries("monthly"),
  };
}
