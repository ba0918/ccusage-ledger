import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, symlinkSync, lstatSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { fetchUsage, DEFAULT_COMMAND, spawnEnv, userHomeDir, ccusageCliPath, buildCcusageCommand, resolvePackageRoot, toPosixRelPath, waitForExit, collectProcessOutput, type SpawnResult } from "./fetch-usage";
import { projectUsageData } from "./usage-data";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "usage.json"), "utf-8"));
// キャッシュには白リスト投影済みのデータが保存される（未知フィールド・totals は落ちる）
const PROJECTED = projectUsageData(FIXTURE);

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccusage-fetch-"));
  return dir;
}

function writeCacheFixture(cachePath: string): void {
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  writeFileSync(cachePath, JSON.stringify(FIXTURE));
}

describe("DEFAULT_COMMAND", () => {
  test("ccusage の引数（JSON・daily/monthly・エージェント内訳）を指定する", () => {
    expect(DEFAULT_COMMAND).toEqual(["--json", "--sections", "daily,monthly", "--by-agent"]);
  });
});

describe("ccusageCliPath", () => {
  test("解決できない基準ディレクトリではネストした node_modules パスにフォールバックする", () => {
    expect(ccusageCliPath("/pkg")).toBe(join("/pkg", "node_modules", "ccusage", "src", "cli.js"));
  });

  test("ホイストされた node_modules でも実在する cli.js を指す（配布版で取得が失敗しない）", () => {
    // npm / bun のフラットな node_modules では依存が兄弟にホイストされるため、
    // ネストパス決め打ちだと npx / bunx 配布版で cli.js が見つからずデータが常に空になる
    const cliPath = ccusageCliPath();
    expect(existsSync(cliPath)).toBe(true);
    expect(toPosixRelPath(cliPath).endsWith("ccusage/src/cli.js")).toBe(true);
  });
});

describe("resolvePackageRoot", () => {
  test("スコープ付きパッケージも解決できる（native バイナリの整合性検証で使う）", () => {
    const root = resolvePackageRoot("@ccusage/ccusage-linux-x64");
    expect(toPosixRelPath(root).endsWith("@ccusage/ccusage-linux-x64")).toBe(true);
  });

  test("解決できない場合はスコープを分割してネストパスを組み立てる", () => {
    expect(resolvePackageRoot("@scope/pkg", "/pkg")).toBe(join("/pkg", "node_modules", "@scope", "pkg"));
  });
});

describe("waitForExit", () => {
  test("正常終了した子プロセスの終了コードを返す", async () => {
    const proc = spawnProcess(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    expect(await waitForExit(proc)).toBe(0);
  });

  test("非ゼロ終了の終了コードをそのまま返す（ログに実際のコードが出る）", async () => {
    const proc = spawnProcess(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
    expect(await waitForExit(proc)).toBe(3);
  });

  test("シグナルで終了した場合（code が null）は失敗として 1 を返す", async () => {
    const proc = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const exited = waitForExit(proc);
    proc.kill("SIGKILL");
    expect(await exited).toBe(1);
  });

  test("stdout を閉じてから遅れて非ゼロ終了しても失敗として扱う（close を待たない誤判定の防止）", async () => {
    // stdout の EOF はプロセス終了と同時とは限らない。終了を待たずに proc.exitCode を
    // 読むと null になり、失敗が成功として扱われてしまう
    const proc = spawnProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'); process.stdout.end(); setTimeout(() => process.exit(2), 150);"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    expect(await waitForExit(proc)).toBe(2);
  });

  test("終了要求を無視する子プロセスを猶予後に強制終了し、有限時間で失敗として完了する", async () => {
    const proc = spawnProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => proc.stdout!.once("data", () => resolve()));
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const originalKill = proc.kill.bind(proc);
    proc.kill = ((signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      return originalKill(signal);
    }) as typeof proc.kill;

    const started = Date.now();
    expect(await waitForExit(proc, { timeoutMs: 20, terminationGraceMs: 20, forceKillWaitMs: 200 })).toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("collectProcessOutput", () => {
  test("子孫が stdout を保持していても期限内に収集を終了する", async () => {
    const proc = spawnProcess(
      process.execPath,
      ["-e", `
        const { spawn } = require("node:child_process");
        spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
          stdio: ["ignore", process.stdout, "ignore"],
        });
        process.exit(0);
      `],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const started = Date.now();
    await expect(collectProcessOutput(proc, {
      timeoutMs: 30,
      terminationGraceMs: 20,
      forceKillWaitMs: 20,
    })).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("buildCcusageCommand", () => {
  test("実行中インタプリタ（process.execPath）で <cli.js> の後に引数を繋ぐ", () => {
    expect(buildCcusageCommand("/pkg/node_modules/ccusage/src/cli.js", ["--json"], "/usr/bin/bun")).toEqual([
      "/usr/bin/bun",
      "/pkg/node_modules/ccusage/src/cli.js",
      "--json",
    ]);
  });

  test("execPath を指定しない場合は process.execPath を使う", () => {
    const cmd = buildCcusageCommand("/pkg/node_modules/ccusage/src/cli.js", ["--json"]);
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd.slice(1)).toEqual(["/pkg/node_modules/ccusage/src/cli.js", "--json"]);
  });
});

describe("spawnEnv", () => {
  test("許可リストのキーのみを残し、HOME は空の一時ディレクトリに置き換える", () => {
    expect(spawnEnv(
      { PATH: "/usr/bin", HOME: "/home/u", XDG_CACHE_HOME: "/tmp/c" },
      { userHome: "/home/u", emptyHome: "/tmp/empty", dirExists: () => true },
    )).toEqual({
      PATH: "/usr/bin",
      XDG_CACHE_HOME: "/tmp/c",
      HOME: "/tmp/empty",
      CLAUDE_CONFIG_DIR: "/home/u/.claude/projects",
      CODEX_HOME: "/home/u/.codex",
      GEMINI_DATA_DIR: "/home/u/.gemini/tmp",
      OPENCODE_DATA_DIR: "/home/u/.local/share/opencode",
    });
  });

  test("秘密系の環境変数を除外する", () => {
    const env = spawnEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        ANTHROPIC_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
      { userHome: "/home/u", emptyHome: "/tmp/empty", dirExists: () => true },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // HOME は実ユーザーのものではなく空の一時ディレクトリになる
    expect(env.HOME).toBe("/tmp/empty");
  });

  test("ユーザーがデータディレクトリ env を設定している場合はそれを尊重する", () => {
    const env = spawnEnv(
      { CLAUDE_CONFIG_DIR: "/custom/claude", CODEX_HOME: "/custom/codex" },
      { userHome: "/home/u", emptyHome: "/tmp/empty", dirExists: () => true },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
    expect(env.CODEX_HOME).toBe("/custom/codex");
    // 未設定のものはデフォルトを解決する
    expect(env.GEMINI_DATA_DIR).toBe("/home/u/.gemini/tmp");
    expect(env.OPENCODE_DATA_DIR).toBe("/home/u/.local/share/opencode");
  });

  test("データディレクトリ env が空文字の場合はデフォルトにフォールバックする", () => {
    const env = spawnEnv(
      { CLAUDE_CONFIG_DIR: "" },
      { userHome: "/home/u", emptyHome: "/tmp/empty", dirExists: () => true },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude/projects");
  });

  test("HOME に $ 置換パターンが含まれていてもデータディレクトリ env が壊れない", () => {
    // String.replace の $ 置換（$& 等）を避けて連結しているため、HOME に $ があっても正しく解決する
    const env = spawnEnv(
      { PATH: "/usr/bin" },
      { userHome: "/tmp/otaku$'PATH", emptyHome: "/tmp/empty", dirExists: () => true },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/otaku$'PATH/.claude/projects");
    expect(env.CODEX_HOME).toBe("/tmp/otaku$'PATH/.codex");
  });
});

describe("spawnEnv データディレクトリの存在判定", () => {
  test("存在しないデフォルトのデータディレクトリは渡さない（未使用エージェントで取得が丸ごと失敗しない）", () => {
    // ccusage は指定されたディレクトリが無いとエラー終了する。Claude Code を使っていない
    // 環境で ~/.claude/projects を常に渡すと、Codex 等のデータがあっても取得が失敗し、
    // ダッシュボードが常に空になる
    const env = spawnEnv(
      { PATH: "/usr/bin" },
      {
        userHome: "/home/u",
        emptyHome: "/tmp/empty",
        dirExists: (path) => path === "/home/u/.codex",
      },
    );
    expect(env.CODEX_HOME).toBe("/home/u/.codex");
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.GEMINI_DATA_DIR).toBeUndefined();
    expect(env.OPENCODE_DATA_DIR).toBeUndefined();
  });

  test("ユーザーが明示指定した値は存在しなくてもそのまま渡す（設定ミスを黙って握り潰さない）", () => {
    const env = spawnEnv(
      { CLAUDE_CONFIG_DIR: "/custom/claude" },
      { userHome: "/home/u", emptyHome: "/tmp/empty", dirExists: () => false },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
  });
});

describe("userHomeDir", () => {
  test("HOME があればそれを使い、無ければ homedir() にフォールバックする", () => {
    expect(userHomeDir({ HOME: "/home/u" })).toBe("/home/u");
    expect(typeof userHomeDir({})).toBe("string");
  });
});

describe("fetchUsage デフォルト cachePath", () => {
  test("XDG_CACHE_HOME 基準のパスをデフォルトに使う", async () => {
    const dir = tempDir();
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = dir;
    try {
      const expected = join(dir, "ccusage-ledger", "usage.json");
      writeCacheFixture(expected);
      const result = await fetchUsage({ spawn: async () => ({ stdout: "", exitCode: 1 }) });
      expect(result).not.toBeNull();
      expect(result!.source).toBe("cache");
      expect(result!.data).toEqual(PROJECTED);
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prev;
      }
    }
  });
});

describe("fetchUsage キャッシュ書き込み", () => {
  test("キャッシュファイルは 0600 で書かれる", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({ stdout: JSON.stringify(FIXTURE), exitCode: 0 });

    await fetchUsage({ cachePath, spawn });

    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(PROJECTED);
  });

  test("キャッシュは白リスト投影済みで保存する（totals などの未知フィールドを永続化しない）", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({ stdout: JSON.stringify(FIXTURE), exitCode: 0 });

    await fetchUsage({ cachePath, spawn });

    const saved = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(saved.totals).toBeUndefined();
    expect(saved.daily).toHaveLength(3);
  });

  test("キャッシュ書き込み後は一時ファイルを残さない", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({ stdout: JSON.stringify(FIXTURE), exitCode: 0 });

    await fetchUsage({ cachePath, spawn });

    const tmpFiles = readdirSync(dirname(cachePath)).filter((name) => name.includes(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  test("キャッシュ temp ファイル名はランダムで、攻撃者が事前に symlink を仕掛けても追わない", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });

    // 攻撃者が PID ベースの固定 temp 名に symlink を事前に仕掛けた状態
    const decoy = join(dirname(cachePath), "usage.json.tmp.12345");
    symlinkSync("/tmp/ccusage-attacker-decoy", decoy);

    const spawn = async (): Promise<SpawnResult> => ({ stdout: JSON.stringify(FIXTURE), exitCode: 0 });
    await fetchUsage({ cachePath, spawn });

    // 書き込み成功し、攻撃者の symlink は置き換えられていない
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(PROJECTED);
    expect(lstatSync(decoy).isSymbolicLink()).toBe(true);
  });

  test("キャッシュディレクトリが自分所有でも 0755 なら 0700 に設定し直してから書く", async () => {
    const dir = tempDir();
    const cacheDir = join(dir, "data");
    mkdirSync(cacheDir, { recursive: true });
    chmodSync(cacheDir, 0o755);
    const cachePath = join(cacheDir, "usage.json");

    const spawn = async (): Promise<SpawnResult> => ({ stdout: JSON.stringify(FIXTURE), exitCode: 0 });
    await fetchUsage({ cachePath, spawn });

    // 共有パーミッションのままキャッシュを書かない（fail-closed: 自分所有なら 0700 に直す）
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(PROJECTED);
  });

  test("キャッシュディレクトリが他人所有なら書き込まない（fail-closed）", async () => {
    if (typeof process.getuid !== "function") { return; }
    const dir = tempDir();
    const cacheDir = join(dir, "data");
    mkdirSync(cacheDir, { recursive: true });
    // 現在ユーザーの UID を他人に変えるのは root でしかできないため、所有権チェックが
    // 入ることをモックで検証する（writeCache は非公開なので fetchUsage 経由で失敗を観測する）。
    // 実運用では chown された共有ディレクトリがこの分岐に入る
    const original = process.getuid;
    (process as { getuid?: () => number }).getuid = () => original() + 1;
    try {
      const cachePath = join(cacheDir, "usage.json");
      const spawn = async (): Promise<SpawnResult> => ({ stdout: JSON.stringify(FIXTURE), exitCode: 0 });
      // fetchUsage はキャッシュ書き込み失敗を warn して新鮮データを返す（ベストエフォート契約）。
      // ここでは書き込みが行われずキャッシュファイルが作られないことを確認する
      const result = await fetchUsage({ cachePath, spawn });
      expect(result?.source).toBe("fresh");
      expect(existsSync(cachePath)).toBe(false);
    } finally {
      (process as { getuid?: () => number }).getuid = original;
    }
  });
});

describe("fetchUsage", () => {
  test("取得成功時に stdout の JSON をキャッシュファイルへ保存して返す", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: JSON.stringify(FIXTURE),
      exitCode: 0,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("fresh");
    expect(result!.data.daily).toHaveLength(3);
    expect(result!.data).toEqual(PROJECTED);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(PROJECTED);
  });

  test("取得失敗時は既存キャッシュへフォールバックする", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: "",
      exitCode: 1,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
    expect(result!.data).toEqual(PROJECTED);
  });

  test("取得失敗かつキャッシュが無い場合は null を返す", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: "",
      exitCode: 1,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("スキーマ不一致の stdout は無効としてキャッシュへフォールバックする", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: JSON.stringify({ error: "invalid output" }),
      exitCode: 0,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
    expect(result!.data).toEqual(PROJECTED);
  });

  test("スキーマ不一致の stdout かつキャッシュが無い場合は null を返す", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: JSON.stringify({ daily: "not-an-array" }),
      exitCode: 0,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("スキーマ不一致のキャッシュは無効として扱う", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, JSON.stringify({ daily: 1, monthly: 2 }));
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: "",
      exitCode: 1,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("キャッシュディレクトリが 0700 でない場合は read 側も fail-closed（偽造キャッシュを配信しない）", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    chmodSync(dirname(cachePath), 0o755);
    writeFileSync(cachePath, JSON.stringify(FIXTURE));
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: "",
      exitCode: 1,
    });

    // 書き込みと同じ安全条件（所有権・0700）を読込みにも適用し、他人に書かれたキャッシュは無視する
    const result = await fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("spawn が例外を投げてもキャッシュがあればフォールバックする", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = async (): Promise<SpawnResult> => {
      throw new Error("command not found");
    };

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
  });

  test("ccusage の引数を spawn に渡す", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const command = ["--json", "--sections", "daily,monthly", "--by-agent"];
    const spawn = async (cmd: string[]): Promise<SpawnResult> => {
      expect(cmd).toEqual(command);
      return { stdout: JSON.stringify(FIXTURE), exitCode: 0 };
    };

    const result = await fetchUsage({ cachePath, spawn, command });

    expect(result!.source).toBe("fresh");
  });
});

describe("spawn デフォルト（stdout 上限）", () => {
  test("巨大な stdout は読み捨てられず、fetchUsage が失敗する（メモリ枯渇防止）", async () => {
    // defaultSpawn は Bun.spawn を使うため、ここでは上限ロジックを持つ関数を直接検証する
    const { readStdoutWithLimit } = await import("./fetch-usage");
    const { ReadableStream } = globalThis;
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    await expect(
      readStdoutWithLimit(reader as ReadableStream<Uint8Array>, 1024 * 1024 + 1),
    ).rejects.toThrow(/too large/i);
  });

  test("上限内の stdout はそのまま返す", async () => {
    const { readStdoutWithLimit } = await import("./fetch-usage");
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    const text = await readStdoutWithLimit(reader as ReadableStream<Uint8Array>, 1024);
    expect(text).toBe("hello");
  });
});
