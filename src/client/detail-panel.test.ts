// detail-panel.ts の描画テスト。フェイク DOM 上で renderDetailPanel の出力を検証する。
// 実 DOM のセル座標（getBoundingClientRect）と window のサイズだけは、
// ツールチップ位置決め（反転・クランプ）の検証に必要なためフェイクで注入する。
// ツールチップ本体はモジュール内シングルトン（body 直下に 1 個）のため、テストごとに
// variant 付き specifier（./detail-panel?N）でモジュールをロードして状態を分離する
import { describe, expect, test } from "bun:test";
import type { ModelBreakdown, PeriodEntry } from "../types";
import { setLang } from "./i18n";

type PanelModule = typeof import("./detail-panel");

class FakeElement {
  dataset: Record<string, string> = {};
  textContent = "";
  title = "";
  hidden = false;
  tag = "div";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  // セルの実座標（getBoundingClientRect の戻り値）。ツールチップ位置決めの検証に使う
  rect: Record<string, number> = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
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
  set innerHTML(value: string) {
    this.innerHTMLValue = value;
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

  // closest で使うセレクタ照合。クラス（.tm-wrap）・属性（[data-model]）・タグ名（tr）を扱う
  matches(selector: string): boolean {
    if (selector.startsWith(".")) { return this.classes.has(selector.slice(1)); }
    const attrMatch = selector.match(/^\[([a-z-]+)\]$/);
    if (attrMatch) {
      const name = attrMatch[1]!;
      return this.dataset[name] !== undefined || this.attrs[name] !== undefined;
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
  getBoundingClientRect(): Record<string, number> {
    return this.rect;
  }
}

interface FakeDom {
  documentElement: { lang: string };
  body: FakeElement;
  getElementById(id: string): FakeElement | null;
  createElement(tag: string): FakeElement;
}

function createFakeDom(): FakeDom {
  const elements = new Map<string, FakeElement>();
  const body = new FakeElement();
  return {
    documentElement: { lang: "" },
    body,
    getElementById(id: string): FakeElement | null {
      let element = elements.get(id);
      if (element === undefined) {
        element = new FakeElement();
        elements.set(id, element);
      }
      return element;
    },
    createElement(tag: string): FakeElement {
      const element = new FakeElement();
      element.tag = tag;
      // createElement 経由で作られる要素はツールチップ本体（body 直下の共通要素）で、
      // 表示時に測定できる幅・高さを持つものとして返す
      element.rect = { left: 0, top: 0, width: 150, height: 50, right: 150, bottom: 50 };
      return element;
    },
  };
}

function installDom(dom: FakeDom, innerWidth = 1000, innerHeight = 800): void {
  (globalThis as Record<string, unknown>).document = dom as unknown as Document;
  (globalThis as Record<string, unknown>).window = { innerWidth, innerHeight };
}

let loadCount = 0;
function loadPanel(): Promise<PanelModule> {
  loadCount += 1;
  return import(`./detail-panel?${loadCount}`) as Promise<PanelModule>;
}

function breakdown(
  modelName: string,
  cost: number,
  opts: Partial<Omit<ModelBreakdown, "modelName" | "cost">> = {},
): ModelBreakdown {
  return { modelName, cost, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...opts };
}

function makeEntry(period: string, breakdowns: ModelBreakdown[]): PeriodEntry {
  const sum = (pick: (x: ModelBreakdown) => number): number => breakdowns.reduce((s, x) => s + pick(x), 0);
  return {
    period,
    totalCost: sum((x) => x.cost),
    totalTokens: sum((x) => x.inputTokens + x.outputTokens + x.cacheReadTokens + x.cacheCreationTokens),
    inputTokens: sum((x) => x.inputTokens),
    outputTokens: sum((x) => x.outputTokens),
    cacheReadTokens: sum((x) => x.cacheReadTokens),
    cacheCreationTokens: sum((x) => x.cacheCreationTokens),
    modelsUsed: breakdowns.map((x) => x.modelName),
    modelBreakdowns: breakdowns,
  };
}

// sonnet: unit $500（ref） / opus: unit $4.5（非 ref） / deepseek: unit $1（ref）
const ENTRY = makeEntry("2026-08-13", [
  breakdown("claude-sonnet-4-5", 2, { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000, cacheCreationTokens: 1000 }),
  breakdown("deepseek-chat", 0.1, { inputTokens: 100_000 }),
  breakdown("claude-opus-4-5", 9, { inputTokens: 2_000_000 }),
]);
const MODELS = ["claude-opus-4-5", "claude-sonnet-4-5", "deepseek-chat"];

const fakeStorage = { setItem: (): void => {} } as Pick<Storage, "setItem">;

describe("renderDetailPanel", () => {
  test("全モデルが実効単価の降順で行になり、claude- プレフィックスを除去して表示する", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, [], () => {});

    const html = dom.getElementById("detail-table-body")!.innerHTML;
    const sonnet = html.indexOf('data-model="claude-sonnet-4-5"');
    const opus = html.indexOf('data-model="claude-opus-4-5"');
    const deepseek = html.indexOf('data-model="deepseek-chat"');
    expect(sonnet).toBeGreaterThanOrEqual(0);
    expect(sonnet).toBeLessThan(opus);
    expect(opus).toBeLessThan(deepseek);

    expect(html).toContain(">sonnet-4-5<");
    expect(html).toContain(">opus-4-5<");
    expect(html).not.toContain(">claude-sonnet-4-5<");
  });

  test("行にスウォッチ・実効単価・コスト・総トークン・内訳バー（tm-wrap）を描画する", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, [], () => {});

    const html = dom.getElementById("detail-table-body")!.innerHTML;
    expect(html).toContain('class="swatch"');
    expect(html).toContain("$500.000");
    expect(html).toContain("$2.00");
    expect(html).toContain("4,000");
    expect(html).toContain('class="tm-wrap"');
    expect(html).toContain('class="breakdown"');
  });

  test("ref バッジは総トークン 1M 未満のモデルにだけ付く", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, [], () => {});

    const html = dom.getElementById("detail-table-body")!.innerHTML;
    expect(html.match(/class="ref-badge"/g)).toHaveLength(2);
    const sonnetRow = html.slice(html.indexOf('data-model="claude-sonnet-4-5"'), html.indexOf('data-model="claude-opus-4-5"'));
    const opusRow = html.slice(html.indexOf('data-model="claude-opus-4-5"'), html.indexOf('data-model="deepseek-chat"'));
    expect(sonnetRow).toContain('class="ref-badge"');
    expect(opusRow).not.toContain('class="ref-badge"');
  });

  test("パネルを開くと period 表示と has-detail が付き、null エントリで閉じる", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, [], () => {});

    expect(dom.getElementById("detail-panel")!.hidden).toBe(false);
    expect(dom.getElementById("stacked-area")!.classList.contains("has-detail")).toBe(true);
    expect(dom.getElementById("detail-period")!.textContent).toBe("2026-08-13");

    panel.renderDetailPanel(null, MODELS, [], () => {});
    expect(dom.getElementById("detail-panel")!.hidden).toBe(true);
    expect(dom.getElementById("stacked-area")!.classList.contains("has-detail")).toBe(false);
  });

  test("未選択の比較エリアは 2 モデル選択の案内文言になる", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, [], () => {});

    expect(dom.getElementById("detail-compare")!.innerHTML).toContain("Click 2 models to compare them");
  });

  test("1 モデル選択の比較エリアは「もう 1 つ選択」の案内になる", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, ["deepseek-chat"], () => {});

    expect(dom.getElementById("detail-compare")!.innerHTML).toContain("Select one more model to compare");
  });

  test("2 モデル選択でカード型比較（左右カード・共通バー・トークン内訳・倍率要約）を描画する", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, ["claude-sonnet-4-5", "deepseek-chat"], () => {});

    const html = dom.getElementById("detail-compare")!.innerHTML;
    expect(html).toContain('class="cb-cards"');
    expect(html.match(/class="cb-card"/g)).toHaveLength(2);
    expect(html).toContain(">vs<");
    expect(html).toContain("Unit price");
    expect(html).toContain("Cost");
    expect(html).toContain("Total tokens");
    expect(html).toContain("Token mix");
    // トークン内訳はスウォッチ付きラベル（In / Out / CR / CC）で明示する
    expect(html).toContain(">In ");
    expect(html).toContain(">Out ");
    expect(html).toContain(">CR ");
    expect(html).toContain(">CC ");
    // 大きい側（sonnet: $500 vs $1）は up、小さい側は down の色分け
    expect(html).toContain("cb-m-val up");
    expect(html).toContain("cb-m-val down");
    // 倍率要約（unit price 500× · cost 20.0× · tokens 0.04× 相当）
    expect(html).toContain("·");
    expect(html).toContain("×");
  });

  test("選択モデルの行に selected クラスを付けて再描画する", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, ["deepseek-chat"], () => {});

    const html = dom.getElementById("detail-table-body")!.innerHTML;
    expect(html).toContain('data-model="deepseek-chat" class="selected"');
    expect(html).toContain('data-model="claude-sonnet-4-5" title="');
  });

  test("行クリックで onSelect がモデル名を渡して呼ばれる", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    const picked: { name: string | null } = { name: null };
    panel.renderDetailPanel(ENTRY, MODELS, [], (name) => { picked.name = name; });

    const tbody = dom.getElementById("detail-table-body")!;
    const row = new FakeElement();
    row.tag = "tr";
    row.dataset.model = "deepseek-chat";
    tbody.dispatch("click", { target: row });

    expect(picked.name).toBe("deepseek-chat");
  });

  test("モデル名は htmlText / htmlAttr でエスケープして挿入する（テーブルと比較の両方）", async () => {
    const dom = createFakeDom();
    installDom(dom);
    const evilA = breakdown("<img src=x onerror=alert(1)>", 1, { inputTokens: 2_000_000 });
    const evilB = breakdown("<script>alert(2)</script>", 2, { inputTokens: 2_000_000 });
    const panel = await loadPanel();
    setLang("en", fakeStorage);
    panel.renderDetailPanel(
      makeEntry("2026-08-13", [evilA, evilB]),
      [evilA.modelName, evilB.modelName],
      [evilA.modelName, evilB.modelName],
      () => {},
    );

    const tableHtml = dom.getElementById("detail-table-body")!.innerHTML;
    const compareHtml = dom.getElementById("detail-compare")!.innerHTML;
    expect(tableHtml).not.toContain("<img");
    expect(tableHtml).not.toContain("<script");
    expect(tableHtml).toContain("&lt;img");
    expect(compareHtml).toContain("&lt;script");
    expect(compareHtml).not.toContain("<script>alert");
  });

  test("ツールチップはセル座標から位置を決めて表示し、下端超過で上に反転する", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, [], () => {});

    const tbody = dom.getElementById("detail-table-body")!;
    const wrap = new FakeElement();
    wrap.classList.add("tm-wrap");
    wrap.dataset.model = "claude-sonnet-4-5";
    wrap.rect = { left: 300, top: 200, width: 100, height: 10, right: 400, bottom: 210 };
    tbody.dispatch("mouseover", { target: wrap });

    const tip = dom.body.children[0]!;
    expect(tip.classList.contains("visible")).toBe(true);
    expect(tip.style.left).toBe("275px");
    expect(tip.style.top).toBe("218px");
    expect(tip.innerHTML).toContain("Input");
    expect(tip.innerHTML).toContain("Cache Creation");

    const wrapBottom = new FakeElement();
    wrapBottom.classList.add("tm-wrap");
    wrapBottom.dataset.model = "deepseek-chat";
    wrapBottom.rect = { left: 300, top: 780, width: 100, height: 10, right: 400, bottom: 790 };
    tbody.dispatch("mouseover", { target: wrapBottom });
    expect(tip.style.top).toBe("722px");
  });

  test("ツールチップの横位置はビューポート内にクランプされ、マウスアウトで消える", async () => {
    const panel = await loadPanel();
    const dom = createFakeDom();
    installDom(dom);
    setLang("en", fakeStorage);
    panel.renderDetailPanel(ENTRY, MODELS, [], () => {});

    const tbody = dom.getElementById("detail-table-body")!;
    const wrap = new FakeElement();
    wrap.classList.add("tm-wrap");
    wrap.dataset.model = "claude-sonnet-4-5";
    wrap.rect = { left: -100, top: 200, width: 100, height: 10, right: 0, bottom: 210 };
    tbody.dispatch("mouseover", { target: wrap });

    const tip = dom.body.children[0]!;
    expect(tip.style.left).toBe("8px");

    const outside = new FakeElement();
    tbody.dispatch("mouseout", { target: wrap, relatedTarget: outside });
    expect(tip.classList.contains("visible")).toBe(false);
  });

  test("日本語ではパネル・比較・バッジの文言が翻訳される", async () => {
    const dom = createFakeDom();
    installDom(dom);
    const panel = await loadPanel();
    setLang("ja", fakeStorage);

    panel.renderDetailPanel(ENTRY, MODELS, [], () => {});
    expect(dom.getElementById("detail-compare")!.innerHTML).toContain("モデルを 2 つ選ぶと比較できます");
    expect(dom.getElementById("detail-table-body")!.innerHTML).toContain("参考値");

    panel.renderDetailPanel(ENTRY, MODELS, ["deepseek-chat"], () => {});
    expect(dom.getElementById("detail-compare")!.innerHTML).toContain("比較するモデルをもう 1 つ選択してください");

    panel.renderDetailPanel(ENTRY, MODELS, ["deepseek-chat", "claude-sonnet-4-5"], () => {});
    const compareHtml = dom.getElementById("detail-compare")!.innerHTML;
    expect(compareHtml).toContain("単価");
    expect(compareHtml).toContain("トークン構成");
  });
});
