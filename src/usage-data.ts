import type { UsageData } from "./types";

const SECTIONS = ["daily", "monthly"] as const;

const NUMERIC_FIELDS = [
  "totalCost",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;

function isValidPeriodEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!NUMERIC_FIELDS.every((field) => typeof record[field] === "number")) return false;
  if (record.modelsUsed !== undefined && !Array.isArray(record.modelsUsed)) return false;
  if (record.modelBreakdowns !== undefined && !Array.isArray(record.modelBreakdowns)) return false;
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
