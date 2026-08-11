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
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  private innerHTMLValue = "";
  private listeners = new Map<string, Array<() => void>>();
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
  appendChild(child: FakeElement): void {
    this.children.push(child);
  }
  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler();
    }
  }
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

function createFakeDom(): FakeDom {
  const elements = new Map<string, FakeElement>();
  const langButtons = [makeLangButton("en"), makeLangButton("ja")];
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
  data: unknown;
  options: unknown;
  update(): void {}
  destroy(): void {}
}

function makeEntry(period: string, breakdowns: [string, number][]): PeriodEntry {
  return {
    period,
    totalCost: breakdowns.reduce((sum, [, cost]) => sum + cost, 0),
    totalTokens: breakdowns.length * 1000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelsUsed: breakdowns.map(([name]) => name),
    modelBreakdowns: breakdowns.map(([name, cost]) => ({
      modelName: name,
      cost,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })),
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

  test("localStorage が使えない環境でも初期化が完了して言語切替できる", async () => {
    const dom = createFakeDom();
    await loadMain(dom, EMPTY_DATA, true, "broken-storage");

    const status = dom.getElementById("status")!;
    expect(status.textContent).toBe("No data");

    dom.querySelectorAll(".lang-toggle button")[1]!.dispatch("click");
    expect(status.textContent).toBe("データがありません");
  });
});
