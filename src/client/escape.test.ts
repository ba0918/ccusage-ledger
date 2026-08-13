import { describe, expect, test } from "bun:test";
import { escapeHtml, htmlText, htmlAttr, safeUrl } from "./escape";

describe("escapeHtml", () => {
  test("HTML メタ文字をすべてエスケープする", () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
  });

  test("シングルクォートをエスケープする", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  test("非文字列は String に変換してからエスケープする（描画クラッシュ防止）", () => {
    expect(escapeHtml(20260811 as unknown as string)).toBe("20260811");
    expect(escapeHtml(null as unknown as string)).toBe("null");
    expect(escapeHtml(undefined as unknown as string)).toBe("undefined");
  });
});

describe("htmlText / htmlAttr（描画の choke point）", () => {
  test("htmlText はテキスト文脈のデータをエスケープする（escapeHtml と同一実体）", () => {
    expect(htmlText(`<img src=x onerror=alert(1)>`)).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(htmlText("model & agent")).toBe("model &amp; agent");
  });

  test("htmlAttr は属性値のデータをエスケープする（属性を閉じられない）", () => {
    expect(htmlAttr(`" onmouseover="alert(1)`)).toBe("&quot; onmouseover=&quot;alert(1)");
    expect(htmlAttr("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  test("htmlText / htmlAttr は非文字列も String 化して壊れない", () => {
    expect(htmlText(42 as unknown as string)).toBe("42");
    expect(htmlAttr(null as unknown as string)).toBe("null");
  });
});

describe("safeUrl（URL 文脈の choke point）", () => {
  test("http / https / mailto のスキームは許可する", () => {
    expect(safeUrl("https://example.com/")).toBe("https://example.com/");
    expect(safeUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
    expect(safeUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
    // スキームの大文字小文字は正規化して判定する
    expect(safeUrl("HTTPS://example.com/")).toBe("HTTPS://example.com/");
  });

  test("スキームを持たない相対 URL は許可する", () => {
    expect(safeUrl("/dist/bundle.js")).toBe("/dist/bundle.js");
    expect(safeUrl("#section")).toBe("#section");
  });

  test("javascript: / data: / vbscript: は拒否する（空文字を返す）", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(safeUrl("vbscript:msgbox(1)")).toBe("");
  });

  test("制御文字を含む URL は拒否する（改行によるスキーム混入を防ぐ）", () => {
    // HTML 属性ではタブ・改行が無視されるため、"java\nscript:alert(1)" は
    // レンダリング時に javascript: スキームとして解釈され得る。全体を拒否する
    expect(safeUrl("java\nscript:alert(1)")).toBe("");
    expect(safeUrl("java\tscript:alert(1)")).toBe("");
    expect(safeUrl("ja\u0000vascript:alert(1)")).toBe("");
  });

  test("プロトコル相対 URL（//）は拒否する（ネットワークスキームへの遷移を防ぐ）", () => {
    expect(safeUrl("//evil.example/steal")).toBe("");
  });

  test("非文字列は String 化して判定する", () => {
    expect(safeUrl(null as unknown as string)).toBe("");
  });
});
