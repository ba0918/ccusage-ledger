import type { UsageData } from "../types";
import {
  allAgents,
  allModels,
  buildDashboardSeries,
  modelColor,
  type DashboardFilters,
  type ChartSeries,
} from "../aggregate";

const state: DashboardFilters = { section: "daily", model: null, agent: null };
let usageData: UsageData | null = null;

const charts: Record<string, ChartInstance> = {};

async function loadData(): Promise<void> {
  const res = await fetch("/api/usage");
  if (!res.ok) throw new Error(`/api/usage failed: ${res.status}`);
  usageData = (await res.json()) as UsageData;
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

function withColors(series: ChartSeries, models: string[], fill: boolean | "origin" = false): ChartSeries {
  return {
    ...series,
    datasets: series.datasets.map((dataset) => ({
      ...dataset,
      fill,
      backgroundColor: modelColor(dataset.label, models),
      borderColor: modelColor(dataset.label, models),
    })),
  };
}

function createChart(id: string, type: string, series: ChartSeries, options: ChartOptions = {}): void {
  const canvas = document.getElementById(id) as HTMLCanvasElement;
  charts[id]?.destroy();

  const chartOptions: ChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    ...options,
  };
  charts[id] = new Chart(canvas, { type, data: { labels: series.labels, datasets: series.datasets }, options: chartOptions });
}

function render(): void {
  if (!usageData) return;

  const series = buildDashboardSeries(usageData, state);
  const models = allModels(collectAllEntries());

  createChart("chart-daily-cost", "bar", withColors(series.dailyCost, models), {
    scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
    plugins: { legend: { display: false } },
  });
  createChart("chart-monthly-cost", "bar", withColors(series.monthlyCost, models), {
    scales: { y: { beginAtZero: true } },
  });
  createChart("chart-model-mix", "line", withColors(series.modelMix, models, "origin"), {
    scales: { y: { min: 0, max: 100, stacked: true }, x: { stacked: true } },
    plugins: { legend: { display: false } },
  });
  createChart("chart-unit-price", "line", withColors(series.unitPrice, models), {
    scales: { y: { beginAtZero: true } },
  });
  createChart("chart-cache-hit", "line", withColors(series.cacheHitRate, models), {
    scales: { y: { min: 0, max: 1, ticks: { callback: (value: number | string) => `${Math.round(Number(value) * 100)}%` } } },
  });
}

function bindControls(): void {
  const section = document.getElementById("section") as HTMLSelectElement;
  const model = document.getElementById("model") as HTMLSelectElement;
  const agent = document.getElementById("agent") as HTMLSelectElement;

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
    fillSelect("model", allModels(collectAllEntries()));
    fillSelect("agent", allAgents(collectAllEntries()));
    bindControls();
    if (collectAllEntries().length === 0) {
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
