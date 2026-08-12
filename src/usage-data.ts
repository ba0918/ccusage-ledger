import type { UsageData } from "./types";

// データ取得（--sections）と検証の両方で同じセクション集合を使う。
// fetch-usage.ts の DEFAULT_COMMAND がここから --sections を構築するため、片方だけ更新してずれる事故を防ぐ
export const SECTIONS = ["daily", "monthly"] as const;

// daily は YYYY-MM-DD、monthly は YYYY-MM。buildYearly（slice(0,4)）と filterByRange（prefix 照合）が
// この固定幅を前提にするため、形式が変わった場合は早期に検証で弾く
export function isValidPeriod(period: string, section: "daily" | "monthly"): boolean {
  if (section === "daily") { return /^\d{4}-\d{2}-\d{2}$/.test(period); }
  return /^\d{4}-\d{2}$/.test(period);
}

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

// 巨大データ（型だけ合っていて件数・文字列長が異常なキャッシュ）による起動時/描画時 DoS を防ぐ上限。
// 上限を超えるデータはスキーマ不一致として扱い、キャッシュは「データなし」に縮退させる（fail-closed）
export const MAX_SECTION_ENTRIES = 10_000;
export const MAX_MODELS_USED = 200;
export const MAX_MODEL_BREAKDOWNS = 500;
export const MAX_AGENTS = 500;
export const MAX_STRING_LENGTH = 200;

function isBoundedString(value: unknown, maxLength: number = MAX_STRING_LENGTH): boolean {
  return typeof value === "string" && value.length <= maxLength;
}

function isStringArray(value: unknown, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= maxLength && value.every((item) => isBoundedString(item));
}

function isModelBreakdown(value: unknown): boolean {
  if (typeof value !== "object" || value === null) { return false; }
  const record = value as Record<string, unknown>;
  if (!isBoundedString(record.modelName)) { return false; }
  return BREAKDOWN_NUMERIC_FIELDS.every((field) => typeof record[field] === "number");
}

function isAgentBreakdown(value: unknown): boolean {
  if (typeof value !== "object" || value === null) { return false; }
  const record = value as Record<string, unknown>;
  if (!isBoundedString(record.agent)) { return false; }
  if (!NUMERIC_FIELDS.every((field) => typeof record[field] === "number")) { return false; }
  if (!isStringArray(record.modelsUsed, MAX_MODELS_USED)) { return false; }
  if (!Array.isArray(record.modelBreakdowns) || record.modelBreakdowns.length > MAX_MODEL_BREAKDOWNS) { return false; }
  if (!record.modelBreakdowns.every(isModelBreakdown)) { return false; }
  return true;
}

function isValidPeriodEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) { return false; }
  const record = value as Record<string, unknown>;
  if (!STRING_FIELDS.every((field) => isBoundedString(record[field]))) { return false; }
  if (!NUMERIC_FIELDS.every((field) => typeof record[field] === "number")) { return false; }
  // modelsUsed / modelBreakdowns は PeriodEntry 型で必須。optional 扱いだと
  // projectUsageData や集計が undefined に触れて描画途中でクラッシュする
  if (!isStringArray(record.modelsUsed, MAX_MODELS_USED)) { return false; }
  if (!Array.isArray(record.modelBreakdowns) || record.modelBreakdowns.length > MAX_MODEL_BREAKDOWNS) { return false; }
  if (!record.modelBreakdowns.every(isModelBreakdown)) { return false; }
  if (record.agents !== undefined && (!Array.isArray(record.agents) || record.agents.length > MAX_AGENTS || !record.agents.every(isAgentBreakdown))) { return false; }
  // device は将来の描画候補（フリー形式文字列）。型と長さだけはここで検証して
  // 異常値を流さない（描画側で必ず htmlText を通すことも合わせて必須）
  if (record.device !== undefined && !isBoundedString(record.device)) { return false; }
  return true;
}

// 型不一致の JSON（totalCost が文字列など）を起動時・ロード時に弾き、
// 描画途中でクラッシュしないようにする。件数・文字列長の上限もここで検証する
export function isUsageData(value: unknown): value is UsageData {
  if (typeof value !== "object" || value === null) { return false; }
  const record = value as Record<string, unknown>;
  for (const section of SECTIONS) {
    const entries = record[section];
    if (!Array.isArray(entries) || entries.length > MAX_SECTION_ENTRIES) { return false; }
    if (!entries.every((entry) => isValidPeriodEntry(entry) && isValidPeriod((entry as { period: string }).period, section))) { return false; }
  }
  return true;
}

// クライアントが消費する既知フィールドだけを抽出した projection を返す。
// /api/usage で未知フィールド（ccusage が将来追加する項目など）をそのまま公開しないための「白リスト投影」
export function projectUsageData(value: UsageData): UsageData {
  const projectModelBreakdown = (b: { modelName: string; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }) => ({
    modelName: b.modelName,
    cost: b.cost,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheReadTokens: b.cacheReadTokens,
    cacheCreationTokens: b.cacheCreationTokens,
  });
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
      modelBreakdowns: entry.modelBreakdowns.map(projectModelBreakdown),
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
        modelBreakdowns: a.modelBreakdowns.map(projectModelBreakdown),
      })),
      device: entry.device,
    }));

  return {
    daily: sectionEntries("daily"),
    monthly: sectionEntries("monthly"),
  };
}
