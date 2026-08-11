import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { PACKAGE_DIR, defaultCachePath } from "./paths";

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
    expect(PACKAGE_DIR).toBe(dirname(import.meta.dir));
    expect(normalize(join(PACKAGE_DIR, "src"))).toBe(normalize(import.meta.dir));
  });

  test("パッケージルートに package.json が存在する", () => {
    expect(existsSync(join(PACKAGE_DIR, "package.json"))).toBe(true);
  });
});
