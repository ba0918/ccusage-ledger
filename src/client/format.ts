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
