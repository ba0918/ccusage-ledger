import type { AgentBreakdown, PeriodEntry, UsageData } from "../types";
import {
  allAgents,
  allModels,
  buildDashboardSeries,
  modelColor,
  selectSectionEntries,
  type ChartSeries,
  type DashboardFilters,
  type KpiSummary,
} from "../aggregate";

const state: DashboardFilters = { section: "daily", model: null, agent: null, range: "all" };
let usageData: UsageData | null = null;
let donutSeg: "cost" | "token" = "cost";
let lastAgentShare: ReturnType<typeof buildDashboardSeries>["agentShare"] | null = null;

const AGENT_PALETTE = ["#7aa7ff", "#4cd6a0", "#f5b34d", "#c084fc", "#76b7b2", "#e15759"];
const OTHER_COLOR = "#8b92a7";

const charts: Record<string, ChartInstance> = {};

async function loadData(): Promise<void> {
  const res = await fetch("/api/usage");
  if (!res.ok) throw new Error(`/api/usage failed: ${res.status}`);
  usageData = (await res.json()) as UsageData;
}

function el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function fillSelect(id: string, values: string[]): void {
  const select = document.getElementById(id) as HTMLSelectElement;
  select.innerHTML = '<option value="">すべて</option>';
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
}

function collectAllEntries() {
  const sections: ("daily" | "monthly")[] = ["daily", "monthly"];
  return sections.flatMap((section) => usageData?.[section] ?? []);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCurrency(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${Math.round(tokens)}`;
}

function formatTokensFull(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function formatAxisCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  if (abs >= 1) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

function datasetColor(label: string, models: string[]): string {
  return label === "その他" ? OTHER_COLOR : modelColor(label, models);
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

function tooltipLabel(fmt: (value: number, datasetLabel: string) => string): (item: unknown) => string {
  return (item: unknown) => {
    const { parsed, dataset } = item as { parsed: { x?: number; y?: number }; dataset: { label?: string } };
    const value = parsed.y !== undefined ? parsed.y : parsed.x ?? 0;
    return fmt(value, dataset.label ?? "");
  };
}

function createChart(id: string, type: string, data: ChartData, options: ChartOptions = {}): void {
  const canvas = document.getElementById(id) as HTMLCanvasElement;
  charts[id]?.destroy();
  charts[id] = new Chart(canvas, {
    type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      ...options,
    },
  });
}

function overallCacheHitRate(entries: PeriodEntry[]): number {
  let read = 0;
  let total = 0;
  for (const entry of entries) {
    read += entry.cacheReadTokens;
    total += entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheCreationTokens;
  }
  return total === 0 ? 0 : read / total;
}

function cacheHitRateOf(fields: Pick<AgentBreakdown, "cacheReadTokens" | "inputTokens" | "outputTokens" | "cacheCreationTokens">): number {
  const total = fields.inputTokens + fields.outputTokens + fields.cacheReadTokens + fields.cacheCreationTokens;
  return total === 0 ? 0 : fields.cacheReadTokens / total;
}

function countAgents(entries: PeriodEntry[]): number {
  const agents = new Set<string>();
  for (const entry of entries) {
    if (entry.agents && entry.agents.length > 0) {
      for (const agent of entry.agents) agents.add(agent.agent);
    } else {
      for (const name of entry.metadata?.agents ?? []) agents.add(name);
    }
  }
  return agents.size;
}

function renderKpis(kpi: KpiSummary, entries: PeriodEntry[]): void {
  const today = new Date();
  el("kpi-total-cost").textContent = formatCurrency(kpi.totalCost);
  el("kpi-month-cost").textContent = formatCurrency(kpi.currentMonthCost);
  el("kpi-month-sub").textContent = `${today.getFullYear()}年${today.getMonth() + 1}月〜今日`;
  el("kpi-total-tokens").textContent = formatTokens(kpi.totalTokens);
  el("kpi-cache-sub").textContent = `キャッシュヒット率 ${formatPercent(overallCacheHitRate(entries))}`;
  el("kpi-models").textContent = String(kpi.activeModelCount);
  el("kpi-agents-sub").textContent = `${countAgents(entries)} エージェント`;
}

function renderCostStacked(series: ChartSeries, models: string[]): void {
  createChart(
    "chart-cost-stacked",
    "bar",
    colorize(series, (label) => datasetColor(label, models)),
    {
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45 }, title: { display: true, text: "期間" } },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { callback: (value: unknown) => formatAxisCurrency(Number(value)) },
          title: { display: true, text: "コスト (USD)" },
        },
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: tooltipLabel((value, label) => `${label}: ${formatAxisCurrency(value)}`) } },
      },
    },
  );
}

function renderModelMix(series: ChartSeries, models: string[]): void {
  createChart(
    "chart-model-mix",
    "bar",
    colorize(series, (label) => datasetColor(label, models)),
    {
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45 } },
        y: {
          stacked: true,
          min: 0,
          max: 100,
          ticks: { callback: (value: unknown) => `${Math.round(Number(value))}%` },
          title: { display: true, text: "構成比 (%)" },
        },
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: tooltipLabel((value, label) => `${label}: ${Math.round(value)}%`) } },
      },
    },
  );
}

function renderUnitPrice(series: ChartSeries): void {
  createChart(
    "chart-unit-price",
    "bar",
    colorize(series, () => "#7aa7ff"),
    {
      indexAxis: "y",
      scales: {
        x: {
          beginAtZero: true,
          ticks: { callback: (value: unknown) => `$${Number(value)}` },
          title: { display: true, text: "実効単価 (USD/MTok)" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item: unknown) => {
              const { parsed, label } = item as { parsed: { x?: number; y?: number }; label?: string };
              return `${label ?? ""}: $${(parsed.x ?? parsed.y ?? 0).toFixed(2)}/MTok`;
            },
          },
        },
      },
    },
  );
}

function renderCacheHit(series: ChartSeries): void {
  const dataset = series.datasets[0];
  const data: ChartData = {
    labels: series.labels,
    datasets: [
      {
        ...(dataset ?? { label: "キャッシュヒット率", data: [] }),
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
        title: { display: true, text: "キャッシュヒット率 (%)" },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: tooltipLabel((value) => `キャッシュヒット率 ${Math.round(value)}%`) } },
    },
  });
}

function renderAgentDonut(share: ReturnType<typeof buildDashboardSeries>["agentShare"]): void {
  lastAgentShare = share;
  const legend = document.getElementById("agent-legend")!;
  el("donut-value").textContent = "–";
  el("donut-label").textContent = donutSeg === "cost" ? "合計コスト" : "合計トークン";

  if (!share.hasDetail || share.agents.length === 0) {
    charts["chart-agent-donut"]?.destroy();
    delete charts["chart-agent-donut"];
    legend.innerHTML = '<div class="donut-note">エージェント別内訳データがありません</div>';
    return;
  }

  const data = donutSeg === "cost" ? share.cost : share.tokens;
  const colors = share.agents.map((_, index) => AGENT_PALETTE[index % AGENT_PALETTE.length]!);

  createChart(
    "chart-agent-donut",
    "doughnut",
    {
      labels: share.agents,
      datasets: [{ data, backgroundColor: colors, borderColor: "#141824", borderWidth: 2, cutout: "62%" }],
    },
    { plugins: { legend: { display: false } } },
  );

  const total = donutSeg === "cost" ? share.totalCost : share.totalTokens;
  el("donut-value").textContent = donutSeg === "cost" ? formatCurrency(total) : formatTokens(total);
  el("donut-label").textContent = donutSeg === "cost" ? "合計コスト" : "合計トークン";

  legend.innerHTML = share.agents
    .map((agent, index) => {
      const value = donutSeg === "cost" ? share.cost[index] ?? 0 : share.tokens[index] ?? 0;
      const ratio = donutSeg === "cost" ? share.costShare[index] ?? 0 : share.tokenShare[index] ?? 0;
      const formatted = donutSeg === "cost" ? formatCurrency(value) : formatTokens(value);
      return `<div class="row">
        <span class="swatch" style="background:${colors[index] ?? AGENT_PALETTE[0]}"></span>
        <span class="name">${escapeHtml(agent)}</span>
        <span class="val">${formatted}</span>
        <span class="pct">${formatPercent(ratio)}</span>
      </div>`;
    })
    .join("");
}

function agentModelNames(agent: AgentBreakdown): string[] {
  return agent.modelsUsed.length > 0 ? agent.modelsUsed : agent.modelBreakdowns.map((b) => b.modelName);
}

function bindExpand(): void {
  document.querySelectorAll("#table-body .period-row").forEach((row) => {
    const button = row.querySelector<HTMLButtonElement>(".expand-btn");
    if (!button) return;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      row.classList.toggle("open");
      const isOpen = row.classList.contains("open");
      button.setAttribute("aria-expanded", String(isOpen));
      let sibling = row.nextElementSibling;
      while (sibling && sibling.classList.contains("agent-row")) {
        sibling.classList.toggle("hidden");
        sibling = sibling.nextElementSibling;
      }
    });
  });
}

function renderTable(entries: PeriodEntry[]): void {
  const tbody = document.getElementById("table-body")!;
  el("table-count").textContent = `期間 ${entries.length}件`;

  if (entries.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">表示期間のデータがありません</td></tr>';
    return;
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let totalCacheRead = 0;
  let totalTokenFields = 0;

  const rows: string[] = [];
  entries.forEach((entry, periodIndex) => {
    const isFirstOpen = periodIndex === 0;
    const agents = entry.agents ?? [];
    const hasDetail = agents.length > 0;
    totalInput += entry.inputTokens;
    totalOutput += entry.outputTokens;
    totalCost += entry.totalCost;
    totalCacheRead += entry.cacheReadTokens;
    totalTokenFields += entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheCreationTokens;

    rows.push(`<tr class="period-row${isFirstOpen ? " open" : ""}">
        <td>${hasDetail
          ? `<button type="button" class="expand-btn" aria-expanded="${isFirstOpen ? "true" : "false"}"><span class="caret">▶</span></button>`
          : ""}${escapeHtml(entry.period)}</td>
        <td>All</td>
        <td class="models"></td>
        <td class="num">${formatTokensFull(entry.inputTokens)}</td>
        <td class="num">${formatTokensFull(entry.outputTokens)}</td>
        <td class="num">${formatPercent(cacheHitRateOf(entry))}</td>
        <td class="num">${formatCurrency(entry.totalCost)}</td>
      </tr>`);

    agents.forEach((agent, index) => {
      const isLast = index === agents.length - 1;
      const collapsed = isFirstOpen ? "" : " hidden";
      rows.push(`<tr class="agent-row${isLast ? " last" : ""}${collapsed}">
        <td></td>
        <td class="a-label">${escapeHtml(agent.agent)}</td>
        <td class="models">${agentModelNames(agent).map((model) => `<b>${escapeHtml(model)}</b>`).join(" · ")}</td>
        <td class="num">${formatTokensFull(agent.inputTokens)}</td>
        <td class="num">${formatTokensFull(agent.outputTokens)}</td>
        <td class="num">${formatPercent(cacheHitRateOf(agent))}</td>
        <td class="num">${formatCurrency(agent.totalCost)}</td>
      </tr>`);
    });
  });

  rows.push(`<tr class="total-row">
      <td>合計</td>
      <td></td>
      <td></td>
      <td class="num">${formatTokensFull(totalInput)}</td>
      <td class="num">${formatTokensFull(totalOutput)}</td>
      <td class="num">${formatPercent(totalTokenFields === 0 ? 0 : totalCacheRead / totalTokenFields)}</td>
      <td class="num">${formatCurrency(totalCost)}</td>
    </tr>`);

  tbody.innerHTML = rows.join("");
  bindExpand();
}

function render(): void {
  if (!usageData) return;

  const series = buildDashboardSeries(usageData, state);
  const entries = selectSectionEntries(usageData, state.section, state);
  const models = allModels(collectAllEntries());

  renderKpis(series.kpi, entries);
  renderCostStacked(series.costStacked, models);
  renderModelMix(series.modelMix, models);
  renderUnitPrice(series.unitPrice);
  renderAgentDonut(series.agentShare);
  renderCacheHit(series.cacheHitRate);
  renderTable(entries);
}

function bindControls(): void {
  const section = document.getElementById("section") as HTMLSelectElement;
  const model = document.getElementById("model") as HTMLSelectElement;
  const agent = document.getElementById("agent") as HTMLSelectElement;
  const range = document.getElementById("range") as HTMLSelectElement;

  section.addEventListener("change", () => {
    state.section = section.value as DashboardFilters["section"];
    render();
  });
  model.addEventListener("change", () => {
    state.model = model.value === "" ? null : model.value;
    render();
  });
  agent.addEventListener("change", () => {
    state.agent = agent.value === "" ? null : agent.value;
    render();
  });
  range.addEventListener("change", () => {
    state.range = range.value as DashboardFilters["range"];
    render();
  });

  document.querySelectorAll(".seg-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-toggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      donutSeg = (btn as HTMLElement).dataset.seg === "token" ? "token" : "cost";
      if (lastAgentShare) renderAgentDonut(lastAgentShare);
    });
  });
}

function setStatus(message: string, isError = false): void {
  const status = document.getElementById("status") as HTMLSpanElement;
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function main(): Promise<void> {
  setStatus("読み込み中...");
  try {
    await loadData();
    const entries = collectAllEntries();
    fillSelect("model", allModels(entries));
    fillSelect("agent", allAgents(entries));
    bindControls();
    if (entries.length === 0) {
      setStatus("データがありません");
      return;
    }
    render();
    setStatus("読み込み完了");
  } catch (error) {
    setStatus(`データ取得エラー: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

void main();
