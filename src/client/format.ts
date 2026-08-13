// 数値表示の整形ヘルパー。charts.ts / table.ts の両方から使うため分離する。
// 数値表記は言語で変えない（金額 USD 固定・桁区切り共通）ため、i18n に依存しない
export function formatCurrency(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) { return `${(tokens / 1_000_000).toFixed(1)}M`; }
  if (tokens >= 1_000) { return `${(tokens / 1_000).toFixed(1)}K`; }
  return `${Math.round(tokens)}`;
}

export function formatTokensFull(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatAxisCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) { return `$${(value / 1000).toFixed(1)}K`; }
  if (abs >= 1) { return `$${value.toFixed(1)}`; }
  return `$${value.toFixed(2)}`;
}

// 実効単価（$/MTok）の表示。チャートの軸（$K 単位）とは別に、パネルの数値セル用に
// 小数 3 桁まで表示する
export function formatUnitPrice(price: number): string {
  return `$${price.toFixed(3)}`;
}

// 倍率（大きい側 ÷ 小さい側）の表示。100 以上は整数、10 以上は小数 1 桁、未満は小数 2 桁で
// 「×」を付ける。片側 0 由来の Infinity（比の計算不能）は ∞ と表示する
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) { return "∞"; }
  if (ratio >= 100) { return `${Math.round(ratio)}×`; }
  if (ratio >= 10) { return `${ratio.toFixed(1)}×`; }
  return `${ratio.toFixed(2)}×`;
}

// モデル名の表示短縮。charts.ts（テーブル行）と detail-panel.ts（パネル行・比較カード）が
// 共通で使うため format 側に集約する
export function shortModelName(modelName: string): string {
  return modelName.startsWith("claude-") ? modelName.slice("claude-".length) : modelName;
}
