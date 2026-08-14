import { describe, expect, test } from "bun:test";
import { browserCommand, browserUrl, openBrowser, shouldAutoOpen, type OpenEnv } from "./open-browser";

const LOCAL: OpenEnv = { isTTY: true, platform: "linux", DISPLAY: ":0" };

describe("shouldAutoOpen", () => {
  test("SSH_CONNECTION があれば自動オープンしない", () => {
    expect(shouldAutoOpen({ ...LOCAL, SSH_CONNECTION: "192.168.0.1 5555 192.168.0.2 22" })).toBe(false);
  });

  test("SSH_TTY があれば自動オープンしない", () => {
    expect(shouldAutoOpen({ ...LOCAL, SSH_TTY: "/dev/pts/0" })).toBe(false);
  });

  test("stdout が TTY でなければ自動オープンしない", () => {
    expect(shouldAutoOpen({ ...LOCAL, isTTY: false })).toBe(false);
  });

  test("Linux で DISPLAY も WAYLAND_DISPLAY も無ければ自動オープンしない", () => {
    expect(shouldAutoOpen({ isTTY: true, platform: "linux" })).toBe(false);
  });

  test("Linux で WAYLAND_DISPLAY があれば自動オープンする", () => {
    expect(shouldAutoOpen({ isTTY: true, platform: "linux", WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
  });

  test("ローカル対話環境（Linux + DISPLAY）なら自動オープンする", () => {
    expect(shouldAutoOpen(LOCAL)).toBe(true);
  });

  test("macOS はディスプレイ環境変数が無くても自動オープンする", () => {
    expect(shouldAutoOpen({ isTTY: true, platform: "darwin" })).toBe(true);
  });

  test("Windows では自動オープンする（cmd の start で開く）", () => {
    expect(shouldAutoOpen({ isTTY: true, platform: "win32" })).toBe(true);
  });

  test("不明なプラットフォームは自動オープンしない", () => {
    expect(shouldAutoOpen({ isTTY: true, platform: "aix" })).toBe(false);
  });
});

describe("browserCommand", () => {
  test("プラットフォーム別の起動コマンドを、URL を独立した引数として返す", () => {
    // URL は必ず独立した要素にする。文字列結合してシェルに渡すとメタ文字で分割され得るため、
    // spawnSync へ配列のまま渡せる形を保つ
    const url = "http://127.0.0.1:3737";
    expect(browserCommand("darwin", url)).toEqual(["open", url]);
    expect(browserCommand("linux", url)).toEqual(["xdg-open", url]);
    // Windows: start の第 2 引数の "" はウィンドウタイトル（省略すると URL がタイトル扱いになる）
    expect(browserCommand("win32", url)).toEqual(["cmd", "/c", "start", "", url]);
  });
});

describe("browserUrl", () => {
  test("hostname が 0.0.0.0 のときは 127.0.0.1 で開く", () => {
    expect(browserUrl("0.0.0.0", 3000)).toBe("http://127.0.0.1:3000");
  });

  test("通常の hostname はそのまま使う", () => {
    expect(browserUrl("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000");
    expect(browserUrl("192.168.0.5", 8080)).toBe("http://192.168.0.5:8080");
  });
});

describe("openBrowser", () => {
  test("Linux では xdg-open で URL を開く", () => {
    const seen: string[] = [];
    const spawn = (command: string[]) => {
      seen.push(...command);
      return { exitCode: 0 };
    };
    openBrowser("http://127.0.0.1:3000", { platform: "linux", spawn });
    expect(seen).toEqual(["xdg-open", "http://127.0.0.1:3000"]);
  });

  test("macOS では open で URL を開く", () => {
    const seen: string[] = [];
    const spawn = (command: string[]) => {
      seen.push(...command);
      return { exitCode: 0 };
    };
    openBrowser("http://127.0.0.1:3000", { platform: "darwin", spawn });
    expect(seen).toEqual(["open", "http://127.0.0.1:3000"]);
  });
});
