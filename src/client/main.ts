import type { AgentBreakdown, PeriodEntry, UsageData } from "../types";
import { loadUsageData } from "./load-data";
import { escapeHtml } from "./escape";
import {
  allAgents,
  allModels,
  buildAgentEfficiency,
  buildDashboardSeries,
  buildModelCostRanking,
  buildModelUnitPrices,
  maxFinite,
  modelColor,
  otherBreakdown,
  selectSectionEntries,
  sliceLatest,
  topModelsByCost,
  TOP_N,
  type AgentEfficiency,
  type ChartSeries,
  type DashboardFilters,
  type KpiSummary,
  type ModelCostRank,
  type ModelUnitPrice,
  type OtherBreakdownItem,
} from "../aggregate";

type TooltipContext = { entries: PeriodEntry[]; top: ReadonlySet<string>; excludeZero?: boolean };

const state: DashboardFilters = { section: "daily", model: null, agent: null, range: { kind: "all" } };
let usageData: UsageData | null = null;
let navYear = 0;
let navMonth = 1;
let viewingAll = true;
let donutSeg: "cost" | "token" = "cost";
let lastAgentShare: ReturnType<typeof buildDashboardSeries>["agentShare"] | null = null;
let lastAgentEfficiency: AgentEfficiency[] = [];

const AGENT_PALETTE = ["#7aa7ff", "#4cd6a0", "#f5b34d", "#c084fc", "#76b7b2", "#e15759"];
const OTHER_COLOR = "#8b92a7";

const charts: Record<string, ChartInstance> = {};

async function loadData(): Promise<void> {
  usageData = await loadUsageData(
    (window as Window & { CCUSAGE_DATA?: unknown }).CCUSAGE_DATA,
    async () => {
      const res = await fetch("/api/usage");
      if (!res.ok) throw new Error(`/api/usage failed: ${res.status}`);
      return (await res.json()) as unknown;
    },
  );
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
    if (opts?.excludeZero && value === 0) return "";
    const lines: string[] = [fmt(value, dataset.label ?? "")];
    if (dataset.label === "その他" && opts?.entries && opts.top) {
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

function currentMonthAnchor(): void {
  const now = new Date();
  navYear = now.getFullYear();
  navMonth = now.getMonth() + 1;
}

function navLabel(): string {
  if (state.section === "yearly") return `${navYear}`;
  return `${navYear}/${String(navMonth).padStart(2, "0")}`;
}

function stepNav(direction: 1 | -1): void {
  if (state.section === "yearly") {
    navYear += direction;
  } else {
    navMonth += direction;
    if (navMonth < 1) {
      navMonth = 12;
      navYear -= 1;
    } else if (navMonth > 12) {
      navMonth = 1;
      navYear += 1;
    }
  }
}

function applyNavRange(): void {
  state.range = viewingAll
    ? { kind: "all" }
    : state.section === "yearly"
      ? { kind: "fixed", year: navYear }
      : { kind: "fixed", year: navYear, month: navMonth };
}

function renderNav(): void {
  const label = el("nav-label");
  const contextBar = el("context-bar");
  const contextText = el("context-bar-text");
  const allBtn = el("nav-all");
  if (viewingAll) {
    label.textContent = "全期間";
    contextBar.style.display = "none";
    allBtn.classList.add("active");
  } else {
    const text = navLabel();
    label.textContent = text;
    contextText.textContent = text;
    contextBar.style.display = "";
    allBtn.classList.remove("active");
  }
}

function rangeDescription(): string {
  const range = state.range;
  if (range.kind === "all") return "全期間の累計";
  return range.month !== undefined
    ? `${range.year}/${String(range.month).padStart(2, "0")} の合計`
    : `${range.year} の合計`;
}

function renderKpis(kpi: KpiSummary, entries: PeriodEntry[]): void {
  el("kpi-total-cost").textContent = formatCurrency(kpi.totalCost);
  el("kpi-total-sub").textContent = rangeDescription();
  el("kpi-cache-rate").textContent = formatPercent(overallCacheHitRate(entries));
  el("kpi-total-tokens").textContent = formatTokens(kpi.totalTokens);
  el("kpi-models").textContent = String(kpi.activeModelCount);
  el("kpi-agents-sub").textContent = `${countAgents(entries)} エージェント`;
}

function renderCostStacked(series: ChartSeries, models: string[], tooltipCtx?: TooltipContext): void {
  createChart(
    "chart-cost-stacked",
    "bar",
    colorize(series, (label) => datasetColor(label, models)),
    {
      interaction: { mode: "index", intersect: false },
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
        tooltip: {
          callbacks: {
            label: tooltipLabel(
              (value, label) => `${label}: ${formatAxisCurrency(value)}`,
              { ...tooltipCtx, inner: (item) => `${item.modelName}: ${formatAxisCurrency(item.cost)}` },
            ),
          },
        },
      },
    },
  );
}

function renderModelMix(series: ChartSeries, models: string[], tooltipCtx?: TooltipContext): void {
  createChart(
    "chart-model-mix",
    "bar",
    colorize(series, (label) => datasetColor(label, models)),
    {
      interaction: { mode: "index", intersect: false },
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
        tooltip: {
          callbacks: {
            label: tooltipLabel((value, label) => `${label}: ${Math.round(value)}%`, tooltipCtx),
          },
        },
      },
    },
  );
}

function shortModelName(modelName: string): string {
  return modelName.startsWith("claude-") ? modelName.slice("claude-".length) : modelName;
}

function hitRateColor(hitRate: number): string {
  if (hitRate >= 0.95) return "#34d399";
  if (hitRate >= 0.85) return "#a3e635";
  if (hitRate >= 0.75) return "#fbbf24";
  if (hitRate >= 0.65) return "#fb923c";
  return "#f87171";
}

function renderUnitPrice(prices: ModelUnitPrice[]): void {
  const maxPrice = maxFinite(prices.map((p) => p.unitPrice), 1);
  const tbody = document.getElementById("unit-price-body") as HTMLElement;
  tbody.innerHTML = prices
    .map((p) => {
      const width = Math.max((p.unitPrice / maxPrice) * 100, 1);
      return `<tr>
        <td class="model" title="${escapeHtml(p.modelName)}">${escapeHtml(shortModelName(p.modelName))}</td>
        <td class="bar-cell"><div class="bar" style="width:${width}%;background:${hitRateColor(p.hitRate)}"></div></td>
        <td class="num">${Math.round(p.hitRate * 100)}%</td>
        <td class="num">$${p.unitPrice.toFixed(2)}</td>
      </tr>`;
    })
    .join("");
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

function renderCostRanking(ranking: ModelCostRank[], models: string[]): void {
  const maxCost = maxFinite(ranking.map((r) => r.cost), 1);
  const tbody = document.getElementById("cost-ranking-body") as HTMLElement;
  tbody.innerHTML = ranking
    .map((r) => {
      const width = Math.max((r.cost / maxCost) * 100, 1);
      return `<tr>
        <td class="model" title="${escapeHtml(r.modelName)}">${escapeHtml(shortModelName(r.modelName))}</td>
        <td class="bar-cell"><div class="bar" style="width:${width}%;background:${datasetColor(r.modelName, models)}"></div></td>
        <td class="num">${formatCurrency(r.cost)}</td>
        <td class="num">${Math.round(r.ratio)}%</td>
      </tr>`;
    })
    .join("");
}

function renderAgentDonut(share: ReturnType<typeof buildDashboardSeries>["agentShare"], efficiency: AgentEfficiency[]): void {
  lastAgentShare = share;
  lastAgentEfficiency = efficiency;
  const effBody = document.getElementById("agent-efficiency-body")!;
  el("donut-value").textContent = "–";
  el("donut-label").textContent = donutSeg === "cost" ? "合計コスト" : "合計トークン";

  if (!share.hasDetail || share.agents.length === 0) {
    charts["chart-agent-donut"]?.destroy();
    delete charts["chart-agent-donut"];
    effBody.innerHTML = '<tr><td colspan="5" class="donut-note">エージェント別内訳データがありません</td></tr>';
    return;
  }

  const data = donutSeg === "cost" ? share.cost : share.tokens;
  const colors = efficiency.map((_, index) => AGENT_PALETTE[index % AGENT_PALETTE.length]!);

  createChart(
    "chart-agent-donut",
    "doughnut",
    {
      labels: efficiency.map((e) => e.agent),
      datasets: [{ data: efficiency.map((e) => e.cost), backgroundColor: colors, borderColor: "#141824", borderWidth: 2, cutout: "62%" }],
    },
    { plugins: { legend: { display: false } } },
  );

  const total = donutSeg === "cost" ? share.totalCost : share.totalTokens;
  el("donut-value").textContent = donutSeg === "cost" ? formatCurrency(total) : formatTokens(total);
  el("donut-label").textContent = donutSeg === "cost" ? "合計コスト" : "合計トークン";

  effBody.innerHTML = efficiency
    .map((e, index) => {
      const value = donutSeg === "cost" ? e.cost : e.tokens;
      const formatted = donutSeg === "cost" ? formatCurrency(value) : formatTokens(value);
      const ratio = donutSeg === "cost" ? (share.totalCost === 0 ? 0 : e.cost / share.totalCost) : (share.totalTokens === 0 ? 0 : e.tokens / share.totalTokens);
      return `<tr>
        <td><span class="a-name"><span class="swatch" style="background:${colors[index] ?? AGENT_PALETTE[0]}"></span>${escapeHtml(e.agent)}</span></td>
        <td class="num">${formatted} <span style="color:var(--muted);font-size:11px">${formatPercent(ratio)}</span></td>
        <td class="num">${formatTokens(e.tokens)}</td>
        <td class="num">$${e.unitPrice.toFixed(2)}</td>
        <td class="num">${Math.round(e.hitRate * 100)}%</td>
      </tr>`;
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

const MAX_TABLE_ROWS = 1000;

function renderTable(entries: PeriodEntry[]): void {
  const tbody = document.getElementById("table-body")!;

  if (entries.length === 0) {
    el("table-count").textContent = "期間 0件";
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">表示期間のデータがありません</td></tr>';
    return;
  }

  // 集計は全件で行い、表示だけ最新 MAX_TABLE_ROWS 件にキャップする（巨大データで DOM を固めない）
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let totalCacheRead = 0;
  let totalTokenFields = 0;

  for (const entry of entries) {
    totalInput += entry.inputTokens;
    totalOutput += entry.outputTokens;
    totalCost += entry.totalCost;
    totalCacheRead += entry.cacheReadTokens;
    totalTokenFields += entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheCreationTokens;
  }

  const visible = sliceLatest(entries, MAX_TABLE_ROWS);
  el("table-count").textContent =
    entries.length > MAX_TABLE_ROWS ? `期間 ${entries.length}件（表示 ${visible.length}件）` : `期間 ${entries.length}件`;

  const orderedEntries = [...visible].reverse();
  const rows: string[] = [];
  orderedEntries.forEach((entry, periodIndex) => {
    const isFirstOpen = periodIndex === 0;
    const agents = entry.agents ?? [];
    const hasDetail = agents.length > 0;

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

  applyNavRange();
  renderNav();

  const series = buildDashboardSeries(usageData, state);
  const entries = selectSectionEntries(usageData, state.section, state);
  const models = allModels(collectAllEntries());
  const top = new Set(topModelsByCost(entries, TOP_N));
  const tooltipCtx: TooltipContext = { entries, top, excludeZero: true };

  renderKpis(series.kpi, entries);
  renderCostStacked(series.costStacked, models, tooltipCtx);
  renderModelMix(series.modelMix, models, tooltipCtx);
  renderUnitPrice(buildModelUnitPrices(entries));
  renderAgentDonut(series.agentShare, buildAgentEfficiency(entries));
  renderCostRanking(buildModelCostRanking(entries), models);
  renderCacheHit(series.cacheHitRate);
  renderTable(entries);
}

function bindControls(): void {
  const section = document.getElementById("section") as HTMLSelectElement;
  const model = document.getElementById("model") as HTMLSelectElement;
  const agent = document.getElementById("agent") as HTMLSelectElement;
  const navPrev = document.getElementById("nav-prev") as HTMLButtonElement;
  const navNext = document.getElementById("nav-next") as HTMLButtonElement;
  const navAll = document.getElementById("nav-all") as HTMLButtonElement;

  section.addEventListener("change", () => {
    state.section = section.value as DashboardFilters["section"];
    viewingAll = true;
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
  navPrev.addEventListener("click", () => {
    if (viewingAll) {
      currentMonthAnchor();
      viewingAll = false;
    } else {
      stepNav(-1);
    }
    render();
  });
  navNext.addEventListener("click", () => {
    if (viewingAll) {
      currentMonthAnchor();
      viewingAll = false;
    } else {
      stepNav(1);
    }
    render();
  });
  navAll.addEventListener("click", () => {
    viewingAll = true;
    render();
  });

  document.querySelectorAll(".seg-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-toggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      donutSeg = (btn as HTMLElement).dataset.seg === "token" ? "token" : "cost";
      if (lastAgentShare) renderAgentDonut(lastAgentShare, lastAgentEfficiency);
    });
  });
}

function setStatus(message: string, isError = false): void {
  const status = document.getElementById("status") as HTMLSpanElement;
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function main(): Promise<void> {
  setStatus("");
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
  } catch (error) {
    setStatus(`データ取得エラー: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

void main();
