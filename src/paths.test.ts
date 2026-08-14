import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_DIR, defaultCachePath, isUnderBase, resolvePackageDir } from "./paths";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe("defaultCachePath", () => {
  test("XDG_CACHE_HOME があればそれを基準にする", () => {
    expect(defaultCachePath({ XDG_CACHE_HOME: "/tmp/xdg-cache" })).toBe("/tmp/xdg-cache/ccusage-ledger/usage.json");
  });

  test("XDG_CACHE_HOME が無ければ HOME/.cache を使う", () => {
    expect(defaultCachePath({ HOME: "/home/test-user" })).toBe("/home/test-user/.cache/ccusage-ledger/usage.json");
  });
});

describe("PACKAGE_DIR", () => {
  test("src の親（パッケージルート）を指す", () => {
    expect(PACKAGE_DIR).toBe(dirname(SRC_DIR));
    expect(normalize(join(PACKAGE_DIR, "src"))).toBe(normalize(SRC_DIR));
  });

  test("パッケージルートに package.json が存在する", () => {
    expect(existsSync(join(PACKAGE_DIR, "package.json"))).toBe(true);
  });
});

describe("resolvePackageDir", () => {
  test("起点ディレクトリに package.json があればそれを返す", () => {
    // SRC_DIR（src/）には package.json が無いため、親（パッケージルート）が返る
    expect(resolvePackageDir(SRC_DIR)).toBe(dirname(SRC_DIR));
  });

  test("起点に package.json が無ければ親を遡って探す", () => {
    const resolved = resolvePackageDir(join(SRC_DIR, "nonexistent"));
    expect(existsSync(join(resolved, "package.json"))).toBe(true);
  });
});

describe("isUnderBase", () => {
  test("基底自身と配下は true、外は false", () => {
    expect(isUnderBase("/root/dist/bundle.js", "/root/dist", { separator: "/" })).toBe(true);
    expect(isUnderBase("/root/dist", "/root/dist", { separator: "/" })).toBe(true);
    expect(isUnderBase("/root/src/server.ts", "/root/dist", { separator: "/" })).toBe(false);
  });

  test("前方一致の取り違えを起こさない（区切りを付けて比較する）", () => {
    expect(isUnderBase("/root/dist-other/x", "/root/dist", { separator: "/" })).toBe(false);
    expect(isUnderBase("C:\\Users\\u2\\.cache", "C:\\Users\\u", { separator: "\\" })).toBe(false);
  });

  test("Windows のパス区切りでも判定できる（区切り決め打ちだと静的配信が全滅する）", () => {
    const base = "C:\\Users\\u\\node_modules\\ccusage-ledger";
    expect(isUnderBase(`${base}\\dist\\bundle.js`, `${base}\\dist`, { separator: "\\" })).toBe(true);
    expect(isUnderBase(`${base}\\index.html`, base, { separator: "\\" })).toBe(true);
  });

  test("caseInsensitive は大文字小文字を無視する（Windows のファイルシステム向け）", () => {
    const home = "C:\\Users\\mizum";
    expect(isUnderBase("c:\\users\\mizum\\.cache", home, { separator: "\\", caseInsensitive: true })).toBe(true);
    // 既定は区別する（POSIX の挙動を変えない）
    expect(isUnderBase("c:\\users\\mizum\\.cache", home, { separator: "\\" })).toBe(false);
  });

  test("末尾の区切りは無視して比較する", () => {
    expect(isUnderBase("/root/dist/x", "/root/dist/", { separator: "/" })).toBe(true);
    expect(isUnderBase("/root/dist/", "/root/dist", { separator: "/" })).toBe(true);
  });

  test("落とすのは指定した区切りだけ（POSIX の \\ は正当なファイル名文字）", () => {
    // 両方の区切りを一律に剥がすと、POSIX で "dist\\" という名前のファイルが "dist" と
    // 一致し、そのディレクトリ外のファイルを配信できてしまう
    expect(isUnderBase("/root/dist\\", "/root/dist", { separator: "/" })).toBe(false);
    // Windows では "\\" が区切りなので、末尾の "\\" は落として比較する
    expect(isUnderBase("C:\\root\\dist\\", "C:\\root\\dist", { separator: "\\" })).toBe(true);
  });
});
