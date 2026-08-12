export type Lang = "en" | "ja";

export const DEFAULT_LANG: Lang = "en";
export const STORAGE_KEY = "ccusage-ledger:lang";

// 保存値が不正・未保存の場合は英語へフォールバックする（初期言語は英語）
export function resolveLang(stored: string | null): Lang {
  return stored === "en" || stored === "ja" ? stored : DEFAULT_LANG;
}

// 辞書は en/ja のペアで 1 キーを定義し、MessageKey は辞書キーの union として導出する。
// 辞書の追加・削除は型レベルで両言語の欠落を検出できる
const dict = {
  period: { en: "Period", ja: "期間" },
  periodDaily: { en: "Daily", ja: "日次" },
  periodMonthly: { en: "Monthly", ja: "月次" },
  periodYearly: { en: "Yearly", ja: "年次" },
  all: { en: "All", ja: "すべて" },
  allPeriods: { en: "All periods", ja: "全期間" },
  allPeriodsBtn: { en: "Show all periods", ja: "全期間表示" },
  backToAll: { en: "Back to all periods", ja: "全期間に戻す" },
  prevPeriod: { en: "Previous period", ja: "前の期間" },
  currentPeriod: { en: "Currently displayed period", ja: "現在表示中の期間" },
  nextPeriod: { en: "Next period", ja: "次の期間" },
  periodGranularityTitle: {
    en: "Switch the period granularity of all charts",
    ja: "すべてのグラフの期間粒度を切り替える",
  },
  model: { en: "Model", ja: "モデル" },
  agent: { en: "Agent", ja: "エージェント" },
  showingData: { en: "Viewing data for {period}", ja: "{period} のデータを表示中" },
  kpiCost: { en: "Cost for the selected period", ja: "選択期間のコスト" },
  kpiCacheRate: { en: "Cache hit rate", ja: "キャッシュヒット率" },
  kpiCacheSub: { en: "Cache reads for the period", ja: "対象期間のキャッシュ読み割合" },
  kpiTokens: { en: "Total tokens", ja: "総トークン" },
  kpiTokensSub: { en: "Total for the period", ja: "対象期間の合計" },
  kpiModels: { en: "Active models", ja: "アクティブモデル" },
  agentCount: { en: "{count} agents", ja: "{count} エージェント" },
  allPeriodsTotal: { en: "All-time total", ja: "全期間の累計" },
  periodTotal: { en: "Total for {period}", ja: "{period} の合計" },
  costStackedTitle: { en: "Cost stacked (by model)", ja: "コスト積み上げ（モデル別）" },
  tokensStackedTitle: { en: "Tokens stacked (by model)", ja: "トークン積み上げ（モデル別）" },
  stackedMetricAria: { en: "Stacked chart display unit", ja: "積み上げグラフの表示単位" },
  costStackedHint: {
    en: "Switch daily / monthly / yearly with the period filter",
    ja: "期間フィルタで 日別 / 月別 / 年別 に切り替え",
  },
  modelMixTitle: { en: "Model mix", ja: "モデル構成比率" },
  unitPriceTitle: { en: "Effective unit price by model", ja: "モデル別実効単価" },
  unitPriceHint: { en: "$/MTok (incl. cache hit rate)", ja: "$/MTok（キャッシュヒット率込み）" },
  effectiveUnitPrice: { en: "Effective unit price", ja: "実効単価" },
  hitRate: { en: "Hit rate", ja: "ヒット率" },
  unitPrice: { en: "Unit price", ja: "単価" },
  cost: { en: "Cost", ja: "コスト" },
  tokens: { en: "Tokens", ja: "トークン" },
  tokenCount: { en: "Token count", ja: "トークン数" },
  share: { en: "Share", ja: "割合" },
  input: { en: "Input", ja: "入力" },
  output: { en: "Output", ja: "出力" },
  cacheRead: { en: "Cache Read", ja: "キャッシュ読み取り" },
  cacheCreation: { en: "Cache Creation", ja: "キャッシュ作成" },
  costUsd: { en: "Cost (USD)", ja: "コスト (USD)" },
  agentShareTitle: { en: "Share by agent", ja: "エージェント別配分" },
  donutSegAria: { en: "Donut display unit", ja: "ドーナツの表示単位" },
  totalCost: { en: "Total cost", ja: "合計コスト" },
  totalTokens: { en: "Total tokens", ja: "合計トークン" },
  costRankingTitle: { en: "Model cost ranking", ja: "モデル別コストランキング" },
  costRankingHint: { en: "Cumulative for the selected period", ja: "対象期間の累積" },
  cacheHitRate: { en: "Cache hit rate", ja: "キャッシュヒット率" },
  cacheHitRatePercent: { en: "Cache hit rate (%)", ja: "キャッシュヒット率 (%)" },
  cacheHitTooltip: { en: "Cache hit rate {value}%", ja: "キャッシュヒット率 {value}%" },
  cacheHitHint: { en: "Linked to period navigation", ja: "期間ナビに連動" },
  dataTableTitle: { en: "Data (by period × agent)", ja: "データ（期間別 × エージェント別）" },
  dataTableHint: {
    en: "Click a period button to expand agent details (scrollable)",
    ja: "期間のボタンをクリックでエージェント内訳が開きます（スクロール可能）",
  },
  periodCount: { en: "{count} periods", ja: "期間 {count}件" },
  periodCountShown: { en: "{count} periods ({shown} shown)", ja: "期間 {count}件（表示 {shown}件）" },
  total: { en: "Total", ja: "合計" },
  noData: { en: "No data", ja: "データがありません" },
  noDataForPeriod: { en: "No data for the displayed period", ja: "表示期間のデータがありません" },
  noAgentDetail: { en: "No agent breakdown data", ja: "エージェント別内訳データがありません" },
  dataError: { en: "Failed to load data: {message}", ja: "データ取得エラー: {message}" },
  missingElements: { en: "Missing elements in index.html: {ids}", ja: "index.html に要素がありません: {ids}" },
  other: { en: "Others", ja: "その他" },
  unitPriceLabel: { en: "Effective unit price ($/MTok)", ja: "実効単価 ($/MTok)" },
  ratioPercent: { en: "Share (%)", ja: "構成比 (%)" },
  exportWarning: {
    en: "This file contains your ccusage usage data. Be careful when sharing or handling it.",
    ja: "このファイルには ccusage の使用量データが含まれます。共有・取り扱いに注意してください。",
  },
  langToggle: { en: "Language", ja: "言語" },
  langJa: { en: "Japanese", ja: "日本語" },
  langEn: { en: "English", ja: "English" },
} as const;

export type MessageKey = keyof typeof dict;

export const MESSAGE_KEYS = Object.keys(dict) as readonly MessageKey[];

// getMessage は辞書を直接引く。辞書キーがランタイムで壊れた場合（未知キー・削除済みキー）でも
// throw せずキー名へフォールバックする（要素の textContent への undefined 代入防止）
export function getMessage(lang: Lang, key: MessageKey): string {
  return dict[key]?.[lang] ?? key;
}

// {name} プレースホルダを params で置換する。指定が無いプレースホルダは空文字へ置換する
// （periodCount 等のテンプレート文言を t() が組み立てるときに使う）
export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_placeholder, name: string) => String(params[name] ?? ""));
}

let currentLang: Lang = DEFAULT_LANG;

// 生 storage の取得・読み書きを try/catch で保護するラッパー。localStorage が使えない環境
// （プライバシーモード等で SecurityError）でも初期化を死なせず、失敗時はメモリのみで動作する。
// getRaw は window.localStorage のような遅延評価アクセスに使う（プロパティアクセス自体が throw するため）。
// setItem は常にメモリへも書くため、生 storage が読めない場合でも直近の保存値は復元できる
export function createSafeStorage(
  getRaw: () => Pick<Storage, "getItem" | "setItem"> | null,
): Pick<Storage, "getItem" | "setItem"> {
  const memory = new Map<string, string>();
  const safeRaw = (): Pick<Storage, "getItem" | "setItem"> | null => {
    try {
      return getRaw();
    } catch {
      return null;
    }
  };
  return {
    getItem(key: string): string | null {
      const raw = safeRaw();
      if (raw) {
        try {
          const value = raw.getItem(key);
          if (value !== null) { return value; }
        } catch {
          return memory.get(key) ?? null;
        }
      }
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      memory.set(key, value);
      const raw = safeRaw();
      if (raw) {
        try {
          raw.setItem(key, value);
        } catch {
          // 生 storage への書き込みに失敗してもメモリ側で保持する
        }
      }
    },
  };
}

// localStorage から現在言語を解決する薄いラッパー（pure な resolveLang に委譲する）
export function getLang(storage: Pick<Storage, "getItem">): Lang {
  return resolveLang(storage.getItem(STORAGE_KEY));
}

// 言語の切替を「現在言語の更新 + localStorage への保存」で表現する。
// main.ts の初期化も setLang(resolveLang(...)) で行い、切替時と同じ経路を通す
export function setLang(lang: Lang, storage: Pick<Storage, "setItem">): void {
  currentLang = lang;
  storage.setItem(STORAGE_KEY, lang);
}

// 現在言語で文言を引く短縮形。動的文言（チャート軸・tooltip・テーブル等）は main.ts からこれを使う
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = getMessage(currentLang, key);
  return params ? interpolate(text, params) : text;
}

// 静的要素に data-i18n を適用する。dataset.i18n（textContent）/ dataset.i18nTitle（title）/
// dataset.i18nAria（aria-label）の順に差し替える。<html lang> は applyStaticTranslations が直接設定する
// （data-i18n-lang は使わない）
// DOM に依存しないため、フェイク要素（dataset / textContent / title / setAttribute）でテストできる
export interface TranslatableElement {
  dataset: Record<string, string | undefined>;
  textContent: string;
  title: string;
  setAttribute(name: string, value: string): void;
}

export function applyTranslationsToElement(el: TranslatableElement, lang: Lang): void {
  if (el.dataset.i18n !== undefined) {
    el.textContent = getMessage(lang, el.dataset.i18n as MessageKey);
  }
  if (el.dataset.i18nTitle !== undefined) {
    el.title = getMessage(lang, el.dataset.i18nTitle as MessageKey);
  }
  if (el.dataset.i18nAria !== undefined) {
    el.setAttribute("aria-label", getMessage(lang, el.dataset.i18nAria as MessageKey));
  }
}

// 静的要素（data-i18n 系属性を持つ要素）へ現在言語を一括適用し、<html lang> も同期する。
// applyTranslationsToElement の薄い DOM ラッパーであり、ロジックは要素単位関数に集約している
export function applyStaticTranslations(
  root: Pick<Document, "querySelectorAll" | "documentElement">,
): void {
  const lang = currentLang;
  for (const el of root.querySelectorAll<HTMLElement>(
    "[data-i18n], [data-i18n-title], [data-i18n-aria]",
  )) {
    applyTranslationsToElement(el, lang);
  }
  root.documentElement.lang = lang;
}
