// 期間詳細パネル（積み上げグラフの棒クリックで開く）の DOM 描画。charts.ts / main.ts から
// 分離したパネル担当モジュールで、モデル別テーブル・2 モデル比較カード・トークン内訳
// ツールチップの描画を担う。選択期間・選択モデルの状態は main.ts が持ち、
// renderDetailPanel は渡された状態を毎回描画し直す（モジュール内には描画用の一時状態のみ）
import {
  REF_TOKEN_THRESHOLD,
  buildModelPeriodDetails,
  compareModelDetails,
  modelColor,
  type ModelComparison,
  type ModelPeriodDetail,
} from "../aggregate";
import type { PeriodEntry } from "../types";
import { el } from "./dom";
import { htmlAttr, htmlText } from "./escape";
import { formatCurrency, formatRatio, formatTokens, formatTokensFull, formatUnitPrice, shortModelName } from "./format";
import { t } from "./i18n";

// トークン内訳の表示定義（スウォッチ色 + 短縮ラベル）。inputTokens=In / outputTokens=Out /
// cacheReadTokens=CR / cacheCreationTokens=CC の並び・色はモック合意済みで言語に依存しない
const TOKEN_MIX_KEYS = [
  { key: "inputTokens", color: "#7aa7ff", label: "In" },
  { key: "outputTokens", color: "#4cd6a0", label: "Out" },
  { key: "cacheReadTokens", color: "#b07aa1", label: "CR" },
  { key: "cacheCreationTokens", color: "#f5b34d", label: "CC" },
] as const;
type TokenMixField = (typeof TOKEN_MIX_KEYS)[number]["key"];

// 比較カードのバー色。A は accent（青）、B は green（緑）で左右を対応付ける
const BAR_COLOR_A = "#7aa7ff";
const BAR_COLOR_B = "#4cd6a0";

// トークン内訳の積み上げバー（4 色）。値 0 のフィールドは幅 0 としてスキップする
function tokenBarHtml(d: ModelPeriodDetail): string {
  const total = d.totalTokens || 1;
  return TOKEN_MIX_KEYS.map(({ key, color }) => {
    const value = d[key];
    if (value === 0) { return ""; }
    return `<span style="width:${(value / total) * 100}%;background:${color}"></span>`;
  }).join("");
}

// スウォッチ付きの内訳ラベル（■In 値 ■Out 値 ■CR 値 ■CC 値 + 構成比）。
// 色だけに頼らず「どれが何の数値か」をラベルで明示する
function tokenItemsHtml(d: ModelPeriodDetail): string {
  return TOKEN_MIX_KEYS.map(({ key, color, label }) => {
    const value = d[key];
    const ratio = d.totalTokens === 0 ? 0 : Math.round((value / d.totalTokens) * 100);
    return `<span class="ti"><span class="sw" style="background:${color}"></span>${label} ${formatTokens(value)} (${ratio}%)</span>`;
  }).join("");
}

function tokenMixLabel(key: TokenMixField): string {
  switch (key) {
    case "inputTokens": return t("input");
    case "outputTokens": return t("output");
    case "cacheReadTokens": return t("cacheRead");
    case "cacheCreationTokens": return t("cacheCreation");
  }
}

// ツールチップの内訳行（■In 値 など）。ラベルは言語に追従する（input=入力 等）
function breakdownTipHtml(d: ModelPeriodDetail): string {
  return TOKEN_MIX_KEYS.map(({ key, color }) => {
    const value = d[key];
    return `<div><span class="sw" style="background:${color}"></span><b>${formatTokens(value)}</b> ${htmlText(tokenMixLabel(key))}</div>`;
  }).join("");
}

// モデル別テーブルの 1 行。データ由来の文字列（modelName）は必ず htmlText / htmlAttr を
// 通す（stored XSS 防止の choke point。charts.ts の modelBarRow と同じ慣行）
function rowHtml(d: ModelPeriodDetail, models: string[], selected: readonly string[]): string {
  const color = modelColor(d.modelName, models);
  const refBadge = d.isRef
    ? `<span class="ref-badge" title="${htmlAttr(t("refBadgeTitle", { threshold: formatTokensFull(REF_TOKEN_THRESHOLD) }))}">${htmlText(t("refBadge"))}</span>`
    : "";
  const selectedAttr = selected.includes(d.modelName) ? ' class="selected" aria-pressed="true"' : ' aria-pressed="false"';
  return `<tr data-model="${htmlAttr(d.modelName)}"${selectedAttr} title="${htmlAttr(t("selectModel", { model: shortModelName(d.modelName) }))}">
    <td><span class="m-name"><span class="swatch" style="background:${color}"></span>${htmlText(shortModelName(d.modelName))}${refBadge}</span></td>
    <td class="num-unit">${formatUnitPrice(d.unitPrice)}</td>
    <td>${formatCurrency(d.cost)}</td>
    <td>${formatTokensFull(d.totalTokens)}</td>
    <td><span class="tm-wrap" data-model="${htmlAttr(d.modelName)}"><span class="breakdown">${tokenBarHtml(d)}</span></span></td>
  </tr>`;
}

interface PairMax {
  maxUnit: number;
  maxCost: number;
  maxTokens: number;
}
interface UpFlags {
  unitPrice: boolean;
  cost: boolean;
  tokens: boolean;
}

// ペア最大値で規格化したバー幅。両方 0 の指標は幅 0 にする（NaN 幅を避ける）
function pairBarWidth(value: number, max: number): number {
  return max === 0 ? 0 : (value / max) * 100;
}

// 比較カード 1 枚分。指標ごとにラベル + 値（大きい側=up 赤 / 小さい側=down 緑）と、
// ペア最大値で規格化した共通スケールのバーを並べる
function cardHtml(d: ModelPeriodDetail, pair: PairMax, up: UpFlags, barColor: string, models: string[]): string {
  const swatch = `<span class="swatch" style="background:${modelColor(d.modelName, models)}"></span>`;
  const metric = (label: string, value: string, isUp: boolean): string => `
    <div class="cb-metric"><span class="cb-m-label">${htmlText(label)}</span><span class="cb-m-val ${isUp ? "up" : "down"}">${value}</span></div>`;
  return `<div class="cb-card">
    <div class="cb-card-head">${swatch}${htmlText(shortModelName(d.modelName))}</div>
    ${metric(t("unitPrice"), formatUnitPrice(d.unitPrice), up.unitPrice)}
    <div class="cb-bar"><span style="width:${pairBarWidth(d.unitPrice, pair.maxUnit)}%;background:${barColor}"></span></div>
    ${metric(t("cost"), formatCurrency(d.cost), up.cost)}
    <div class="cb-bar"><span style="width:${pairBarWidth(d.cost, pair.maxCost)}%;background:${barColor}"></span></div>
    ${metric(t("totalTokens"), formatTokensFull(d.totalTokens), up.tokens)}
    <div class="cb-bar"><span style="width:${pairBarWidth(d.totalTokens, pair.maxTokens)}%;background:${barColor}"></span></div>
    <div class="cb-metric"><span class="cb-m-label">${htmlText(t("tokenMix"))}</span></div>
    <div class="tm-bar">${tokenBarHtml(d)}</div>
    <div class="tm-items">${tokenItemsHtml(d)}</div>
  </div>`;
}

// 2 モデルのカード型比較。左右カード + 見出し下の倍率要約（unit price 6.1× · cost … · tokens …）
function compareCardsHtml(a: ModelPeriodDetail, b: ModelPeriodDetail, models: string[]): string {
  const cmp: ModelComparison = compareModelDetails(a, b);
  const pair: PairMax = {
    maxUnit: Math.max(a.unitPrice, b.unitPrice),
    maxCost: Math.max(a.cost, b.cost),
    maxTokens: Math.max(a.totalTokens, b.totalTokens),
  };
  const isUp = (av: number, bv: number): boolean => av > bv;
  return `<div class="compare">
    <div class="compare-head">${htmlText(t("compareHead", { a: a.modelName, b: b.modelName }))}</div>
    <div class="cb-delta-summary">${htmlText(t("compareSummary", {
      unitPrice: formatRatio(cmp.unitPriceRatio),
      cost: formatRatio(cmp.costRatio),
      tokens: formatRatio(cmp.tokensRatio),
    }))}</div>
    <div class="cb-cards">
      ${cardHtml(a, pair, { unitPrice: isUp(a.unitPrice, b.unitPrice), cost: isUp(a.cost, b.cost), tokens: isUp(a.totalTokens, b.totalTokens) }, BAR_COLOR_A, models)}
      <div class="cb-cards-vs">vs</div>
      ${cardHtml(b, pair, { unitPrice: isUp(b.unitPrice, a.unitPrice), cost: isUp(b.cost, a.cost), tokens: isUp(b.totalTokens, a.totalTokens) }, BAR_COLOR_B, models)}
    </div>
    <div class="compare-note">${htmlText(t("compareNote"))}</div>
  </div>`;
}

function renderCompare(details: ModelPeriodDetail[], selected: readonly string[], models: string[]): void {
  const compare = el("detail-compare");
  const picked = details.filter((d) => selected.includes(d.modelName));
  if (picked.length === 2) {
    compare.innerHTML = compareCardsHtml(picked[0]!, picked[1]!, models);
    return;
  }
  const text = picked.length === 1 ? t("compareSelectOneMore") : t("compareSelectTwo");
  compare.innerHTML = `<div class="compare"><div class="compare-head compare-empty">${htmlText(text)}</div></div>`;
}

// トークン内訳ツールチップ。スクロールするテーブル内に絶対配置すると overflow で見切れる
// ため、body 直下の position:fixed 要素（共通 1 個）へ出し、セルの実座標
// （getBoundingClientRect）から位置を決める。下端に収まらないときは上に反転し、
// 横位置はビューポート内にクランプする
let tip: HTMLElement | null = null;
let currentDetails: ModelPeriodDetail[] = [];

function tipElement(): HTMLElement {
  if (tip === null) {
    tip = document.createElement("div");
    tip.className = "tm-tip-fixed";
    document.body.appendChild(tip);
  }
  return tip;
}

function hideTip(): void {
  if (tip !== null) { tip.classList.remove("visible"); }
}

function showTip(modelName: string, anchor: HTMLElement): void {
  const detail = currentDetails.find((d) => d.modelName === modelName);
  if (detail === undefined) { return; }
  const tipEl = tipElement();
  tipEl.innerHTML = breakdownTipHtml(detail);
  tipEl.classList.add("visible");
  const rect = anchor.getBoundingClientRect();
  const tipRect = tipEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  let top = rect.bottom + 8;
  if (top + tipRect.height > window.innerHeight - 8) {
    top = rect.top - tipRect.height - 8;
  }
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

type BoundPanelBody = HTMLElement & { __detailBound?: boolean };
let selectHandler: ((modelName: string) => void) | null = null;

// tbody は render のたびに innerHTML が置き換わるが、要素自体は使い回されるため
// ここに 1 つのリスナーを張れば行ごとのリスナー張り直しが不要（event delegation）
function ensureBound(): void {
  const tbody = el("detail-table-body") as BoundPanelBody;
  if (tbody.__detailBound) { return; }
  tbody.__detailBound = true;
  tbody.addEventListener("mouseover", (event) => {
    // .tm-wrap は行内の span なので closest の結果を HTMLElement として扱う
    const wrap = (event.target as HTMLElement).closest(".tm-wrap") as HTMLElement | null;
    if (wrap === null) { hideTip(); return; }
    const modelName = wrap.dataset.model;
    if (modelName !== undefined) { showTip(modelName, wrap); }
  });
  tbody.addEventListener("mouseout", (event) => {
    const related = event.relatedTarget as HTMLElement | null;
    if (related === null || !related.closest(".tm-wrap")) { hideTip(); }
  });
  tbody.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest("tr");
    const modelName = row?.dataset.model;
    if (modelName !== undefined && selectHandler !== null) { selectHandler(modelName); }
  });
}

export function renderDetailPanel(
  entry: PeriodEntry | null,
  models: string[],
  selected: readonly string[],
  onSelect: (modelName: string) => void,
): void {
  const panel = el("detail-panel");
  const area = el("stacked-area");
  selectHandler = onSelect;
  hideTip();
  if (entry === null) {
    panel.hidden = true;
    area.classList.remove("has-detail");
    currentDetails = [];
    return;
  }
  const details = buildModelPeriodDetails(entry);
  currentDetails = details;
  el("detail-period").textContent = entry.period;
  el("detail-note").textContent = t("detailNote", { threshold: formatTokensFull(REF_TOKEN_THRESHOLD) });
  el("detail-table-body").innerHTML = details.map((d) => rowHtml(d, models, selected)).join("");
  renderCompare(details, selected, models);
  panel.hidden = false;
  area.classList.add("has-detail");
  ensureBound();
}
