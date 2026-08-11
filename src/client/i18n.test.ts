import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LANG,
  MESSAGE_KEYS,
  STORAGE_KEY,
  applyTranslationsToElement,
  getLang,
  getMessage,
  interpolate,
  resolveLang,
  setLang,
  t,
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
    lang: "",
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
});
