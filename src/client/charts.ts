// チャート・モデル別テーブル（単価 / コストランキング）・KPI・ドーナツの描画。
// main.ts から state（フィルタ・言語）を引数で受け取り、DOM 更新のみを担当する。
// render* 群を main.ts のモノリスから分離して関心の境界を明確にする
import type {
  AgentEfficiency,
  AgentShareData,
  ChartSeries,
  KpiSummary,
  ModelCostRank,
  ModelUnitPrice,
  OtherBreakdownItem,
} from "../aggregate";
import { agentDonutData, allAgents, maxFinite, modelColor, otherBreakdown } from "../aggregate";
import type { PeriodEntry } from "../types";
import { el } from "./dom";
import { htmlAttr, htmlText } from "./escape";
import { formatAxisCurrency, formatCurrency, formatPercent, formatTokens } from "./format";
import { t } from "./i18n";

export type TooltipContext = { entries: PeriodEntry[]; top: ReadonlySet<string>; excludeZero?: boolean };

const AGENT_PALETTE = ["#7aa7ff", "#4cd6a0", "#f5b34d", "#c084fc", "#76b7b2", "#e15759"];
const OTHER_COLOR = "#8b92a7";

// チャートは id ごとに 1 インスタンスを保持する。フィルタ変更のたびに destroy → 再生成するのは
// 無駄なので data / options を差し替えて update する。チャート種別は id ごとに固定
// （donut の非表示時は renderAgentDonut 側で destroy + delete される）
const charts: Record<string, ChartInstance> = {};

function createChart(id: string, type: string, data: ChartData, options: ChartOptions = {}): void {
  const canvas = document.getElementById(id) as HTMLCanvasElement;
  const fullOptions: ChartOptions = { responsive: true, maintainAspectRatio: false, ...options };
  const existing = charts[id];
  if (existing) {
    existing.data = data;
    existing.options = fullOptions;
    existing.update();
    return;
  }
  charts[id] = new Chart(canvas, { type, data, options: fullOptions });
}

function datasetColor(label: string, models: string[]): string {
  return label === t("other") ? OTHER_COLOR : modelColor(label, models);
}

function colorize(series: ChartSeries, colorFor: (label: string) => string, fill: boolean | "origin" = false): ChartData {
  return {
    labels: series.labels,
    datasets: series.datasets.map((dataset) => ({
      ...dataset,
      fill,
      backgroundColor: colorFor(dataset.label),
      borderColor: colorFor(dataset.label),
    })),
  };
}

function tooltipLabel(
  fmt: (value: number, datasetLabel: string) => string,
  opts?: { entries?: PeriodEntry[]; top?: ReadonlySet<string>; inner?: (item: OtherBreakdownItem) => string; excludeZero?: boolean },
): (item: unknown) => string | string[] {
  return (item: unknown) => {
    const { parsed, dataset, dataIndex } = item as {
      parsed: { x?: number; y?: number };
      dataset: { label?: string };
      dataIndex: number;
    };
    const value = parsed.y !== undefined ? parsed.y : parsed.x ?? 0;
    if (opts?.excludeZero && value === 0) { return ""; }
    const lines: string[] = [fmt(value, dataset.label ?? "")];
    if (dataset.label === t("other") && opts?.entries && opts.top) {
      const entry = opts.entries[dataIndex];
      if (entry) {
        const inner = opts.inner ?? ((item: OtherBreakdownItem) => `${item.modelName}: ${Math.round(item.ratio)}%`);
        for (const item of otherBreakdown(entry, opts.top)) {
          lines.push(`  ${inner(item)}`);
        }
      }
    }
    return lines;
  };
}

function countAgents(entries: PeriodEntry[]): number {
  return allAgents(entries).length;
}

export function renderKpis(kpi: KpiSummary, entries: PeriodEntry[], rangeDesc: string): void {
  el("kpi-total-cost").textContent = formatCurrency(kpi.totalCost);
  el("kpi-total-sub").textContent = rangeDesc;
  el("kpi-cache-rate").textContent = formatPercent(kpi.cacheHitRate);
  el("kpi-total-tokens").textContent = formatTokens(kpi.totalTokens);
  el("kpi-models").textContent = String(kpi.activeModelCount);
  el("kpi-agents-sub").textContent = t("agentCount", { count: countAgents(entries) });
}

interface StackedBarSpec {
  id: string;
  series: ChartSeries;
  models: string[];
  tooltipCtx?: TooltipContext;
  xTitle?: string;
  yMin?: number;
  yMax?: number;
  yTick: (value: number) => string;
  yTitle: string;
  tooltip: (value: number, datasetLabel: string) => string;
  tooltipInner?: (item: OtherBreakdownItem) => string;
}

// 積み上げ棒チャート（コスト / モデル構成比）の共通描画。2 系統は x 軸タイトル・
// y 軸の範囲と書式・tooltip の書式だけが異なるため、spec で差し替える
// （renderCostStacked / renderModelMix の ~40 行の重複を 1 箇所に集約する）
function renderStackedBar(spec: StackedBarSpec): void {
  const yScale: Record<string, unknown> = {
    stacked: true,
    ticks: { callback: (value: unknown) => spec.yTick(Number(value)) },
    title: { display: true, text: spec.yTitle },
  };
  if (spec.yMin === undefined && spec.yMax === undefined) {
    yScale.beginAtZero = true;
  } else {
    if (spec.yMin !== undefined) { yScale.min = spec.yMin; }
    if (spec.yMax !== undefined) { yScale.max = spec.yMax; }
  }
  const xScale: Record<string, unknown> = { stacked: true, ticks: { maxRotation: 45 } };
  if (spec.xTitle !== undefined) {
    xScale.title = { display: true, text: spec.xTitle };
  }

  createChart(
    spec.id,
    "bar",
    colorize(spec.series, (label) => datasetColor(label, spec.models)),
    {
      interaction: { mode: "index", intersect: false },
      scales: { x: xScale, y: yScale },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: tooltipLabel(spec.tooltip, { ...spec.tooltipCtx, inner: spec.tooltipInner }),
          },
        },
      },
    },
  );
}

export function renderCostStacked(series: ChartSeries, models: string[], tooltipCtx?: TooltipContext): void {
  renderStackedBar({
    id: "chart-cost-stacked",
    series,
    models,
    tooltipCtx,
    xTitle: t("period"),
    yTick: (value) => formatAxisCurrency(value),
    yTitle: t("costUsd"),
    tooltip: (value, label) => `${label}: ${formatAxisCurrency(value)}`,
    tooltipInner: (item) => `${item.modelName}: ${formatAxisCurrency(item.cost)}`,
  });
}

export function renderModelMix(series: ChartSeries, models: string[], tooltipCtx?: TooltipContext): void {
  renderStackedBar({
    id: "chart-model-mix",
    series,
    models,
    tooltipCtx,
    yMin: 0,
    yMax: 100,
    yTick: (value) => `${Math.round(value)}%`,
    yTitle: t("ratioPercent"),
    tooltip: (value, label) => `${label}: ${Math.round(value)}%`,
  });
}

function shortModelName(modelName: string): string {
  return modelName.startsWith("claude-") ? modelName.slice("claude-".length) : modelName;
}

// キャッシュヒット率の良し悪しを表す色のしきい値（単価バーの色）。上位（>=0.95）は緑、
// 下位は赤になる。しきい値は実運用上の目安（キャッシュが効いていると 0.85 超が続く想定）
// で、名前付き定数として判定ロジックをテスト可能にする
const HIT_RATE_TIERS: ReadonlyArray<{ min: number; color: string }> = [
  { min: 0.95, color: "#34d399" },
  { min: 0.85, color: "#a3e635" },
  { min: 0.75, color: "#fbbf24" },
  { min: 0.65, color: "#fb923c" },
  { min: 0, color: "#f87171" },
];

function hitRateColor(rate: number): string {
  // 最後の tier（min: 0）が必ずマッチするため find は常に成功する
  return HIT_RATE_TIERS.find((tier) => rate >= tier.min)!.color;
}

// 「モデル名 + 横棒 + 数値セル」の行を組み立てる（renderUnitPrice / renderCostRanking で共通）。
// データ由来の文字列（modelName）は必ず htmlAttr / htmlText を通す（stored XSS 防止の choke point）
function modelBarRow(modelName: string, barWidth: number, barColor: string, cells: string[]): string {
  return `<tr>
    <td class="model" title="${htmlAttr(modelName)}">${htmlText(shortModelName(modelName))}</td>
    <td class="bar-cell"><div class="bar" style="width:${barWidth}%;background:${barColor}"></div></td>
    ${cells.map((cell) => `<td class="num">${cell}</td>`).join("")}
  </tr>`;
}

export function renderUnitPrice(prices: ModelUnitPrice[]): void {
  const maxPrice = maxFinite(prices.map((p) => p.unitPrice), 1);
  const tbody = document.getElementById("unit-price-body") as HTMLElement;
  tbody.innerHTML = prices
    .map((p) => {
      const width = Math.max((p.unitPrice / maxPrice) * 100, 1);
      return modelBarRow(p.modelName, width, hitRateColor(p.hitRate), [formatPercent(p.hitRate), formatCurrency(p.unitPrice)]);
    })
    .join("");
}

export function renderCacheHit(series: ChartSeries): void {
  const dataset = series.datasets[0];
  const data: ChartData = {
    labels: series.labels,
    datasets: [
      {
        ...(dataset ?? { label: t("cacheHitRate"), data: [] }),
        fill: "origin",
        backgroundColor: "#4cd6a0",
        borderColor: "#4cd6a0",
        data: (dataset?.data ?? []).map((value) => (value ?? 0) * 100),
      },
    ],
  };
  createChart("chart-cache-hit", "line", data, {
    scales: {
      x: { ticks: { maxRotation: 45 } },
      y: {
        min: 0,
        max: 100,
        ticks: { callback: (value: unknown) => `${Math.round(Number(value))}%` },
        title: { display: true, text: t("cacheHitRatePercent") },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: tooltipLabel((value) => t("cacheHitTooltip", { value: Math.round(value) })) } },
    },
  });
}

export function renderCostRanking(ranking: ModelCostRank[], models: string[]): void {
  const maxCost = maxFinite(ranking.map((r) => r.cost), 1);
  const tbody = document.getElementById("cost-ranking-body") as HTMLElement;
  tbody.innerHTML = ranking
    .map((r) => {
      const width = Math.max((r.cost / maxCost) * 100, 1);
      return modelBarRow(r.modelName, width, datasetColor(r.modelName, models), [formatCurrency(r.cost), `${Math.round(r.ratio)}%`]);
    })
    .join("");
}

function segValue(cost: number, tokens: number, seg: "cost" | "token"): number {
  return seg === "cost" ? cost : tokens;
}

function formatSegValue(value: number, seg: "cost" | "token"): string {
  return seg === "cost" ? formatCurrency(value) : formatTokens(value);
}

export function renderAgentDonut(share: AgentShareData, efficiency: AgentEfficiency[], seg: "cost" | "token"): void {
  const effBody = document.getElementById("agent-efficiency-body")!;
  const segLabel = seg === "cost" ? t("totalCost") : t("totalTokens");
  el("donut-value").textContent = "–";
  el("donut-label").textContent = segLabel;

  if (!share.hasDetail || share.agents.length === 0) {
    charts["chart-agent-donut"]?.destroy();
    delete charts["chart-agent-donut"];
    effBody.innerHTML = `<tr><td colspan="5" class="donut-note">${htmlText(t("noAgentDetail"))}</td></tr>`;
    return;
  }

  // 図・中央値・表は同じ値（cost または tokens）を参照する。buildAgentShare は
  // buildAgentEfficiency から派生し、ラベル・値とも efficiency（コスト降順）と同順序のため、
  // 図のデータもここでは efficiency を直接使う（share.cost/tokens と順序がずれる経路は無い）
  const data = agentDonutData(efficiency, seg);
  const colors = efficiency.map((_, index) => AGENT_PALETTE[index % AGENT_PALETTE.length]!);

  createChart(
    "chart-agent-donut",
    "doughnut",
    {
      labels: efficiency.map((e) => e.agent),
      datasets: [{ data, backgroundColor: colors, borderColor: "#141824", borderWidth: 2, cutout: "62%" }],
    },
    { plugins: { legend: { display: false } } },
  );

  const total = segValue(share.totalCost, share.totalTokens, seg);
  el("donut-value").textContent = formatSegValue(total, seg);

  effBody.innerHTML = efficiency
    .map((e, index) => {
      const value = segValue(e.cost, e.tokens, seg);
      const formatted = formatSegValue(value, seg);
      const ratio = total === 0 ? 0 : value / total;
      return `<tr>
        <td><span class="a-name"><span class="swatch" style="background:${colors[index] ?? AGENT_PALETTE[0]}"></span>${htmlText(e.agent)}</span></td>
        <td class="num">${formatted} <span style="color:var(--muted);font-size:11px">${formatPercent(ratio)}</span></td>
        <td class="num">${formatTokens(e.tokens)}</td>
        <td class="num">${formatCurrency(e.unitPrice)}</td>
        <td class="num">${formatPercent(e.hitRate)}</td>
      </tr>`;
    })
    .join("");
}
