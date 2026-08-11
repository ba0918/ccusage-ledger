import { describe, expect, test } from "bun:test";
import { escapeHtml } from "./escape";

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
