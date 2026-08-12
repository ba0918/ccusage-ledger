import { messageOf } from "../errors";
import type { UsageData } from "../types";
import {
  allAgents,
  allModels,
  buildAgentEfficiency,
  buildDashboardSeries,
  formatMonth,
  type AgentEfficiency,
  type AgentShareData,
  type DashboardFilters,
} from "../aggregate";
import { renderAgentDonut, renderCacheHit, renderCostRanking, renderKpis, renderModelMix, renderUnitPrice, renderUsageStacked, type StackedMetric, type TooltipContext } from "./charts";
import { el } from "./dom";
import { htmlText } from "./escape";
import { applyStaticTranslations, createSafeStorage, getLang, setLang, t, type Lang } from "./i18n";
import { loadUsageData } from "./load-data";
import { renderTable } from "./table";

const state: DashboardFilters = { section: "daily", model: null, agent: null, range: { kind: "all" } };
let usageData: UsageData | null = null;
// 全エントリ由来のモデル選択肢。usageData は loadData で一度だけ設定され不変のため、
// render()（フィルタ/ナビ/言語切替のたび）で allModels(collectAllEntries()) を再計算しない
let allModelNames: string[] = [];
// データ 0 状態では render() を走らせず「データがありません」の簡潔表示を維持するためのフラグ
let hasData = false;
let navYear = 0;
let navMonth = 1;
let viewingAll = true;
let donutSeg: "cost" | "token" = "cost";
let stackedMetric: StackedMetric = "cost";
let lastAgentShare: AgentShareData | null = null;
let lastAgentEfficiency: AgentEfficiency[] = [];

// localStorage が使えない環境（プライバシーモード等で SecurityError）でも初期化を死なせない。
// プロパティアクセス自体が throw するため、遅延評価の getRaw を createSafeStorage に渡す
const storage = createSafeStorage(() => window.localStorage);

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
  select.innerHTML = `<option value="">${htmlText(t("all"))}</option>`;
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

function currentMonthAnchor(): void {
  const now = new Date();
  navYear = now.getFullYear();
  navMonth = now.getMonth() + 1;
}

function navLabel(): string {
  if (state.section === "yearly") { return `${navYear}`; }
  return `${navYear}/${formatMonth(navMonth)}`;
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
    ? `${range.year}/${formatMonth(range.month)}`
    : `${range.year}`;
  return t("periodTotal", { period });
}

function render(): void {
  if (!usageData) { return; }

  applyNavRange();
  renderNav();

  // entries を一度だけ選別し、全系列と共有する（buildDashboardSeries が selectSectionEntries を
  // 1 回だけ実行する）。モデル別集計（topModels / costRanking / unitPrices）も
  // buildDashboardSeriesFromEntries 内で 1 回だけ計算されるため、render 側で
  // topModelsByCost / buildModelCostRanking を再計算しない
  const series = buildDashboardSeries(usageData, state, {
    other: t("other"),
    unitPrice: t("unitPriceLabel"),
    cacheHit: t("cacheHitRate"),
  });
  const entries = series.entries;
  const models = allModelNames;
  const tooltipCtx: TooltipContext = { entries, top: new Set(series.topModels), excludeZero: true };

  renderKpis(series.kpi, entries, rangeDescription());
  syncStackedTitle();
  renderUsageStacked(stackedMetric, series.costStacked, series.tokensStacked, models, tooltipCtx);
  renderModelMix(series.modelMix, models, tooltipCtx);
  renderUnitPrice(series.unitPrices);
  // ドーナツのセグメント切替時に直前の render 結果を再描画できるよう、今回の結果を保持しておく
  const efficiency = buildAgentEfficiency(entries);
  lastAgentShare = series.agentShare;
  lastAgentEfficiency = efficiency;
  renderAgentDonut(series.agentShare, efficiency, donutSeg);
  renderCostRanking(series.costRanking, models);
  renderCacheHit(series.cacheHitRate);
  renderTable(entries);
}

// 期間ナビゲーションの「前へ / 次へ」ボタン。direction だけが異なる同一ハンドラを共通化する。
// 初回クリックは現在月/年を起点に、以降は stepNav で 1 単位ずつ動かす
function bindNavButton(button: HTMLButtonElement, direction: 1 | -1): void {
  button.addEventListener("click", () => {
    if (viewingAll) {
      currentMonthAnchor();
      viewingAll = false;
    } else {
      stepNav(direction);
    }
    render();
  });
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
  bindNavButton(navPrev, -1);
  bindNavButton(navNext, 1);
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
      if (lastAgentShare) { renderAgentDonut(lastAgentShare, lastAgentEfficiency, donutSeg); }
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".stacked-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      stackedMetric = btn.dataset.metric === "tokens" ? "tokens" : "cost";
      syncStackedToggle();
      if (hasData) { render(); }
    });
  });

  bindLangToggle();
}

function syncStackedToggle(): void {
  document.querySelectorAll<HTMLButtonElement>(".stacked-toggle button").forEach((btn) => {
    const isActive = btn.dataset.metric === stackedMetric;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
  syncStackedTitle();
}

function syncStackedTitle(): void {
  const title = t(stackedMetric === "cost" ? "costStackedTitle" : "tokensStackedTitle");
  el("stacked-chart-title").textContent = title;
  el("chart-cost-stacked").setAttribute("aria-label", title);
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
      fillSelect("model", allModelNames, state.model);
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
      "stacked-chart-title",
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
    allModelNames = allModels(entries);
    hasData = entries.length > 0;
    fillSelect("model", allModelNames);
    fillSelect("agent", allAgents(entries));
    bindControls();
    syncStackedToggle();
    if (!hasData) {
      setStatus(t("noData"));
      return;
    }
    render();
  } catch (error) {
    setStatus(t("dataError", { message: messageOf(error) }), true);
  }
}

// 保存済み言語を初回ペイント前に適用する（index.html の静的文言を一瞬英語表示させない）。
// script は body 末尾・parser-blocking で読み込まれるため、ここは初回描画より前の同期実行になる。
// 言語状態の初期化（localStorage 読込）と適用を main() より先に行い、切替時と同じ経路を通す
setLang(getLang(storage), storage);
applyStaticTranslations(document);
syncLangToggle();

void main();
