import type { AgentBreakdown, PeriodEntry, UsageData } from "../types";
import { loadUsageData } from "./load-data";
import { htmlAttr, htmlText } from "./escape";
import { applyStaticTranslations, createSafeStorage, getLang, setLang, t, type Lang } from "./i18n";
import {
  agentDonutData,
  allAgents,
  allModels,
  buildAgentEfficiency,
  buildDashboardSeriesFromEntries,
  buildModelCostRanking,
  hitRate,
  maxFinite,
  modelColor,
  otherBreakdown,
  selectSectionEntries,
  sliceLatest,
  topModelsByCost,
  totalTokensOf,
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
// データ 0 状態では render() を走らせず「データがありません」の簡潔表示を維持するためのフラグ
let hasData = false;
let navYear = 0;
let navMonth = 1;
let viewingAll = true;
let donutSeg: "cost" | "token" = "cost";
let lastAgentShare: ReturnType<typeof buildDashboardSeriesFromEntries>["agentShare"] | null = null;
let lastAgentEfficiency: AgentEfficiency[] = [];

const AGENT_PALETTE = ["#7aa7ff", "#4cd6a0", "#f5b34d", "#c084fc", "#76b7b2", "#e15759"];
const OTHER_COLOR = "#8b92a7";

// localStorage が使えない環境（プライバシーモード等で SecurityError）でも初期化を死なせない。
// プロパティアクセス自体が throw するため、遅延評価の getRaw を createSafeStorage に渡す
const storage = createSafeStorage(() => window.localStorage);

const charts: Record<string, ChartInstance> = {};

async function loadData(): Promise<void> {
  usageData = await loadUsageData(
    (window as Window & { CCUSAGE_DATA?: unknown }).CCUSAGE_DATA,
    async () => {
      const res = await fetch("/api/usage");
      if (!res.ok) { throw new Error(`/api/usage failed: ${res.status}`); }
      return (await res.json()) as unknown;
    },
  );
}

function el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

// index.html と main.ts の ID 契約を検証する。ID がずれると el() は null に非 null キャストして
// 静かに runtime 例外になるため、main() 冒頭で欠落を早期検出する
function assertElements(ids: readonly string[]): void {
  const missing = ids.filter((id) => document.getElementById(id) === null);
  if (missing.length > 0) {
    throw new Error(t("missingElements", { ids: missing.join(", ") }));
  }
}

function fillSelect(id: string, values: string[], selected: string | null = null): void {
  const select = document.getElementById(id) as HTMLSelectElement;
  select.innerHTML = `<option value="">${t("all")}</option>`;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  // innerHTML 再構築で選択が消えるため、呼び出し元が渡した選択値を復元する。
  // 言語切替時は state.model / state.agent を渡し、select の表示と実データの絞り込みを一致させる
  select.value = selected ?? "";
}

function collectAllEntries() {
  const sections: ("daily" | "monthly")[] = ["daily", "monthly"];
  return sections.flatMap((section) => usageData?.[section] ?? []);
}

function formatCurrency(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) { return `${(tokens / 1_000_000).toFixed(1)}M`; }
  if (tokens >= 1_000) { return `${(tokens / 1_000).toFixed(1)}K`; }
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
  if (abs >= 1000) { return `$${(value / 1000).toFixed(1)}K`; }
  if (abs >= 1) { return `$${value.toFixed(1)}`; }
  return `$${value.toFixed(2)}`;
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

function createChart(id: string, type: string, data: ChartData, options: ChartOptions = {}): void {
  const canvas = document.getElementById(id) as HTMLCanvasElement;
  const fullOptions: ChartOptions = { responsive: true, maintainAspectRatio: false, ...options };
  const existing = charts[id];
  if (existing) {
    // フィルタ変更のたびに destroy → 再生成するのは無駄なので、data / options を差し替えて update する。
    // チャート種別は id ごとに固定（donut の非表示時は renderAgentDonut 側で destroy + delete される）
    existing.data = data;
    existing.options = fullOptions;
    existing.update();
    return;
  }
  charts[id] = new Chart(canvas, { type, data, options: fullOptions });
}

function overallCacheHitRate(entries: PeriodEntry[]): number {
  let read = 0;
  let total = 0;
  for (const entry of entries) {
    read += entry.cacheReadTokens;
    total += totalTokensOf(entry);
  }
  return hitRate(read, total);
}

function cacheHitRateOf(fields: Pick<AgentBreakdown, "cacheReadTokens" | "inputTokens" | "outputTokens" | "cacheCreationTokens">): number {
  return hitRate(fields.cacheReadTokens, totalTokensOf(fields));
}

function countAgents(entries: PeriodEntry[]): number {
  return allAgents(entries).length;
}

function currentMonthAnchor(): void {
  const now = new Date();
  navYear = now.getFullYear();
  navMonth = now.getMonth() + 1;
}

function navLabel(): string {
  if (state.section === "yearly") { return `${navYear}`; }
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
  if (viewingAll) {
    state.range = { kind: "all" };
  } else if (state.section === "yearly") {
    state.range = { kind: "fixed", year: navYear };
  } else {
    state.range = { kind: "fixed", year: navYear, month: navMonth };
  }
}

function renderNav(): void {
  const label = el("nav-label");
  const contextBar = el("context-bar");
  const contextText = el("context-bar-text");
  const allBtn = el("nav-all");
  if (viewingAll) {
    label.textContent = t("allPeriods");
    contextBar.style.display = "none";
    allBtn.classList.add("active");
  } else {
    const text = navLabel();
    label.textContent = text;
    contextText.textContent = t("showingData", { period: text });
    contextBar.style.display = "";
    allBtn.classList.remove("active");
  }
}

function rangeDescription(): string {
  const range = state.range;
  if (range.kind === "all") { return t("allPeriodsTotal"); }
  const period = range.month !== undefined
    ? `${range.year}/${String(range.month).padStart(2, "0")}`
    : `${range.year}`;
  return t("periodTotal", { period });
}

function renderKpis(kpi: KpiSummary, entries: PeriodEntry[]): void {
  el("kpi-total-cost").textContent = formatCurrency(kpi.totalCost);
  el("kpi-total-sub").textContent = rangeDescription();
  el("kpi-cache-rate").textContent = formatPercent(overallCacheHitRate(entries));
  el("kpi-total-tokens").textContent = formatTokens(kpi.totalTokens);
  el("kpi-models").textContent = String(kpi.activeModelCount);
  el("kpi-agents-sub").textContent = t("agentCount", { count: countAgents(entries) });
}

function renderCostStacked(series: ChartSeries, models: string[], tooltipCtx?: TooltipContext): void {
  createChart(
    "chart-cost-stacked",
    "bar",
    colorize(series, (label) => datasetColor(label, models)),
    {
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45 }, title: { display: true, text: t("period") } },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { callback: (value: unknown) => formatAxisCurrency(Number(value)) },
          title: { display: true, text: t("costUsd") },
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
          title: { display: true, text: t("ratioPercent") },
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
  if (hitRate >= 0.95) { return "#34d399"; }
  if (hitRate >= 0.85) { return "#a3e635"; }
  if (hitRate >= 0.75) { return "#fbbf24"; }
  if (hitRate >= 0.65) { return "#fb923c"; }
  return "#f87171";
}

// 「モデル名 + 横棒 + 数値セル」の行を組み立てる（renderUnitPrice / renderCostRanking で共通）
// データ由来の文字列（modelName）は必ず htmlAttr / htmlText を通す（stored XSS 防止の choke point）
function modelBarRow(modelName: string, barWidth: number, barColor: string, cells: string[]): string {
  return `<tr>
    <td class="model" title="${htmlAttr(modelName)}">${htmlText(shortModelName(modelName))}</td>
    <td class="bar-cell"><div class="bar" style="width:${barWidth}%;background:${barColor}"></div></td>
    ${cells.map((cell) => `<td class="num">${cell}</td>`).join("")}
  </tr>`;
}

function renderUnitPrice(prices: ModelUnitPrice[]): void {
  const maxPrice = maxFinite(prices.map((p) => p.unitPrice), 1);
  const tbody = document.getElementById("unit-price-body") as HTMLElement;
  tbody.innerHTML = prices
    .map((p) => {
      const width = Math.max((p.unitPrice / maxPrice) * 100, 1);
      return modelBarRow(p.modelName, width, hitRateColor(p.hitRate), [formatPercent(p.hitRate), formatCurrency(p.unitPrice)]);
    })
    .join("");
}

function renderCacheHit(series: ChartSeries): void {
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

function renderCostRanking(ranking: ModelCostRank[], models: string[]): void {
  const maxCost = maxFinite(ranking.map((r) => r.cost), 1);
  const tbody = document.getElementById("cost-ranking-body") as HTMLElement;
  tbody.innerHTML = ranking
    .map((r) => {
      const width = Math.max((r.cost / maxCost) * 100, 1);
      return modelBarRow(r.modelName, width, datasetColor(r.modelName, models), [formatCurrency(r.cost), `${Math.round(r.ratio)}%`]);
    })
    .join("");
}

function segValue(cost: number, tokens: number): number {
  return donutSeg === "cost" ? cost : tokens;
}

function formatSegValue(value: number): string {
  return donutSeg === "cost" ? formatCurrency(value) : formatTokens(value);
}

function renderAgentDonut(share: ReturnType<typeof buildDashboardSeriesFromEntries>["agentShare"], efficiency: AgentEfficiency[]): void {
  lastAgentShare = share;
  lastAgentEfficiency = efficiency;
  const effBody = document.getElementById("agent-efficiency-body")!;
  const segLabel = donutSeg === "cost" ? t("totalCost") : t("totalTokens");
  el("donut-value").textContent = "–";
  el("donut-label").textContent = segLabel;

  if (!share.hasDetail || share.agents.length === 0) {
    charts["chart-agent-donut"]?.destroy();
    delete charts["chart-agent-donut"];
    effBody.innerHTML = `<tr><td colspan="5" class="donut-note">${t("noAgentDetail")}</td></tr>`;
    return;
  }

  // 図・中央値・表は同じ値（cost または tokens）を参照する。データとラベルの順序は
  // どちらも efficiency（コスト降順）に合わせる（share.cost/tokens は share.agents 順でラベルとずれるため使わない）
  const data = agentDonutData(efficiency, donutSeg);
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

  const total = segValue(share.totalCost, share.totalTokens);
  el("donut-value").textContent = formatSegValue(total);

  effBody.innerHTML = efficiency
    .map((e, index) => {
      const value = segValue(e.cost, e.tokens);
      const formatted = formatSegValue(value);
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

function agentModelNames(agent: AgentBreakdown): string[] {
  return agent.modelsUsed.length > 0 ? agent.modelsUsed : agent.modelBreakdowns.map((b) => b.modelName);
}

let expandBound = false;

function bindExpand(): void {
  if (expandBound) { return; }
  expandBound = true;
  // tbody は render のたびに innerHTML が置き換わるが、要素自体は使い回されるため
  // ここに 1 つのリスナーを張れば行ごとのリスナー張り直しが不要（event delegation）
  const tbody = document.getElementById("table-body")!;
  tbody.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    // ▶ は expand-btn の子要素（span）なので、classList 判定ではクリック対象が
    // 内部要素のときに発火しない。closest でボタン自身か子孫クリックかを判定する
    const button = target.closest(".expand-btn");
    if (!button) { return; }
    event.stopPropagation();
    const row = button.closest(".period-row");
    if (!row) { return; }
    row.classList.toggle("open");
    const isOpen = row.classList.contains("open");
    button.setAttribute("aria-expanded", String(isOpen));
    let sibling = row.nextElementSibling;
    while (sibling?.classList.contains("agent-row")) {
      sibling.classList.toggle("hidden");
      sibling = sibling.nextElementSibling;
    }
  });
}

const MAX_TABLE_ROWS = 1000;

function renderTable(entries: PeriodEntry[]): void {
  const tbody = document.getElementById("table-body")!;

  if (entries.length === 0) {
    el("table-count").textContent = t("periodCount", { count: 0 });
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${t("noDataForPeriod")}</td></tr>`;
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
    totalTokenFields += totalTokensOf(entry);
  }

  const visible = sliceLatest(entries, MAX_TABLE_ROWS);
  el("table-count").textContent =
    entries.length > MAX_TABLE_ROWS
      ? t("periodCountShown", { count: entries.length, shown: visible.length })
      : t("periodCount", { count: entries.length });

  const orderedEntries = [...visible].reverse();
  const rows: string[] = [];
  orderedEntries.forEach((entry, periodIndex) => {
    const isFirstOpen = periodIndex === 0;
    const agents = entry.agents ?? [];
    const hasDetail = agents.length > 0;

    rows.push(`<tr class="period-row${isFirstOpen ? " open" : ""}">
        <td>${hasDetail
          ? `<button type="button" class="expand-btn" aria-expanded="${isFirstOpen ? "true" : "false"}"><span class="caret">▶</span></button>`
          : ""}${htmlText(entry.period)}</td>
        <td>${t("all")}</td>
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
        <td class="a-label">${htmlText(agent.agent)}</td>
        <td class="models">${agentModelNames(agent).map((model) => `<b>${htmlText(model)}</b>`).join(" · ")}</td>
        <td class="num">${formatTokensFull(agent.inputTokens)}</td>
        <td class="num">${formatTokensFull(agent.outputTokens)}</td>
        <td class="num">${formatPercent(cacheHitRateOf(agent))}</td>
        <td class="num">${formatCurrency(agent.totalCost)}</td>
      </tr>`);
    });
  });

  rows.push(`<tr class="total-row">
      <td>${t("total")}</td>
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
  if (!usageData) { return; }

  applyNavRange();
  renderNav();

  // entries を一度だけ選別し、全系列と共有する（selectSectionEntries の二重実行を避ける）
  const series = buildDashboardSeriesFromEntries(selectSectionEntries(usageData, state.section, state), {
    other: t("other"),
    unitPrice: t("unitPriceLabel"),
    cacheHit: t("cacheHitRate"),
  });
  const entries = series.entries;
  const models = allModels(collectAllEntries());
  const top = new Set(topModelsByCost(entries, TOP_N));
  const tooltipCtx: TooltipContext = { entries, top, excludeZero: true };

  renderKpis(series.kpi, entries);
  renderCostStacked(series.costStacked, models, tooltipCtx);
  renderModelMix(series.modelMix, models, tooltipCtx);
  renderUnitPrice(series.unitPrices);
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

  document.querySelectorAll(".donut-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".donut-toggle button").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
      donutSeg = (btn as HTMLElement).dataset.seg === "token" ? "token" : "cost";
      if (lastAgentShare) { renderAgentDonut(lastAgentShare, lastAgentEfficiency); }
    });
  });

  bindLangToggle();
}

function bindLangToggle(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".lang-toggle button");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.dataset.lang === "ja" ? "ja" : "en";
      setLang(lang, storage);
      applyStaticTranslations(document);
      syncLangToggle();
      if (!hasData) {
        // データ 0 状態では render() を走らせず「データがありません」の簡潔表示を維持する。
        // ただし KPI サブ・ドーナツ中央ラベルは data-i18n 対象外（補間を含む）のため、
        // 言語切替時にここで直接更新して英語残りを防ぐ
        setStatus(t("noData"));
        el("kpi-agents-sub").textContent = t("agentCount", { count: 0 });
        el("donut-label").textContent = donutSeg === "cost" ? t("totalCost") : t("totalTokens");
        return;
      }
      // 言語切替で「すべて」やラベルが変わるため、フィルタ選択肢と動的領域を再構築する。
      // 適用中のモデル・エージェント選択を state から復元し、表示と実データの絞り込みを一致させる
      const entries = collectAllEntries();
      fillSelect("model", allModels(entries), state.model);
      fillSelect("agent", allAgents(entries), state.agent);
      render();
    });
  });
}

// 言語トグルの active 表示を現在言語に合わせる（初期化時と切替時に呼ぶ）
function syncLangToggle(): void {
  const lang: Lang = getLang(storage);
  document.querySelectorAll<HTMLButtonElement>(".lang-toggle button").forEach((btn) => {
    const isActive = btn.dataset.lang === lang;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
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
    assertElements([
      "nav-label",
      "nav-prev",
      "nav-next",
      "nav-all",
      "context-bar",
      "context-bar-text",
      "kpi-total-cost",
      "kpi-total-sub",
      "kpi-cache-rate",
      "kpi-total-tokens",
      "kpi-models",
      "kpi-agents-sub",
      "chart-cost-stacked",
      "chart-model-mix",
      "chart-cache-hit",
      "chart-agent-donut",
      "unit-price-body",
      "cost-ranking-body",
      "agent-efficiency-body",
      "donut-value",
      "donut-label",
      "table-body",
      "table-count",
      "section",
      "model",
      "agent",
      "status",
    ]);
    await loadData();
    const entries = collectAllEntries();
    hasData = entries.length > 0;
    fillSelect("model", allModels(entries));
    fillSelect("agent", allAgents(entries));
    bindControls();
    if (!hasData) {
      setStatus(t("noData"));
      return;
    }
    render();
  } catch (error) {
    setStatus(t("dataError", { message: error instanceof Error ? error.message : String(error) }), true);
  }
}

// 保存済み言語を初回ペイント前に適用する（index.html の静的文言を一瞬英語表示させない）。
// script は body 末尾・parser-blocking で読み込まれるため、ここは初回描画より前の同期実行になる。
// 言語状態の初期化（localStorage 読込）と適用を main() より先に行い、切替時と同じ経路を通す
setLang(getLang(storage), storage);
applyStaticTranslations(document);
syncLangToggle();

void main();
