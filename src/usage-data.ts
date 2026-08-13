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
// 全期間を横断した distinct モデル名 / エージェント名の上限。個別エントリの件数上限（MAX_MODEL_BREAKDOWNS /
// MAX_AGENTS）では、エントリ横断で無数の名前を作るキャッシュを止められない。クライアントの
// allModels()/allAgents() が全 distinct 名を Set 化し fillSelect が <option> を 1 名ずつ生やすため、
// この横断 cap でクライアント render の freeze / OOM を防ぐ（fail-closed）
export const MAX_DISTINCT_MODELS = 1000;
export const MAX_DISTINCT_AGENTS = 1000;
// 数値フィールドの絶対値上限。NaN/Infinity は finite チェックで弾くが、1e308 のような巨大な
// 有限値は加算で Infinity に溢れ、集計結果・チャート全体を NaN/Infinity で汚染する。
// 個人用ダッシュボードのコスト・トークン量として現実的な上限（1e12）を設けて弾く
export const MAX_NUMERIC_MAGNITUDE = 1e12;

// C0 制御文字（タブ・LF・CR 以外）と DEL。HTML エスケープでは制御文字を無害化しきれない
// 文脈（script 埋め込み等）への将来の流入に備えてデータ層で拒否する（attack-review F9）。
// モデル名・エージェント名に制御文字が現れることは正当なデータでも無い。
// biome の noControlCharactersInRegex を避けるため、リテラルにエスケープを含めず動的に構築する
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

function isBoundedString(value: unknown, maxLength: number = MAX_STRING_LENGTH): boolean {
  return typeof value === "string" && value.length <= maxLength && !CONTROL_CHARS.test(value);
}

function isStringArray(value: unknown, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= maxLength && value.every((item) => isBoundedString(item));
}

function isValidUsageNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_NUMERIC_MAGNITUDE;
}

function isModelBreakdown(value: unknown): boolean {
  if (typeof value !== "object" || value === null) { return false; }
  const record = value as Record<string, unknown>;
  if (!isBoundedString(record.modelName)) { return false; }
  return BREAKDOWN_NUMERIC_FIELDS.every((field) => isValidUsageNumber(record[field]));
}

function isAgentBreakdown(value: unknown): boolean {
  if (typeof value !== "object" || value === null) { return false; }
  const record = value as Record<string, unknown>;
  if (!isBoundedString(record.agent)) { return false; }
  if (!NUMERIC_FIELDS.every((field) => isValidUsageNumber(record[field]))) { return false; }
  if (!isStringArray(record.modelsUsed, MAX_MODELS_USED)) { return false; }
  if (!Array.isArray(record.modelBreakdowns) || record.modelBreakdowns.length > MAX_MODEL_BREAKDOWNS) { return false; }
  if (!record.modelBreakdowns.every(isModelBreakdown)) { return false; }
  return true;
}

function isValidPeriodEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) { return false; }
  const record = value as Record<string, unknown>;
  if (!STRING_FIELDS.every((field) => isBoundedString(record[field]))) { return false; }
  if (!NUMERIC_FIELDS.every((field) => isValidUsageNumber(record[field]))) { return false; }
  // modelsUsed / modelBreakdowns は PeriodEntry 型で必須。optional 扱いだと
  // projectUsageData や集計が undefined に触れて描画途中でクラッシュする
  if (!isStringArray(record.modelsUsed, MAX_MODELS_USED)) { return false; }
  if (!Array.isArray(record.modelBreakdowns) || record.modelBreakdowns.length > MAX_MODEL_BREAKDOWNS) { return false; }
  if (!record.modelBreakdowns.every(isModelBreakdown)) { return false; }
  if (record.agents !== undefined && (!Array.isArray(record.agents) || record.agents.length > MAX_AGENTS || !record.agents.every(isAgentBreakdown))) { return false; }
  // metadata.agents はモデル/エージェント名と同様に扱うフリー文字列配列。
  // 検証されないとキャップを迂回してサーバ OOM / クライアント freeze を起こせるため、
  // agents と同じ MAX_AGENTS / MAX_STRING_LENGTH で検証する（fail-closed）
  if (record.metadata !== undefined) {
    if (typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata)) { return false; }
    const metadata = record.metadata as Record<string, unknown>;
    if (metadata.agents !== undefined && !isStringArray(metadata.agents, MAX_AGENTS)) { return false; }
  }
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
  const models = new Set<string>();
  const agents = new Set<string>();
  for (const section of SECTIONS) {
    const entries = record[section];
    if (!Array.isArray(entries) || entries.length > MAX_SECTION_ENTRIES) { return false; }
    if (!entries.every((entry) => isValidPeriodEntry(entry) && isValidPeriod((entry as { period: string }).period, section))) { return false; }
    // 個別エントリ検証に合格した後、エントリ横断で distinct 名を集計する。
    // modelBreakdowns / modelsUsed がモデル名、agents / metadata.agents がエージェント名の情報源
    // （aggregate.ts の allModels / agentNamesOf と同じ出所に揃える）
    for (const entry of entries) {
      const e = entry as {
        modelsUsed: string[];
        modelBreakdowns: { modelName: string }[];
        agents?: { agent: string }[];
        metadata?: { agents?: string[] };
      };
      for (const name of e.modelsUsed) { models.add(name); }
      for (const b of e.modelBreakdowns) { models.add(b.modelName); }
      for (const a of e.agents ?? []) { agents.add(a.agent); }
      for (const name of e.metadata?.agents ?? []) { agents.add(name); }
    }
  }
  if (models.size > MAX_DISTINCT_MODELS || agents.size > MAX_DISTINCT_AGENTS) { return false; }
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
      // device は型定義には残す（将来の複数デバイス対応）が、クライアントがまだ消費していない
      // ため投影からは落とす（totals と同様。未使用フィールドを配信してフィンガープリントに
      // 使われるのを防ぐ。将来描画するときに投影へ追加する）
    }));

  return {
    daily: sectionEntries("daily"),
    monthly: sectionEntries("monthly"),
  };
}
