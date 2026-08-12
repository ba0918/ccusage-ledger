export interface ModelBreakdown {
  modelName: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AgentBreakdown {
  agent: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

export interface PeriodEntry {
  period: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
  metadata?: { agents?: string[] };
  agents?: AgentBreakdown[];
  // device は将来の複数デバイス対応のための予約フィールド。検証（usage-data.ts）と集計
  // （buildYearly のマージ）には存在するが、projectUsageData が投影から落とすため配信・描画では
  // 常に undefined になる。描画する場合は projection へ追加することを忘れない
  device?: string;
}

export interface Totals {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface UsageData {
  daily?: PeriodEntry[];
  monthly?: PeriodEntry[];
  // weekly / totals / device は型・検証・投影・集計の 4 層で「存在するが常に空」の契約を維持している。
  // 将来の週次表示・合計パネル・複数デバイス対応のために残すが、SECTIONS（daily/monthly）と
  // projectUsageData の白リスト投影が通さないため、配信・描画では常に undefined になる。
  // 有効化手順: ① usage-data.ts の SECTIONS と検証 ② projectUsageData の投影 ③ 集計・描画
  weekly?: PeriodEntry[];
  totals?: Totals;
  device?: string;
}
