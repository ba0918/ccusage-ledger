import { describe, expect, test } from "bun:test";
import { escapeHtml, htmlText, htmlAttr } from "./escape";

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
