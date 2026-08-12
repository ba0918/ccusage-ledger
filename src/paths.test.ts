import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_DIR, defaultCachePath, resolvePackageDir } from "./paths";

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
