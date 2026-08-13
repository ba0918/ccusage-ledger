import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LABELS, OTHER_LABEL } from "../aggregate";
import type { PeriodEntry, UsageData } from "../types";
import {
  DEFAULT_LANG,
  MESSAGE_KEYS,
  STORAGE_KEY,
  applyTranslationsToElement,
  createSafeStorage,
  getLang,
  getMessage,
  interpolate,
  resolveLang,
  setLang,
  t,
  type MessageKey,
  type TranslatableElement,
} from "./i18n";

function makeStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    getItem(key: string): string | null {
      return store[key] ?? null;
    },
    setItem(key: string, value: string): void {
      store[key] = value;
    },
  };
}

function fakeElement(dataset: Record<string, string | undefined> = {}): {
  el: TranslatableElement;
  attrs: Record<string, string>;
} {
  const attrs: Record<string, string> = {};
  const el: TranslatableElement = {
    dataset,
    textContent: "original",
    title: "",
    setAttribute(name: string, value: string): void {
      attrs[name] = value;
    },
  };
  return { el, attrs };
}

describe("resolveLang", () => {
  test("未保存（null）は英語を返す", () => {
    expect(resolveLang(null)).toBe("en");
  });

  test("不正な値は英語にフォールバックする", () => {
    expect(resolveLang("")).toBe("en");
    expect(resolveLang("fr")).toBe("en");
  });

  test("保存値が en なら英語、ja なら日本語を返す", () => {
    expect(resolveLang("en")).toBe("en");
    expect(resolveLang("ja")).toBe("ja");
  });
});

describe("getMessage", () => {
  test("言語ごとの文言を返す", () => {
    expect(getMessage("en", "all")).toBe("All");
    expect(getMessage("ja", "all")).toBe("すべて");
  });

  test("積み上げグラフの切替・タイトル・軸・トークン内訳を英語と日本語で返す", () => {
    expect(getMessage("en", "stackedMetricAria")).toBe("Stacked chart display unit");
    expect(getMessage("ja", "stackedMetricAria")).toBe("積み上げグラフの表示単位");
    expect(getMessage("en", "tokensStackedTitle")).toBe("Tokens stacked (by model)");
    expect(getMessage("ja", "tokensStackedTitle")).toBe("トークン積み上げ（モデル別）");
    expect(getMessage("en", "tokenCount")).toBe("Token count");
    expect(getMessage("ja", "tokenCount")).toBe("トークン数");
    expect(getMessage("en", "cacheRead")).toBe("Cache Read");
    expect(getMessage("ja", "cacheRead")).toBe("キャッシュ読み取り");
    expect(getMessage("en", "cacheCreation")).toBe("Cache Creation");
    expect(getMessage("ja", "cacheCreation")).toBe("キャッシュ作成");
  });

  test("全キーが両言語で undefined にならない", () => {
    for (const key of MESSAGE_KEYS) {
      expect(getMessage("en", key)).toBeTypeOf("string");
      expect(getMessage("ja", key)).toBeTypeOf("string");
    }
  });

  test("未知キーは throw せずキー名へフォールバックする", () => {
    expect(getMessage("en", "unknownKey" as MessageKey)).toBe("unknownKey");
    expect(getMessage("ja", "unknownKey" as MessageKey)).toBe("unknownKey");
  });
});

describe("interpolate", () => {
  test("パラメータをプレースホルダへ埋め込む", () => {
    expect(interpolate("{count} agents", { count: 3 })).toBe("3 agents");
  });

  test("パラメータに無いプレースホルダは空文字になる", () => {
    expect(interpolate("{count} {shown}", { count: 3 })).toBe("3 ");
  });

  test("プレースホルダが無い文言はそのまま返す", () => {
    expect(interpolate("All periods", { count: 1 })).toBe("All periods");
  });
});

describe("t", () => {
  test("現在言語の文言を返す", () => {
    const storage = makeStorage();
    setLang("ja", storage);
    expect(t("all")).toBe("すべて");
  });

  test("パラメータを埋め込む", () => {
    const storage = makeStorage();
    setLang("en", storage);
    expect(t("agentCount", { count: 2 })).toBe("2 agents");
  });
});

describe("setLang / getLang", () => {
  test("setLang で保存した言語を getLang が復元する（localStorage 往復）", () => {
    const storage = makeStorage();
    setLang("ja", storage);
    expect(storage.store[STORAGE_KEY]).toBe("ja");
    expect(getLang(storage)).toBe("ja");

    setLang("en", storage);
    expect(storage.store[STORAGE_KEY]).toBe("en");
    expect(getLang(storage)).toBe("en");
  });

  test("保存値が無い storage では英語を返す", () => {
    const storage = makeStorage();
    expect(getLang(storage)).toBe(DEFAULT_LANG);
  });

  test("不正な保存値は英語にフォールバックする", () => {
    const storage = makeStorage({ [STORAGE_KEY]: "fr" });
    expect(getLang(storage)).toBe("en");
  });
});

describe("applyTranslationsToElement", () => {
  test("data-i18n で textContent を差し替える", () => {
    const { el } = fakeElement({ i18n: "all" });
    applyTranslationsToElement(el, "ja");
    expect(el.textContent).toBe("すべて");
  });

  test("data-i18n-title で title を差し替える", () => {
    const { el } = fakeElement({ i18nTitle: "prevPeriod" });
    applyTranslationsToElement(el, "en");
    expect(el.title).toBe("Previous period");
  });

  test("data-i18n-aria で aria-label を設定する", () => {
    const { el, attrs } = fakeElement({ i18nAria: "donutSegAria" });
    applyTranslationsToElement(el, "ja");
    expect(attrs["aria-label"]).toBe("ドーナツの表示単位");
  });

  test("翻訳属性が無い要素は変更しない", () => {
    const { el } = fakeElement();
    applyTranslationsToElement(el, "en");
    expect(el.textContent).toBe("original");
    expect(el.title).toBe("");
  });

  test("data-i18n-lang は無視する（html lang は applyStaticTranslations が設定する）", () => {
    const { el } = fakeElement({ i18nLang: "ja" });
    const elWithLang = el as TranslatableElement & { lang: string };
    elWithLang.lang = "en";
    applyTranslationsToElement(el, "ja");
    expect(elWithLang.lang).toBe("en");
    expect(el.textContent).toBe("original");
  });
});

describe("createSafeStorage", () => {
  test("正常な storage には getItem / setItem をそのまま委譲する", () => {
    const raw = makeStorage();
    const safe = createSafeStorage(() => raw);
    safe.setItem(STORAGE_KEY, "ja");
    expect(raw.store[STORAGE_KEY]).toBe("ja");
    expect(safe.getItem(STORAGE_KEY)).toBe("ja");
  });

  test("生 storage の取得が throw してもメモリフォールバックで動作する", () => {
    const safe = createSafeStorage(() => {
      throw new Error("SecurityError");
    });
    safe.setItem(STORAGE_KEY, "ja");
    expect(safe.getItem(STORAGE_KEY)).toBe("ja");
    expect(getLang(safe)).toBe("ja");
  });

  test("getItem が throw してもクラッシュせず null を返す", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("SecurityError");
      },
      setItem: (): void => {},
    };
    const safe = createSafeStorage(() => broken);
    expect(safe.getItem(STORAGE_KEY)).toBeNull();
    expect(getLang(safe)).toBe(DEFAULT_LANG);
  });

  test("setItem が throw してもメモリフォールバックに保存される", () => {
    const raw = makeStorage();
    const broken = {
      getItem: (key: string): string | null => raw.getItem(key),
      setItem: (): void => {
        throw new Error("SecurityError");
      },
    };
    const safe = createSafeStorage(() => broken);
    safe.setItem(STORAGE_KEY, "ja");
    expect(safe.getItem(STORAGE_KEY)).toBe("ja");
  });
});

describe("index.html の data-i18n キー", () => {
  test("全 data-i18n* 属性のキーが辞書に存在する", () => {
    const html = readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf-8");
    const keys: string[] = [];
    for (const match of html.matchAll(/data-i18n(?:-title|-aria|-lang)?="([^"]+)"/g)) {
      const key = match[1];
      if (key !== undefined) { keys.push(key); }
    }
    expect(keys.length).toBeGreaterThan(0);
    for (const key of new Set(keys)) {
      expect(MESSAGE_KEYS).toContain(key as MessageKey);
    }
  });

  test("積み上げグラフ見出しに翻訳・読み上げ対応した native button トグルを置く", () => {
    const html = readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf-8");

    expect(html).toContain('id="stacked-chart-title"');
    expect(html).toContain('class="seg-toggle stacked-toggle" role="group" aria-label="Stacked chart display unit" data-i18n-aria="stackedMetricAria"');
    expect(html).toContain('<button type="button" class="active" data-metric="cost" aria-pressed="true" data-i18n="cost">Cost</button>');
    expect(html).toContain('<button type="button" data-metric="tokens" aria-pressed="false" data-i18n="tokens">Tokens</button>');
    expect(html).toContain('id="chart-cost-stacked" aria-label="Cost stacked (by model)"');
  });
});

describe("aggregate の既定ラベル", () => {
  test("純計算層の既定ラベルは英語である（表示層の t() に依存しない）", () => {
    expect(OTHER_LABEL).toBe("Others");
    expect(DEFAULT_LABELS.other).toBe("Others");
    expect(DEFAULT_LABELS.unitPrice).toBe("Effective unit price ($/MTok)");
    expect(DEFAULT_LABELS.cacheHit).toBe("Cache hit rate");
  });
});

// ---------------------------------------------------------------------------
// main.ts の言語切替挙動（フェイク DOM で実際の main.ts をロードして検証する）
// ---------------------------------------------------------------------------
// main.ts はブラウザ環境前提で DOM を直接操作する。Bun には DOM が無いため、
// 検証に必要な最小のフェイク DOM を用意し、main.ts を副作用込みで import する。
// モジュールキャッシュを分けるため variant 付きの specifier（./main?xxx）で読み込む

class FakeElement {
  dataset: Record<string, string | undefined> = {};
  textContent = "";
  title = "";
  value = "";
  hidden = false;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  nextElementSibling: FakeElement | null = null;
  private innerHTMLValue = "";
  private listeners = new Map<string, Array<(event?: unknown) => void>>();
  private classes = new Set<string>();
  private attrs: Record<string, string> = {};

  classList = {
    add: (name: string): void => {
      this.classes.add(name);
    },
    remove: (name: string): void => {
      this.classes.delete(name);
    },
    toggle: (name: string, force?: boolean): void => {
      if (force === undefined) {
        if (this.classes.has(name)) {
          this.classes.delete(name);
        } else {
          this.classes.add(name);
        }
      } else if (force) {
        this.classes.add(name);
      } else {
        this.classes.delete(name);
      }
    },
    contains: (name: string): boolean => this.classes.has(name),
  };

  get innerHTML(): string {
    return this.innerHTMLValue;
  }
  // select の option を innerHTML で置き換えると選択（value）が消える挙動を再現する
  set innerHTML(value: string) {
    this.innerHTMLValue = value;
    this.children = [];
    this.value = "";
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  appendChild(child: FakeElement): void {
    this.children.push(child);
  }
  addEventListener(type: string, handler: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
  // 自分と祖先を遡ってセレクタが一致する要素を返す（クリックの対象解決に使う）。
  // クラス（.expand-btn）・属性（[data-model]）・タグ名（tr）の 3 種を扱う。
  // 詳細パネルの行クリック（closest("tr") → dataset.model）の解決に使う
  matches(selector: string): boolean {
    if (selector.startsWith(".")) { return this.classList.contains(selector.slice(1)); }
    const attrMatch = selector.match(/^\[([a-z-]+)\]$/);
    if (attrMatch) {
      const name = attrMatch[1]!;
      return this.dataset[name] !== undefined || this.getAttribute(name) !== null;
    }
    return this.tag === selector;
  }
  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node !== null) {
      if (node.matches(selector)) { return node; }
      node = node.parent;
    }
    return null;
  }
  tag = "div";
}

interface FakeDom {
  documentElement: { lang: string };
  getElementById(id: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  createElement(tag: string): FakeElement;
}

function makeLangButton(lang: string): FakeElement {
  const button = new FakeElement();
  button.dataset.lang = lang;
  return button;
}

function makeStackedButton(metric: string): FakeElement {
  const button = new FakeElement();
  button.dataset.metric = metric;
  return button;
}

function createFakeDom(): FakeDom {
  const elements = new Map<string, FakeElement>();
  const langButtons = [makeLangButton("en"), makeLangButton("ja")];
  const stackedButtons = [makeStackedButton("cost"), makeStackedButton("tokens")];
  return {
    documentElement: { lang: "" },
    getElementById(id: string): FakeElement | null {
      let element = elements.get(id);
      if (element === undefined) {
        element = new FakeElement();
        elements.set(id, element);
      }
      return element;
    },
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === ".lang-toggle button") {
        return langButtons;
      }
      if (selector === ".stacked-toggle button") {
        return stackedButtons;
      }
      return [];
    },
    createElement(_tag: string): FakeElement {
      return new FakeElement();
    },
  };
}

function createFakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
  } as unknown as Storage;
}

class FakeChart {
  static instances: FakeChart[] = [];
  data: ChartData;
  options: ChartOptions;
  constructor(_canvas: HTMLCanvasElement, config: ChartConfig) {
    this.data = config.data;
    this.options = config.options ?? {};
    FakeChart.instances.push(this);
  }
  update(): void {}
  destroy(): void {}
}

function makeEntry(period: string, breakdowns: [string, number][]): PeriodEntry {
  const modelBreakdowns = breakdowns.map(([name, cost]) => ({
    modelName: name,
    cost,
    inputTokens: cost * 1000,
    outputTokens: cost * 100,
    cacheReadTokens: cost * 10,
    cacheCreationTokens: cost,
  }));
  return {
    period,
    totalCost: breakdowns.reduce((sum, [, cost]) => sum + cost, 0),
    totalTokens: modelBreakdowns.reduce((sum, breakdown) => sum + breakdown.inputTokens + breakdown.outputTokens + breakdown.cacheReadTokens + breakdown.cacheCreationTokens, 0),
    inputTokens: modelBreakdowns.reduce((sum, breakdown) => sum + breakdown.inputTokens, 0),
    outputTokens: modelBreakdowns.reduce((sum, breakdown) => sum + breakdown.outputTokens, 0),
    cacheReadTokens: modelBreakdowns.reduce((sum, breakdown) => sum + breakdown.cacheReadTokens, 0),
    cacheCreationTokens: modelBreakdowns.reduce((sum, breakdown) => sum + breakdown.cacheCreationTokens, 0),
    modelsUsed: breakdowns.map(([name]) => name),
    modelBreakdowns,
  };
}

function makeAgentEntry(period: string, agent: string, breakdowns: [string, number][]): PeriodEntry {
  const entry = makeEntry(period, breakdowns);
  return {
    ...entry,
    metadata: { agents: [agent] },
    agents: [{
      agent,
      totalCost: entry.totalCost,
      totalTokens: entry.totalTokens,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      modelsUsed: entry.modelsUsed,
      modelBreakdowns: entry.modelBreakdowns,
    }],
  };
}

const DATA_WITH_MODELS: UsageData = {
  daily: [
    makeEntry("2026-01-10", [["model-a", 0.3], ["model-b", 0.2]]),
    makeEntry("2026-02-03", [["model-a", 0.9]]),
    makeEntry("2026-03-15", [["model-b", 0.4]]),
  ],
  monthly: [],
};
const DATA_WITH_OTHER_MODEL: UsageData = {
  daily: [
    makeEntry("2026-01-10", [["Others", 10], ["m2", 5], ["m3", 4], ["m4", 3], ["m5", 2], ["m6", 1]]),
  ],
  monthly: [],
};
const DATA_WITH_FILTER_CHANGES: UsageData = {
  daily: DATA_WITH_MODELS.daily,
  monthly: [
    makeAgentEntry("2026-04", "claude", [["model-a", 2]]),
    makeAgentEntry("2026-05", "codex", [["model-b", 3]]),
  ],
};
const EMPTY_DATA: UsageData = { daily: [], monthly: [] };

async function loadMain(dom: FakeDom, data: UsageData, brokenStorage: boolean, variant: string): Promise<void> {
  const windowStub = brokenStorage
    ? {
        CCUSAGE_DATA: data,
        get localStorage(): Storage {
          throw new Error("SecurityError: The operation is insecure.");
        },
      }
    : {
        CCUSAGE_DATA: data,
        localStorage: createFakeStorage(),
      };
  (globalThis as Record<string, unknown>).window = windowStub;
  (globalThis as Record<string, unknown>).document = dom as unknown as Document;
  (globalThis as Record<string, unknown>).Chart = FakeChart;
  await import(`./main?${variant}`);
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("main.ts の言語切替", () => {
  test("初期状態は Cost で、Tokens 選択により系列・タイトル・軸・ツールチップが切り替わる", async () => {
    const dom = createFakeDom();
    await loadMain(dom, DATA_WITH_MODELS, false, "stacked-toggle");

    const chart = FakeChart.instances[0]!;
    const buttons = dom.querySelectorAll(".stacked-toggle button");
    expect(dom.getElementById("stacked-chart-title")!.textContent).toBe("Cost stacked (by model)");
    expect(chart.data.datasets[0]!.data[0]).toBeCloseTo(0.3);
    expect((chart.options.scales as { y: { title: { text: string } } }).y.title.text).toBe("Cost (USD)");

    buttons[1]!.dispatch("click");

    expect(dom.getElementById("stacked-chart-title")!.textContent).toBe("Tokens stacked (by model)");
    expect(chart.data.datasets[0]!.data[0]).toBeCloseTo(333.3);
    expect((chart.options.scales as { y: { title: { text: string } } }).y.title.text).toBe("Token count");
    const label = (chart.options.plugins as { tooltip: { callbacks: { label: (item: unknown) => string[] } } }).tooltip.callbacks.label;
    expect(label({ parsed: { y: 333.3 }, dataset: { label: "model-a" }, dataIndex: 0 })).toEqual([
      "model-a: 333",
      "  Total: 333",
      "  Input: 300",
      "  Output: 30",
      "  Cache Read: 3",
      "  Cache Creation: 0",
    ]);
  });

  test("翻訳済みの Others と同名の実モデルを集約バケットとして扱わない", async () => {
    const dom = createFakeDom();
    await loadMain(dom, DATA_WITH_OTHER_MODEL, false, "other-model-collision");

    const chart = FakeChart.instances[0]!;
    const datasets = chart.data.datasets.filter((dataset) => dataset.label === "Others");
    expect(datasets).toHaveLength(2);
    expect(datasets[0]!.backgroundColor).not.toBe(datasets[1]!.backgroundColor);

    const label = (chart.options.plugins as { tooltip: { callbacks: { label: (item: unknown) => string[] } } }).tooltip.callbacks.label;
    expect(label({ parsed: { y: 10 }, dataset: datasets[0], dataIndex: 0 })).toEqual(["Others: $10.0"]);
    expect(label({ parsed: { y: 1 }, dataset: datasets[1], dataIndex: 0 })).toEqual(["Others: $1.0", "  m6: $1.0"]);
  });

  test("Tokens 選択は期間・モデル・エージェント・言語の変更後も維持される", async () => {
    const dom = createFakeDom();
    await loadMain(dom, DATA_WITH_FILTER_CHANGES, false, "stacked-persistence");

    const buttons = dom.querySelectorAll(".stacked-toggle button");
    buttons[1]!.dispatch("click");
    const section = dom.getElementById("section")!;
    section.value = "monthly";
    section.dispatch("change");
    const model = dom.getElementById("model")!;
    model.value = "model-a";
    model.dispatch("change");
    const agent = dom.getElementById("agent")!;
    agent.value = "claude";
    agent.dispatch("change");
    dom.querySelectorAll(".lang-toggle button")[1]!.dispatch("click");

    expect(buttons[1]!.classList.contains("active")).toBe(true);
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(dom.getElementById("stacked-chart-title")!.textContent).toBe("トークン積み上げ（モデル別）");
    const chart = FakeChart.instances[0]!;
    expect((chart.options.scales as { y: { title: { text: string } } }).y.title.text).toBe("トークン数");
    expect(section.value).toBe("monthly");
    expect(agent.value).toBe("claude");
    expect(chart.data.labels).toEqual(["2026-04"]);
    expect(chart.data.datasets.map((dataset) => dataset.label)).toEqual(["model-a"]);
  });

  test("モデルフィルタ適用中に言語切替しても選択が維持され、絞り込みと一致する", async () => {
    const dom = createFakeDom();
    await loadMain(dom, DATA_WITH_MODELS, false, "filter");

    const model = dom.getElementById("model")!;
    const kpiCost = dom.getElementById("kpi-total-cost")!;
    model.value = "model-a";
    model.dispatch("change");
    expect(kpiCost.textContent).toBe("$1.20");

    dom.querySelectorAll(".lang-toggle button")[1]!.dispatch("click");
    expect(model.value).toBe("model-a");
    expect(kpiCost.textContent).toBe("$1.20");
  });

  test("データ 0 状態で言語切替しても render が走らず簡潔表示を維持する", async () => {
    const dom = createFakeDom();
    await loadMain(dom, EMPTY_DATA, false, "empty");

    const status = dom.getElementById("status")!;
    const kpiCost = dom.getElementById("kpi-total-cost")!;
    expect(status.textContent).toBe("No data");

    dom.querySelectorAll(".lang-toggle button")[1]!.dispatch("click");
    expect(status.textContent).toBe("データがありません");
    expect(kpiCost.textContent).toBe("");
  });

  test("データ 0 状態でも Tokens 選択に見出しと canvas の読み上げラベルが追従する", async () => {
    const dom = createFakeDom();
    await loadMain(dom, EMPTY_DATA, false, "empty-stacked-toggle");

    dom.querySelectorAll(".stacked-toggle button")[1]!.dispatch("click");

    expect(dom.getElementById("stacked-chart-title")!.textContent).toBe("Tokens stacked (by model)");
    expect(dom.getElementById("chart-cost-stacked")!.getAttribute("aria-label")).toBe("Tokens stacked (by model)");
  });

  test("データ 0 状態で Tokens 選択後に言語切替しても見出しと canvas の読み上げラベルを翻訳する", async () => {
    const dom = createFakeDom();
    await loadMain(dom, EMPTY_DATA, false, "empty-stacked-language");

    dom.querySelectorAll(".stacked-toggle button")[1]!.dispatch("click");
    dom.querySelectorAll(".lang-toggle button")[1]!.dispatch("click");

    expect(dom.getElementById("stacked-chart-title")!.textContent).toBe("トークン積み上げ（モデル別）");
    expect(dom.getElementById("chart-cost-stacked")!.getAttribute("aria-label")).toBe("トークン積み上げ（モデル別）");
  });

  test("データ 0 状態で言語切替すると KPI サブとドーナツ中央ラベルも言語に追従する", async () => {
    const dom = createFakeDom();
    await loadMain(dom, EMPTY_DATA, false, "empty-labels");

    const agentsSub = dom.getElementById("kpi-agents-sub")!;
    const donutLabel = dom.getElementById("donut-label")!;

    dom.querySelectorAll(".lang-toggle button")[1]!.dispatch("click");
    expect(agentsSub.textContent).toBe("0 エージェント");
    expect(donutLabel.textContent).toBe("合計コスト");
  });

  test("expand-btn の内部（▶）をクリックしても行の開閉が機能する", async () => {
    const dom = createFakeDom();
    await loadMain(dom, DATA_WITH_MODELS, false, "expand-caret");

    const tbody = dom.getElementById("table-body")!;
    // 実 DOM の階層（period-row > expand-btn > caret、および agent-row 兄弟）を組み立てる
    const row = new FakeElement();
    row.classList.add("period-row");
    const button = new FakeElement();
    button.classList.add("expand-btn");
    button.parent = row;
    const caret = new FakeElement();
    caret.parent = button;
    const agentRow = new FakeElement();
    agentRow.classList.add("agent-row");
    row.nextElementSibling = agentRow;

    // ▶（span.caret）がクリック対象でも、closest で expand-btn を解決して開閉できる
    const clickEvent = { target: caret, stopPropagation: () => {} };
    tbody.dispatch("click", clickEvent);
    expect(row.classList.contains("open")).toBe(true);
    expect(agentRow.classList.contains("hidden")).toBe(true);

    // もう一度クリックで閉じる
    tbody.dispatch("click", clickEvent);
    expect(row.classList.contains("open")).toBe(false);
    expect(agentRow.classList.contains("hidden")).toBe(false);
  });

  test("localStorage が使えない環境でも初期化が完了して言語切替できる", async () => {
    const dom = createFakeDom();
    await loadMain(dom, EMPTY_DATA, true, "broken-storage");

    const status = dom.getElementById("status")!;
    expect(status.textContent).toBe("No data");

    dom.querySelectorAll(".lang-toggle button")[1]!.dispatch("click");
    expect(status.textContent).toBe("データがありません");
  });
});

// ---------------------------------------------------------------------------
// 積み上げグラフの棒クリック → 期間詳細パネル（main.ts 接続の統合テスト）
// チャートの onClick は FakeChart に保持された options から直接呼び出し、
// パネルの開閉・選択・状態維持・閉じる導線を検証する。
// 文言（ja/en）の検証は detail-panel.test.ts / i18n 辞書テストに任せ、
// ここでは言語に依存しない状態遷移（期間・クラス・選択数）を検証する
// ---------------------------------------------------------------------------

// 期間 0: model-a / model-b（0.3 / 0.2）。期間 1: model-a / model-c（0.9 / 0.3）。
// 期間 2: 3 モデル（選択上限の置き換えを検証するため）
const PANEL_DATA: UsageData = {
  daily: [
    makeEntry("2026-01-10", [["model-a", 0.3], ["model-b", 0.2]]),
    makeEntry("2026-02-03", [["model-a", 0.9], ["model-c", 0.3]]),
    makeEntry("2026-03-15", [["model-a", 0.4], ["model-b", 0.5], ["model-d", 0.1]]),
  ],
  monthly: [
    makeAgentEntry("2026-04", "claude", [["model-a", 2]]),
    makeAgentEntry("2026-05", "codex", [["model-b", 3]]),
  ],
};

// 積み上げチャートは render ごとに options が差し替えられる（createChart が既存インスタンスを
// 更新する）ため、FakeChart.instances[0] の最新 options から onClick を呼び出す
function clickStackedBar(index: number): void {
  const chart = FakeChart.instances[0]!;
  const onClick = (chart.options as ChartOptions & { onClick?: (event: unknown, elements: ReadonlyArray<{ index?: number }>) => void }).onClick;
  onClick!({}, [{ index }]);
}

function clickPanelRow(dom: FakeDom, modelName: string): void {
  const tbody = dom.getElementById("detail-table-body")!;
  const row = new FakeElement();
  row.tag = "tr";
  row.dataset.model = modelName;
  tbody.dispatch("click", { target: row });
}

describe("積み上げグラフの棒クリックと詳細パネル", () => {
  test("棒クリックで該当期間の詳細パネルが開き、別の棒をクリックすると内容が差し替わる", async () => {
    const dom = createFakeDom();
    await loadMain(dom, PANEL_DATA, false, "panel-open");

    const panel = dom.getElementById("detail-panel")!;
    expect(panel.hidden).toBe(true);

    clickStackedBar(0);
    expect(panel.hidden).toBe(false);
    expect(dom.getElementById("stacked-area")!.classList.contains("has-detail")).toBe(true);
    expect(dom.getElementById("detail-period")!.textContent).toBe("2026-01-10");

    clickStackedBar(1);
    expect(dom.getElementById("detail-period")!.textContent).toBe("2026-02-03");
    const tableHtml = dom.getElementById("detail-table-body")!.innerHTML;
    expect(tableHtml).toContain("model-c");
    expect(tableHtml).not.toContain("model-b");
  });

  test("パネル表示中も概要グラフのモデル集合・系列順・凡例が変わらない", async () => {
    const dom = createFakeDom();
    await loadMain(dom, PANEL_DATA, false, "panel-chart-stable");

    const chart = FakeChart.instances[0]!;
    const before = chart.data.datasets.map((d) => d.label);

    clickStackedBar(0);
    clickPanelRow(dom, "model-a");
    clickPanelRow(dom, "model-b");
    clickStackedBar(1);

    expect(chart.data.datasets.map((d) => d.label)).toEqual(before);
    expect(chart.data.labels).toEqual(["2026-01-10", "2026-02-03", "2026-03-15"]);
  });

  test("行クリックで選択が切り替わり、2 モデルで比較カードが出て、3 つ目は古い方を置き換える", async () => {
    const dom = createFakeDom();
    await loadMain(dom, PANEL_DATA, false, "panel-select");

    clickStackedBar(2);
    const compare = dom.getElementById("detail-compare")!;
    expect(compare.innerHTML).toContain("compare-empty");

    clickPanelRow(dom, "model-a");
    expect(compare.innerHTML).toContain("Select one more model to compare");

    clickPanelRow(dom, "model-b");
    expect(compare.innerHTML).toContain("cb-cards");
    expect(compare.innerHTML).toContain("model-a");
    expect(compare.innerHTML).toContain("model-b");

    clickPanelRow(dom, "model-d");
    expect(compare.innerHTML).toContain("cb-cards");
    expect(compare.innerHTML).toContain("model-b");
    expect(compare.innerHTML).toContain("model-d");
    expect(compare.innerHTML).not.toContain("model-a");
  });

  test("選択モデルの再クリックで選択が解除される", async () => {
    const dom = createFakeDom();
    await loadMain(dom, PANEL_DATA, false, "panel-deselect");

    clickStackedBar(0);
    clickPanelRow(dom, "model-a");
    clickPanelRow(dom, "model-a");

    expect(dom.getElementById("detail-compare")!.innerHTML).toContain("compare-empty");
    expect(dom.getElementById("detail-table-body")!.innerHTML).not.toContain('class="selected"');
  });

  test("選択中の期間は期間・モデル・エージェント・言語の変更後も維持される", async () => {
    const dom = createFakeDom();
    await loadMain(dom, PANEL_DATA, false, "panel-persist");

    clickStackedBar(0);
    expect(dom.getElementById("detail-period")!.textContent).toBe("2026-01-10");

    const section = dom.getElementById("section")!;
    section.value = "monthly";
    section.dispatch("change");
    const model = dom.getElementById("model")!;
    model.value = "model-a";
    model.dispatch("change");
    const agent = dom.getElementById("agent")!;
    agent.value = "claude";
    agent.dispatch("change");
    dom.querySelectorAll(".lang-toggle button")[1]!.dispatch("click");

    expect(dom.getElementById("detail-panel")!.hidden).toBe(false);
    expect(dom.getElementById("detail-period")!.textContent).toBe("2026-01-10");
  });

  test("閉じるボタンでパネルが閉じる", async () => {
    const dom = createFakeDom();
    await loadMain(dom, PANEL_DATA, false, "panel-close-btn");

    clickStackedBar(0);
    dom.getElementById("detail-close")!.dispatch("click");

    expect(dom.getElementById("detail-panel")!.hidden).toBe(true);
    expect(dom.getElementById("stacked-area")!.classList.contains("has-detail")).toBe(false);
  });

  test("全期間表示（nav-all）でパネルが閉じる", async () => {
    const dom = createFakeDom();
    await loadMain(dom, PANEL_DATA, false, "panel-navall");

    clickStackedBar(0);
    dom.getElementById("nav-all")!.dispatch("click");

    expect(dom.getElementById("detail-panel")!.hidden).toBe(true);
    expect(dom.getElementById("stacked-area")!.classList.contains("has-detail")).toBe(false);
  });
});
