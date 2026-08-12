import type { AgentBreakdown, ModelBreakdown, PeriodEntry, UsageData } from "./types";

// このモジュールはクライアント専用の純計算レイヤーで、DOM・ランタイム（Bun/Node）に依存しない。
// 配置方針: 描画・DOM 操作を担うモジュールは src/client/、サーバ側（fetch-usage / usage-data /
// server）は src/ 直下、この純集計層は「クライアントとサーバのどちらにも属さない独立した計算層」として
// src/ 直下に置く。src/client/ へ移動しないのは、i18n / DOM に依存しない純関数群として
// テストと再利用を単一の場所に閉じるため。
export const TOP_N = 5;

// 上位 N モデル以外をまとめる「その他」バケットのラベル。表示層が t("other") で渡すため、
// 純計算層の既定値は言語に依存しない英語を使う
export const OTHER_LABEL = "Others";

// 系列ビルダーが受け取る表示ラベル群。unitPrice は単価チャート、cacheHit はキャッシュヒット率チャートの
// データセットラベル。main.ts が現在言語の t() 結果を渡す
export interface SeriesLabels {
  other: string;
  unitPrice: string;
  cacheHit: string;
}

// ラベル未指定（テスト互換・既存呼び出し）時の既定値。表示層は t() の現在言語ラベルを常に渡す
export const DEFAULT_LABELS: SeriesLabels = {
  other: OTHER_LABEL,
  unitPrice: "Effective unit price ($/MTok)",
  cacheHit: "Cache hit rate",
};

// 末尾（最新）max 件を返す。現在はテストでのみ使われる（描画行数のキャップは table.ts の
// latestPeriodsWithinRowBudget が担う）
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
    // トークン合計は totalTokensOf（4 フィールド和）に統一する（buildKpiSummary と同じ出所）
    totalTokens += totalTokensOf(entry);
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
    // トークン合計は totalTokensOf（4 フィールド和）に一本化する（mergeEntries と同じ出所）
    totalTokens += totalTokensOf(b);
    inputTokens += b.inputTokens;
    outputTokens += b.outputTokens;
    cacheReadTokens += b.cacheReadTokens;
    cacheCreationTokens += b.cacheCreationTokens;
  }
  return { totalCost, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

// モデル指定で各エントリを絞り込む。agent フィルタ（filterByAgent）と意図的に非対称:
// モデルフィルタは「対象モデルを含まない期間」もコスト 0 のエントリとして残す
// （積み上げチャートの x 軸ラベルを保ち、ゼロ埋めで期間の欠損を可視化する）。
// filterByAgent は対象エージェントが存在しない期間を落とすため、空状態の表現が
// 「ゼロ埋めチャート」と「行なし」で分かれるのはこの仕様による。
export function filterByModel(entries: PeriodEntry[], model: string | null): PeriodEntry[] {
  if (model === null) { return entries; }
  return entries.map((entry) => {
    const hadAgentDetail = (entry.agents ?? []).length > 0;
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
      // metadata.agents も絞り込み後の agents と揃える。そのままだと agentNamesOf の
      // フォールバックが「選択モデルを使わないエージェント」を復活させ、フィルタの
      // 選択肢（allAgents）とドーナツ・テーブルの表示が乖離する。エージェント内訳が
      // 元々無い期間はモデルとの対応を判定できないため、元の metadata を保持する
      metadata: { agents: hadAgentDetail ? agents.map((a) => a.agent) : (entry.metadata?.agents ?? []) },
    };
  });
}

// エージェント指定で各期間を再構築する。対象エージェントの内訳が無い期間は除外する
// （filterByModel と異なりゼロ埋めしない。空状態は「行なし」で表現する。上記参照）
export function filterByAgent(entries: PeriodEntry[], agent: string | null): PeriodEntry[] {
  if (agent === null) { return entries; }
  return entries.flatMap((entry) => {
    const breakdown = entry.agents?.find((a) => a.agent === agent);
    if (!breakdown) { return []; }
    const filtered: PeriodEntry = {
      period: entry.period,
      totalCost: breakdown.totalCost,
      // 生成するエントリの totalTokens も totalTokensOf で内訳と整合させる
      // （以後の集計はすべて totalTokensOf を使うため、フィールド値を揃えておく）
      totalTokens: totalTokensOf(breakdown),
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

// 月を 2 桁ゼロ埋め文字列にする（YYYY-MM 表記の組み立てで main.ts と重複させない）
export function formatMonth(month: number): string {
  return String(month).padStart(2, "0");
}

export function filterByRange(entries: PeriodEntry[], range: PeriodRange | undefined): PeriodEntry[] {
  const target = range ?? { kind: "all" };
  if (target.kind === "all") { return entries; }
  const prefix =
    target.month === undefined
      ? `${target.year}`
      : `${target.year}-${formatMonth(target.month)}`;
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
  // 未知のモデル（indexOf が -1）は負インデックスの配列アクセス + ?? フォールバックに
  // 依存せず、明示的に先頭の色へフォールバックする
  return index < 0 ? MODEL_PALETTE[0]! : MODEL_PALETTE[index % MODEL_PALETTE.length]!;
}

// キャッシュヒット率 = cacheRead / 全トークン。全トークン 0 のときは 0 を返す
export function hitRate(cacheReadTokens: number, totalTokens: number): number {
  return totalTokens === 0 ? 0 : cacheReadTokens / totalTokens;
}

// 部分 ÷ 全体の構成比（%）を返す。全体 0 は構成比を計算できないため 0 を返す。
// otherBreakdown / buildModelMixSeries / buildModelCostRankingFromAggregate で同じ
// cost / totalCost × 100 式を重複させないための共通ヘルパー
function costRatioOf(part: number, total: number): number {
  return total === 0 ? 0 : (part / total) * 100;
}

// 期間エントリ / エージェント内訳のキャッシュヒット率。どちらもトークン 4 フィールドを持つため、
// 構造的部分型で共用し、クライアント側の再実装をここに 1 点集約する
export function cacheHitRate(entry: {
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
}): number {
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
  return topModelsFromAggregate(aggregateModelsByModel(entries), topN);
}

// モデル別の集計値。top 算出・単価・ランキングが render ごとに同じ breakdown を重複走査しないよう、
// buildDashboardSeriesFromEntries が 1 回だけ計算して各系列へ渡す（モデル別コスト集計の 1 点集約）
interface ModelAggregate {
  cost: number;
  tokens: number;
  cacheRead: number;
}

// 全モデル breakdown を 1 パスで集計する（Map ベース累積で O(n)）。
// topModelsByCost / buildModelCostRanking / buildModelUnitPrices / buildDashboardSeriesFromEntries が共有する
function aggregateModelsByModel(entries: PeriodEntry[]): Map<string, ModelAggregate> {
  const byModel = new Map<string, ModelAggregate>();
  for (const entry of entries) {
    for (const breakdown of entry.modelBreakdowns) {
      const agg = byModel.get(breakdown.modelName) ?? { cost: 0, tokens: 0, cacheRead: 0 };
      agg.cost += breakdown.cost;
      agg.tokens += totalTokensOf(breakdown);
      agg.cacheRead += breakdown.cacheReadTokens;
      byModel.set(breakdown.modelName, agg);
    }
  }
  return byModel;
}

function topModelsFromAggregate(byModel: Map<string, ModelAggregate>, topN: number): string[] {
  return [...byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, topN)
    .map(([modelName]) => modelName);
}

export interface OtherBreakdownItem {
  modelName: string;
  cost: number;
  ratio: number;
}

export interface ModelTokenBreakdownItem {
  modelName: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function modelTokenBreakdown(
  entry: PeriodEntry,
  modelName: string | null,
  top: ReadonlySet<string>,
): ModelTokenBreakdownItem[] {
  return entry.modelBreakdowns
    .filter((breakdown) => modelName === null ? !top.has(breakdown.modelName) : breakdown.modelName === modelName)
    .map((breakdown) => ({
      modelName: breakdown.modelName,
      totalTokens: totalTokensOf(breakdown),
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      cacheReadTokens: breakdown.cacheReadTokens,
      cacheCreationTokens: breakdown.cacheCreationTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function otherBreakdown(entry: PeriodEntry, top: ReadonlySet<string>): OtherBreakdownItem[] {
  return entry.modelBreakdowns
    .filter((b) => !top.has(b.modelName))
    .map((b) => ({
      modelName: b.modelName,
      cost: b.cost,
      ratio: costRatioOf(b.cost, entry.totalCost),
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
  cacheHitRate: number;
  activeModelCount: number;
}

export function buildKpiSummary(entries: PeriodEntry[]): KpiSummary {
  const models = new Set<string>();
  let totalCost = 0;
  let totalTokens = 0;
  let cacheReadTokens = 0;

  for (const entry of entries) {
    totalCost += entry.totalCost;
    // トークン合計は totalTokensOf（4 フィールド和）に一本化する。ccusage の totalTokens
    // フィールド直読みはフィルタ済みエントリ（filterByModel / filterByAgent）で内訳と
    // ずれるため、常に内訳の 4 和から算出して表・KPI・ドーナツの分母を揃える
    totalTokens += totalTokensOf(entry);
    cacheReadTokens += entry.cacheReadTokens;
    for (const breakdown of entry.modelBreakdowns) { models.add(breakdown.modelName); }
  }

  // 全体のキャッシュヒット率もここで計算する（クライアント側の overallCacheHitRate が
  // entries をもう 1 回走査していた分を、KPI 集計の 1 パスに畳み込む）
  return {
    totalCost,
    totalTokens,
    cacheHitRate: hitRate(cacheReadTokens, totalTokens),
    activeModelCount: models.size,
  };
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
      agg.tokens += totalTokensOf(breakdown);
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

// エージェント別のドーナツ用データ。詳細ありは buildAgentEfficiency から派生させる
// （図・表・KPI が同じエージェント集計を参照する単一経路。2 つの並立構造で同じ概念を
// 二重集計しない）。順序も efficiency（コスト降順）に一致するため、ラベルと値の並びは
// ずれない。詳細なし（entry.agents が無い）のときは metadata.agents の名前だけを
// listing として返す（コスト・トークンはすべて 0）。名前は描画に直接使われないが、
// AgentShareData の契約としてフィルタ選択肢（allAgents）とドーナツの表示範囲を
// 揃える情報源になる
export function buildAgentShare(entries: PeriodEntry[], efficiency: AgentEfficiency[] = buildAgentEfficiency(entries)): AgentShareData {
  if (efficiency.length === 0) {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      for (const name of agentNamesOf(entry)) {
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    }
    return {
      agents: names,
      cost: names.map(() => 0),
      tokens: names.map(() => 0),
      costShare: names.map(() => 0),
      tokenShare: names.map(() => 0),
      totalCost: 0,
      totalTokens: 0,
      hasDetail: false,
    };
  }

  // ドーナツの中央値・構成比の分母はエージェント内訳の範囲に限定する。
  // entry.totalCost / entry.totalTokens を分母にすると、エージェントに帰属しない
  // コスト・トークンがある期間でセグメント合計と中央値が乖離するため、
  // セグメントの合計（costTotal / tokenTotal）を分母として返す
  const costTotal = efficiency.reduce((sum, e) => sum + e.cost, 0);
  const tokenTotal = efficiency.reduce((sum, e) => sum + e.tokens, 0);
  return {
    agents: efficiency.map((e) => e.agent),
    cost: efficiency.map((e) => e.cost),
    tokens: efficiency.map((e) => e.tokens),
    costShare: efficiency.map((e) => (costTotal === 0 ? 0 : e.cost / costTotal)),
    tokenShare: efficiency.map((e) => (tokenTotal === 0 ? 0 : e.tokens / tokenTotal)),
    totalCost: costTotal,
    totalTokens: tokenTotal,
    hasDetail: true,
  };
}

export interface DashboardSeries {
  costStacked: ChartSeries;
  tokensStacked: ChartSeries;
  modelMix: ChartSeries;
  unitPrice: ChartSeries;
  unitPrices: ModelUnitPrice[];
  agentShare: AgentShareData;
  cacheHitRate: ChartSeries;
  kpi: KpiSummary;
  costRanking: ModelCostRank[];
  topModels: string[];
  entries: PeriodEntry[];
}

export function buildDashboardSeries(
  data: UsageData,
  filters: DashboardFilters,
  labels: SeriesLabels = DEFAULT_LABELS,
): DashboardSeries {
  return buildDashboardSeriesFromEntries(selectSectionEntries(data, filters.section, filters), labels);
}

// 事前に選択済み entries を受け取り、全系列を組み立てる。
// render 側が selectSectionEntries を二重実行せず、選別結果と集計結果を共有できる。
// モデル別集計（byModel）はここで 1 回だけ行い、top 算出・単価・ランキング・積み上げ系列に
// 共有する（render ごとに breakdown を多重走査しない）
export function buildDashboardSeriesFromEntries(entries: PeriodEntry[], labels: SeriesLabels = DEFAULT_LABELS): DashboardSeries {
  const byModel = aggregateModelsByModel(entries);
  const top = topModelsFromAggregate(byModel, TOP_N);
  const unitPrices = buildModelUnitPricesFromAggregate(byModel);
  const totalCost = entries.reduce((sum, e) => sum + e.totalCost, 0);
  // modelCount（= byModel.size）は積み上げ系列の「その他」判定に渡す。これで各系列ビルダーが
  // distinctModelCount の全 breakdown 再走査をしない（render ごとに 2 回の走査が消える）
  return {
    costStacked: buildModelCostSeries(entries, TOP_N, labels.other, top, byModel.size),
    tokensStacked: buildModelTokenSeries(entries, TOP_N, labels.other, top, byModel.size),
    modelMix: buildModelMixSeries(entries, TOP_N, labels.other, top, byModel.size),
    unitPrice: unitPriceSeries(unitPrices, labels.unitPrice),
    unitPrices,
    agentShare: buildAgentShare(entries),
    cacheHitRate: buildCacheHitRateSeries(entries, labels.cacheHit),
    kpi: buildKpiSummary(entries),
    costRanking: buildModelCostRankingFromAggregate(byModel, totalCost),
    topModels: top,
    entries,
  };
}

// 上位トップNモデル + otherLabel バケットの期間系列を組み立てる共通ヘルパー。
// cost と ratio（構成比）の 2 系統が値の計算式だけ異なるため、valueFor で差し替える。
// top を渡すと top 算出の再走査をスキップでき、modelCount を渡すと distinctModelCount の
// 全 breakdown 再走査をスキップできる（buildDashboardSeriesFromEntries が両方共有する）。
// 値の取り出しは entry.modelBreakdowns の find / filter 再走査（entries × top 倍）ではなく、
// 期間ごとに 1 回だけ構築した Map インデックスから行う
type EntryModelIndex = ReadonlyMap<string, ModelBreakdown>;

function buildTopModelSeries(
  entries: PeriodEntry[],
  otherLabel: string,
  valueFor: (index: EntryModelIndex, entry: PeriodEntry, modelName: string | null, top: ReadonlySet<string>) => number,
  top: string[],
  modelCount: number,
): ChartSeries {
  const labels = entries.map((e) => e.period);
  const topSet = new Set(top);
  const index = entries.map((entry) => {
    const byModel = new Map<string, ModelBreakdown>();
    for (const breakdown of entry.modelBreakdowns) { byModel.set(breakdown.modelName, breakdown); }
    return byModel;
  });
  const datasets = top.map((model) => ({
    label: model,
    data: entries.map((entry, i) => valueFor(index[i]!, entry, model, topSet)),
  }));
  if (top.length < modelCount) {
    datasets.push({
      label: otherLabel,
      data: entries.map((entry, i) => valueFor(index[i]!, entry, null, topSet)),
    });
  }
  return { labels, datasets };
}

export function buildModelCostSeries(
  entries: PeriodEntry[],
  topN: number = TOP_N,
  otherLabel: string = OTHER_LABEL,
  top: string[] = topModelsByCost(entries, topN),
  modelCount: number = distinctModelCount(entries),
): ChartSeries {
  return buildTopModelSeries(entries, otherLabel, (index, _entry, modelName, topSet) => {
    if (modelName === null) {
      return sumNonTopCost(index, topSet);
    }
    return index.get(modelName)?.cost ?? 0;
  }, top, modelCount);
}

export function buildModelTokenSeries(
  entries: PeriodEntry[],
  topN: number = TOP_N,
  otherLabel: string = OTHER_LABEL,
  top: string[] = topModelsByCost(entries, topN),
  modelCount: number = distinctModelCount(entries),
): ChartSeries {
  return buildTopModelSeries(entries, otherLabel, (index, _entry, modelName, topSet) => {
    if (modelName === null) {
      return sumNonTopTokens(index, topSet);
    }
    const breakdown = index.get(modelName);
    return breakdown ? totalTokensOf(breakdown) : 0;
  }, top, modelCount);
}

export function buildModelMixSeries(
  entries: PeriodEntry[],
  topN: number = TOP_N,
  otherLabel: string = OTHER_LABEL,
  top: string[] = topModelsByCost(entries, topN),
  modelCount: number = distinctModelCount(entries),
): ChartSeries {
  return buildTopModelSeries(entries, otherLabel, (index, entry, modelName, topSet) => {
    if (entry.totalCost === 0) { return 0; }
    if (modelName === null) {
      return costRatioOf(sumNonTopCost(index, topSet), entry.totalCost);
    }
    return costRatioOf(index.get(modelName)?.cost ?? 0, entry.totalCost);
  }, top, modelCount);
}

// top 集合に含まれないモデルの cost 合計（「その他」バケットの値）。
// buildModelCostSeries / buildModelMixSeries で同じ走査を重複させないための共通ヘルパー
function sumNonTopCost(index: EntryModelIndex, topSet: ReadonlySet<string>): number {
  let sum = 0;
  for (const breakdown of index.values()) {
    if (!topSet.has(breakdown.modelName)) { sum += breakdown.cost; }
  }
  return sum;
}

function sumNonTopTokens(index: EntryModelIndex, topSet: ReadonlySet<string>): number {
  let sum = 0;
  for (const breakdown of index.values()) {
    if (!topSet.has(breakdown.modelName)) { sum += totalTokensOf(breakdown); }
  }
  return sum;
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
  const totalCost = entries.reduce((sum, e) => sum + e.totalCost, 0);
  return buildModelCostRankingFromAggregate(aggregateModelsByModel(entries), totalCost);
}

function buildModelCostRankingFromAggregate(byModel: Map<string, ModelAggregate>, totalCost: number): ModelCostRank[] {
  return [...byModel.entries()]
    .map(([modelName, agg]) => ({
      modelName,
      cost: agg.cost,
      ratio: costRatioOf(agg.cost, totalCost),
    }))
    .sort((a, b) => b.cost - a.cost);
}

export function buildModelUnitPrices(entries: PeriodEntry[]): ModelUnitPrice[] {
  return buildModelUnitPricesFromAggregate(aggregateModelsByModel(entries));
}

function buildModelUnitPricesFromAggregate(byModel: Map<string, ModelAggregate>): ModelUnitPrice[] {
  return [...byModel.entries()]
    .map(([modelName, agg]) => ({
      modelName,
      unitPrice: effectiveUnitPrice(agg.cost, agg.tokens),
      hitRate: hitRate(agg.cacheRead, agg.tokens),
    }))
    .sort((a, b) => b.unitPrice - a.unitPrice);
}

function unitPriceSeries(prices: ModelUnitPrice[], datasetLabel: string): ChartSeries {
  return {
    labels: prices.map((p) => p.modelName),
    datasets: [{ label: datasetLabel, data: prices.map((p) => p.unitPrice) }],
  };
}

export function buildUnitPriceSeries(entries: PeriodEntry[], datasetLabel: string = DEFAULT_LABELS.unitPrice): ChartSeries {
  // 実効単価の集計は buildModelUnitPrices と共有する（同一ロジックの二重実装を避ける）
  return unitPriceSeries(buildModelUnitPrices(entries), datasetLabel);
}

export function buildCacheHitRateSeries(entries: PeriodEntry[], datasetLabel: string = DEFAULT_LABELS.cacheHit): ChartSeries {
  const labels = entries.map((e) => e.period);
  return {
    labels,
    datasets: [{ label: datasetLabel, data: entries.map((e) => cacheHitRate(e)) }],
  };
}
