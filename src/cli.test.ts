import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  hostSetting,
  parseArgs,
  parseHostname,
  parsePort,
  resolveHost,
  resolvePort,
  sourceLabel,
} from "./cli";
import { DEFAULT_HOST, DEFAULT_PORT, lanStartPolicy } from "./server";

describe("cli parseHostname", () => {
  test("有効な値（IP リテラル / localhost / ホスト名）はそのまま返す", () => {
    expect(parseHostname("0.0.0.0")).toBe("0.0.0.0");
    expect(parseHostname("127.0.0.1")).toBe("127.0.0.1");
    expect(parseHostname("::")).toBe("::");
    expect(parseHostname("::1")).toBe("::1");
    expect(parseHostname("localhost")).toBe("localhost");
    expect(parseHostname("myhost.local")).toBe("myhost.local");
  });

  test("シェルメタ文字や URL を壊す文字は拒否する（openBrowser への不正 URL 流入を防ぐ）", () => {
    for (const bad of ["127.0.0.1$(touch /tmp/pwn)", "127.0.0.1;id", "host|nc", "a b", "a/b", "a%20b", "<script>", '"', "a$b"]) {
      expect(() => parseHostname(bad)).toThrow(/Invalid HOST/);
    }
  });

  test("空文字は拒否する（未設定は resolveHost が既定値で解決する）", () => {
    expect(() => parseHostname("")).toThrow(/Invalid HOST/);
  });

  test("不正な値は指定元を明示して拒否する（--host と HOST を取り違えない）", () => {
    expect(() => parseHostname("a b", "--host")).toThrow(/Invalid --host=a b/);
    expect(() => parseHostname("a b", "HOST")).toThrow(/Invalid HOST=a b/);
  });
});

describe("cli parseArgs / parsePort", () => {
  test("--port と -p で値を受け取る（= 記法も含む）", () => {
    expect(parseArgs(["--port", "4000"]).port).toBe("4000");
    expect(parseArgs(["-p", "4000"]).port).toBe("4000");
    expect(parseArgs(["--port=4000"]).port).toBe("4000");
  });

  test("--host で値を受け取る（= 記法も含む）", () => {
    expect(parseArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parseArgs(["--host=0.0.0.0"]).host).toBe("0.0.0.0");
  });

  test("--host に短縮形は無い（-h は help のまま）", () => {
    // -H と -h が並ぶと取り違えて意図せず LAN 公開する事故になりうるため、短縮形を与えない
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(() => parseArgs(["-H", "0.0.0.0"])).toThrow(/Unknown option: -H/);
  });

  test("--help を認識する", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs([]).help).toBe(false);
  });

  test("値のないオプションはエラーにする（次のフラグを値として飲み込まない）", () => {
    expect(() => parseArgs(["--port"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--port", "--help"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--host"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--host", "--port"])).toThrow(/requires a value/);
  });

  test("未知のオプションは黙って無視せずエラーにする", () => {
    // 打ち間違い（--prot 4000 等）が黙って既定ポート起動になると原因に気づけない
    expect(() => parseArgs(["--prot", "4000"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--hots", "0.0.0.0"])).toThrow(/Unknown option/);
  });

  test("--host と --port を同時に指定できる", () => {
    expect(parseArgs(["--host", "0.0.0.0", "--port", "4000"])).toEqual({
      host: "0.0.0.0",
      port: "4000",
      help: false,
    });
  });

  test("既定ポートは競合しやすい 3000 ではない", () => {
    // 既定値の適用は resolvePort だけが行う（parsePort は検証のみ）
    expect(resolvePort(undefined, undefined).value).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).not.toBe(3000);
    // Windows の既定動的ポート範囲（49152-65535）に入らない
    expect(DEFAULT_PORT).toBeLessThan(49152);
  });

  test("既定の bind アドレスはループバックである（安全境界の既定）", () => {
    expect(resolveHost(undefined, undefined).value).toBe(DEFAULT_HOST);
    expect(lanStartPolicy(DEFAULT_HOST, true, false)).toBe("ok");
  });

  test("不正な値は指定元を明示して拒否する（--port と PORT を取り違えない）", () => {
    expect(() => parsePort("abc", "--port")).toThrow(/Invalid --port=abc/);
    expect(() => parsePort("0", "--port")).toThrow(/Invalid --port=0/);
    expect(() => parsePort("70000")).toThrow(/Invalid PORT=70000/);
  });
});

describe("cli parseArgs の = 形式", () => {
  test("値を取らないフラグに = で値を付けたら拒否する", () => {
    // 黙って無視すると「指定したのに効かない」ことに気づけない
    expect(() => parseArgs(["--help=json"])).toThrow(/does not take a value/);
    expect(() => parseArgs(["--help="])).toThrow(/does not take a value/);
  });

  test("--port=4000 と --port 4000 が同じ結果になる", () => {
    expect(parseArgs(["--port=4000"])).toEqual(parseArgs(["--port", "4000"]));
  });

  test("--host=0.0.0.0 と --host 0.0.0.0 が同じ結果になる", () => {
    // オプションを増やしても = 形式の対応が漏れないことを、host 側でも固定する
    expect(parseArgs(["--host=0.0.0.0"])).toEqual(parseArgs(["--host", "0.0.0.0"]));
  });

  test("= 形式では次のトークンを消費しない", () => {
    // --port=4000 --help のように後続がある場合、値として飲み込まれてはいけない
    expect(parseArgs(["--port=4000", "--help"])).toEqual({ port: "4000", help: true });
    expect(parseArgs(["--host=0.0.0.0", "--help"])).toEqual({ host: "0.0.0.0", help: true });
  });

  test("= 形式で値が空なら拒否する", () => {
    expect(() => parseArgs(["--port="])).toThrow(/requires a value/);
    expect(() => parseArgs(["--host="])).toThrow(/requires a value/);
  });

  test("未知のオプションは = 形式でもオプション名だけを報告する", () => {
    expect(() => parseArgs(["--prot=4000"])).toThrow(/Unknown option: --prot/);
  });
});

describe("cli resolvePort / resolveHost", () => {
  test("優先順位どおりにポートと決定元を返す", () => {
    expect(resolvePort("4000", "3000")).toEqual({ value: 4000, source: "--port" });
    expect(resolvePort("4000", undefined)).toEqual({ value: 4000, source: "--port" });
    expect(resolvePort(undefined, "3000")).toEqual({ value: 3000, source: "PORT" });
    expect(resolvePort(undefined, undefined)).toEqual({ value: DEFAULT_PORT, source: "default" });
  });

  test("優先順位どおりに bind アドレスと決定元を返す", () => {
    expect(resolveHost("0.0.0.0", "192.168.1.10")).toEqual({ value: "0.0.0.0", source: "--host" });
    expect(resolveHost("0.0.0.0", undefined)).toEqual({ value: "0.0.0.0", source: "--host" });
    expect(resolveHost(undefined, "0.0.0.0")).toEqual({ value: "0.0.0.0", source: "HOST" });
    expect(resolveHost(undefined, undefined)).toEqual({ value: DEFAULT_HOST, source: "default" });
  });

  test("空文字の環境変数は host / port どちらも未設定として扱う", () => {
    // 判定だけ「既定値」にして値の計算を分けると parsePort("") が Invalid PORT= で落ちる。
    // 決定元と値を同じ関数で返すことで、両者が食い違わないようにしている。
    // HOST="" が起動不能で PORT="" が既定値、という非対称が実際にあったため両方を固定する
    expect(resolvePort(undefined, "")).toEqual({ value: DEFAULT_PORT, source: "default" });
    expect(resolveHost(undefined, "")).toEqual({ value: DEFAULT_HOST, source: "default" });
  });

  test("不正な値は指定元を明示して拒否する", () => {
    expect(() => resolvePort("abc", undefined)).toThrow(/Invalid --port=abc/);
    expect(() => resolvePort(undefined, "70000")).toThrow(/Invalid PORT=70000/);
    expect(() => resolveHost("a b", undefined)).toThrow(/Invalid --host=a b/);
    expect(() => resolveHost(undefined, "a/b")).toThrow(/Invalid HOST=a\/b/);
  });
});

describe("cli LAN 公開ガードは指定元で変わらない", () => {
  test("--host での非ループバック指定は HOST と同じ扱いになる", () => {
    // --host が「環境変数より通りやすい抜け道」になってはいけない。
    // 解決後のホスト名だけでポリシーを決めることで、指定元による差を構造的に作らない
    const viaFlag = resolveHost("0.0.0.0", undefined).value;
    const viaEnv = resolveHost(undefined, "0.0.0.0").value;
    expect(viaFlag).toBe(viaEnv);
    for (const isTTY of [true, false]) {
      for (const allowLan of [true, false]) {
        expect(lanStartPolicy(viaFlag, isTTY, allowLan)).toBe(lanStartPolicy(viaEnv, isTTY, allowLan));
      }
    }
  });

  test("--host で LAN 公開しても非 TTY ではオプトインが無ければ拒否される", () => {
    const hostname = resolveHost("0.0.0.0", undefined).value;
    expect(lanStartPolicy(hostname, false, false)).toBe("refuse");
    expect(lanStartPolicy(hostname, true, false)).toBe("prompt");
    expect(lanStartPolicy(hostname, false, true)).toBe("warn");
  });
});

// 実際の起動経路（main）を通す。resolveHost / lanStartPolicy の単体テストは
// 「同じ入力なら同じ判定」しか固定できず、main が CLI 指定だけガードを飛ばすように
// 書き換わっても気づけないため、プロセスとして起動して終了コードまで確認する
async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "cli.ts"), ...args], {
    // CCUSAGE_LEDGER_ALLOW_LAN を継承すると拒否テストが素通りするため、環境は明示的に組み立てる
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe("cli LAN 公開ガード（実際の起動経路）", () => {
  test("非 TTY で --host 0.0.0.0 は起動を拒否する", async () => {
    const { code, stderr } = await runCli(["--host", "0.0.0.0"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--host=0.0.0.0");
    expect(stderr).toContain("non-loopback bind");
  }, 30_000);

  test("非 TTY で HOST=0.0.0.0 も同じく拒否する（指定元で緩まない）", async () => {
    const { code, stderr } = await runCli([], { HOST: "0.0.0.0" });
    expect(code).toBe(1);
    expect(stderr).toContain("HOST=0.0.0.0");
    expect(stderr).toContain("non-loopback bind");
  }, 30_000);
});

describe("cli sourceLabel / hostSetting", () => {
  test("既定値のときは起動ログに何も足さない", () => {
    expect(sourceLabel("port", "default")).toBe("");
    expect(sourceLabel("host", "default")).toBe("");
  });

  test("既定以外は決定元を表示する（既定を変えたのに違う値で起動する理由が分かる）", () => {
    // 環境変数の残存に気づけず「既定ポートが効いていない」と誤解する事例が実際に起きた
    expect(sourceLabel("port", "PORT")).toContain("PORT");
    expect(sourceLabel("port", "--port")).toContain("--port");
    expect(sourceLabel("host", "HOST")).toContain("HOST");
    expect(sourceLabel("host", "--host")).toContain("--host");
  });

  test("LAN 警告文は指定元を含める（--host と HOST を取り違えない）", () => {
    expect(hostSetting("0.0.0.0", "--host")).toBe("--host=0.0.0.0");
    expect(hostSetting("0.0.0.0", "HOST")).toBe("HOST=0.0.0.0");
    expect(hostSetting("127.0.0.1", "default")).toBe("host 127.0.0.1");
  });
});
