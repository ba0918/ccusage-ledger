// 期間 × エージェントの詳細テーブルの描画。main.ts の render* 群から分離した table 担当モジュール。
// チャート描画（charts.ts）と分け、テーブル固有の state（展開状態・行数キャップ）をここに閉じる
import { cacheHitRate, hitRate, totalTokensOf } from "../aggregate";
import type { AgentBreakdown, PeriodEntry } from "../types";
import { el } from "./dom";
import { htmlText } from "./escape";
import { formatCurrency, formatPercent, formatTokensFull } from "./format";
import { t } from "./i18n";

function agentModelNames(agent: AgentBreakdown): string[] {
  return agent.modelsUsed.length > 0 ? agent.modelsUsed : agent.modelBreakdowns.map((b) => b.modelName);
}

// 束縛済みマーカーを要素自身に持たせる（render ごとに tbody は同じ要素を使い回すため、
// 二重張りを防げる。モジュールレベルのフラグにするとテストが main.ts を variant 付きで
// 再 import した場合に table.ts の状態が共有され、新しい DOM へリスナーが張られない）
type ExpandBoundTableBody = HTMLElement & { __expandBound?: boolean };

function bindExpand(): void {
  const tbody = document.getElementById("table-body") as ExpandBoundTableBody;
  if (tbody.__expandBound) { return; }
  tbody.__expandBound = true;
  // tbody は render のたびに innerHTML が置き換わるが、要素自体は使い回されるため
  // ここに 1 つのリスナーを張れば行ごとのリスナー張り直しが不要（event delegation）
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

// 期間行（1 行）+ 展開時に表示されるエージェント行（agent 数）を合わせた行数が
// MAX_TABLE_ROWS に収まる最新期間だけを返す。期間行だけを 1000 にキャップしても
// 期間 × エージェント（検証上限は MAX_AGENTS=500）で最悪数十万行の <tr> を単一文字列で
// 構築し得るため、合計行数でキャップして DOM 構築を抑える（表示は最新期間優先）
function latestPeriodsWithinRowBudget(entries: readonly PeriodEntry[], budget: number): readonly PeriodEntry[] {
  const result: PeriodEntry[] = [];
  let rows = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const entryRows = 1 + (entry.agents?.length ?? 0);
    if (rows + entryRows > budget) { break; }
    result.push(entry);
    rows += entryRows;
  }
  return result.reverse();
}

export function renderTable(entries: PeriodEntry[]): void {
  const tbody = document.getElementById("table-body")!;

  if (entries.length === 0) {
    el("table-count").textContent = t("periodCount", { count: 0 });
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${htmlText(t("noDataForPeriod"))}</td></tr>`;
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

  const visible = latestPeriodsWithinRowBudget(entries, MAX_TABLE_ROWS);
  el("table-count").textContent =
    visible.length < entries.length
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
        <td>${htmlText(t("all"))}</td>
        <td class="models"></td>
        <td class="num">${formatTokensFull(entry.inputTokens)}</td>
        <td class="num">${formatTokensFull(entry.outputTokens)}</td>
        <td class="num">${formatPercent(cacheHitRate(entry))}</td>
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
        <td class="num">${formatPercent(cacheHitRate(agent))}</td>
        <td class="num">${formatCurrency(agent.totalCost)}</td>
      </tr>`);
    });
  });

  rows.push(`<tr class="total-row">
      <td>${htmlText(t("total"))}</td>
      <td></td>
      <td></td>
      <td class="num">${formatTokensFull(totalInput)}</td>
      <td class="num">${formatTokensFull(totalOutput)}</td>
      <td class="num">${formatPercent(hitRate(totalCacheRead, totalTokenFields))}</td>
      <td class="num">${formatCurrency(totalCost)}</td>
    </tr>`);

  tbody.innerHTML = rows.join("");
  bindExpand();
}
