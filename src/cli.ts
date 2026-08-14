#!/usr/bin/env node
import { readSync } from "node:fs";

import { messageOf } from "./errors";
import { DEFAULT_COMMAND, fetchUsage } from "./fetch-usage";
import { browserUrl, displayHostname, openBrowser, shouldAutoOpen } from "./open-browser";
import { PACKAGE_DIR, defaultCachePath } from "./paths";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  bindError,
  createApp,
  isLanAllowed,
  isLoopbackHost,
  lanBindWarning,
  lanStartPolicy,
  sshTunnelHint,
  startServer,
} from "./server";
import { projectUsageData } from "./usage-data";

// CLI の関心事（argv の解析・設定値の解決・起動時のコンソール出力）はこのモジュールに集約し、
// server.ts は HTTP アプリと bind に専念する。両者が混ざっていると、オプションを増やすたびに
// HTTP 層のファイルが膨らみ、CLI の都合（プロンプト・process.exit）が server 側へ漏れていく

// 設定値がどこで決まったか。優先順位は CLI オプション > 環境変数 > 既定値
export type OptionSource = "--host" | "--port" | "HOST" | "PORT" | "default";

// 1..65535 の整数文字列のみ受け付ける。Number() 直読みだと PORT=abc が NaN になり、
// bind 失敗が「判りにくいエラー」になるため、設定ミスを起動時に明確なメッセージで報告する。
// source を持ち回るのは、--port で指定したのに "Invalid PORT=..." と言われて
// 原因を取り違えるのを防ぐため
export function parsePort(value: string, source: OptionSource = "PORT"): number {
  const invalid = new Error(`Invalid ${source}=${value}: expected an integer between 1 and 65535`);
  if (!/^\d+$/.test(value)) { throw invalid; }
  const port = Number(value);
  if (port < 1 || port > 65535) { throw invalid; }
  return port;
}

// bind アドレスは IP リテラルまたはホスト名のみ受け付ける。値がそのまま browserUrl →
// openBrowser（xdg-open / open / cmd start への URL 引数）に流れるため、シェルメタ文字や
// URL を壊す文字を事前に弾く（parsePort と対称の設定ミス検出）。
// [A-Za-z0-9.:-] 以外（IPv6 の括弧、シェルメタ文字、空白等）は拒否する。
// 既定値の適用はここでは行わない（resolveHost だけが行う。両方が既定値を持つと
// 「どちらが決めたのか」が読めなくなる）
export function parseHostname(value: string, source: OptionSource = "HOST"): string {
  if (value === "" || !/^[A-Za-z0-9.:-]+$/.test(value)) {
    throw new Error(`Invalid ${source}=${value}: expected an IP literal or hostname (allowed: [A-Za-z0-9.:-])`);
  }
  return value;
}

export interface Resolved<T> {
  value: T;
  source: OptionSource;
}

interface SettingSpec<T> {
  flag: OptionSource;
  env: OptionSource;
  fallback: T;
  parse: (raw: string, source: OptionSource) => T;
}

// 値と「どこで決まったか」を同時に返す。判定と値の計算を分けると両者が食い違い得るため
// （空文字の PORT を「既定値」と判定しながら parsePort("") を呼んで Invalid PORT= で
// 落ちる、という不整合が実際に起きた）、1 箇所で決める。
// host / port で別々に書くと片方だけ直したときに非対称が生まれる（実際 HOST="" は起動不能、
// PORT="" は既定値、という食い違いがあった）ため、解決規則そのものを共通化する
function resolveSetting<T>(
  cliValue: string | undefined,
  envValue: string | undefined,
  spec: SettingSpec<T>,
): Resolved<T> {
  if (cliValue !== undefined) { return { value: spec.parse(cliValue, spec.flag), source: spec.flag }; }
  // 空文字は未設定と同等に扱う（シェルで PORT= / HOST= と書いた場合に起動できないのを避ける）
  if (envValue !== undefined && envValue !== "") { return { value: spec.parse(envValue, spec.env), source: spec.env }; }
  return { value: spec.fallback, source: "default" };
}

export function resolvePort(cliPort: string | undefined, envPort: string | undefined): Resolved<number> {
  return resolveSetting(cliPort, envPort, { flag: "--port", env: "PORT", fallback: DEFAULT_PORT, parse: parsePort });
}

export function resolveHost(cliHost: string | undefined, envHost: string | undefined): Resolved<string> {
  return resolveSetting(cliHost, envHost, { flag: "--host", env: "HOST", fallback: DEFAULT_HOST, parse: parseHostname });
}

// 起動ログに付ける決定元の表示。既定値のときは何も付けない（通常の起動を煩わせない）。
// 「既定を変えたはずなのに違う値で起動している」ときに、環境変数の残存や
// CLI オプションの指定を即座に見分けられるようにする
export function sourceLabel(name: string, source: OptionSource): string {
  if (source === "default") { return ""; }
  return `  (${name} from ${source})`;
}

// LAN 公開の警告・拒否メッセージで「どの指定でそうなったか」を示す（--host と HOST を取り違えない）
export function hostSetting(hostname: string, source: OptionSource): string {
  return source === "default" ? `host ${hostname}` : `${source}=${hostname}`;
}

export interface CliOptions {
  host?: string;
  port?: string;
  help: boolean;
}

// 値を取るオプションの表。名前ごとに分岐を書くと「= 形式の対応漏れ」「次トークンを
// 読み進める処理の漏れ」がオプション追加のたびに再発するため、表にして解析本体は 1 つに保つ。
// --host に短縮形を与えないのは、-h（help）と紛らわしい -H が事故のもとになるため
const VALUE_OPTIONS: Record<string, { key: "host" | "port"; example: string }> = {
  "--host": { key: "host", example: DEFAULT_HOST },
  "--port": { key: "port", example: String(DEFAULT_PORT) },
  "-p": { key: "port", example: String(DEFAULT_PORT) },
};

const FLAG_OPTIONS: Record<string, "help"> = {
  "--help": "help",
  "-h": "help",
};

export const USAGE = `Usage: ccusage-ledger [options]

Options:
      --host <address>  Bind address (default: ${DEFAULT_HOST}, env: HOST)
  -p, --port <number>   Port to listen on (default: ${DEFAULT_PORT}, env: PORT)
  -h, --help            Show this help

Environment:
  HOST                                      Bind address (overridden by --host)
  PORT                                      Port to listen on (overridden by --port)
  CCUSAGE_LEDGER_ALLOW_LAN                  Set to 1 to allow a non-loopback bind
  CCUSAGE_LEDGER_ALLOW_UNVERIFIED_NATIVE    Set to 1 to warn instead of refusing when the
                                            ccusage native binary hash is not recorded`;

// 引数解析。未知のフラグは黙って無視せずエラーにする（打ち間違いに気づけるようにする）。
// --name=value の分解はオプション個別ではなくループ先頭で行う。長いオプション一般の
// 書き方であって特定のオプション固有の性質ではないため、オプションを増やしたときに
// 「= 形式だけ対応が漏れる」事故を構造的に防ぐ
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const equals = arg.indexOf("=");
    const hasInlineValue = arg.startsWith("--") && equals !== -1;
    const name = hasInlineValue ? arg.slice(0, equals) : arg;
    const inlineValue = hasInlineValue ? arg.slice(equals + 1) : undefined;

    const flag = FLAG_OPTIONS[name];
    if (flag !== undefined) {
      // 値を取らないフラグに = で値を付けた場合は黙って無視せず拒否する
      // （--help=json のような指定が「無視された」と気づけないのを防ぐ）
      if (inlineValue !== undefined) {
        throw new Error(`${name} does not take a value`);
      }
      options[flag] = true;
      continue;
    }

    const valueOption = VALUE_OPTIONS[name];
    if (valueOption !== undefined) {
      // 値が別トークンの場合だけ次を読み進める（--port --help のように次がフラグなら拒否する）
      const value = inlineValue ?? argv[i + 1];
      // --port= のように = の後ろが空の場合も「値が無い」として扱う
      if (value === undefined || value === "" || (inlineValue === undefined && value.startsWith("-"))) {
        throw new Error(`${name} requires a value (e.g. ${name} ${valueOption.example})`);
      }
      options[valueOption.key] = value;
      if (inlineValue === undefined) { i++; }
      continue;
    }

    throw new Error(`Unknown option: ${name} (run with --help for usage)`);
  }
  return options;
}

// LAN 公開の確認プロンプト。TTY からの 1 行を読むだけで、読めなければ「No」に倒す（fail-closed）
function confirmLanStart(): boolean {
  const buf = new Uint8Array(64);
  let n = 0;
  try {
    n = readSync(0, buf);
  } catch {
    return false;
  }
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export async function main(): Promise<void> {
  const rootDir = PACKAGE_DIR;
  const cachePath = defaultCachePath(process.env);

  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  // 優先順位はどちらも CLI オプション > 環境変数 > 既定値。指定元をエラーメッセージと起動ログに反映する。
  // bind アドレスは IP リテラル/ホスト名以外を起動時に拒否する（browserUrl → openBrowser に流れるため）。
  // bind 失敗の「判りにくいエラー」より先に、設定ミスを明確なメッセージで報告する
  const { value: port, source: portSource } = resolvePort(cli.port, process.env.PORT);
  const { value: hostname, source: hostSource } = resolveHost(cli.host, process.env.HOST);

  // LAN 公開の判定は解決後のホスト名だけを見る。--host で指定しても HOST で指定しても
  // 同じガード（TTY は確認プロンプト、非 TTY は CCUSAGE_LEDGER_ALLOW_LAN=1 が無ければ拒否）を通す
  const lanPolicy = lanStartPolicy(hostname, Boolean(process.stdin.isTTY), isLanAllowed(process.env));
  // LAN 公開を伝えるすべての経路（refuse / prompt / warn）で決定元を示す。
  // prompt で中止した場合は決定元を含む起動ログまで到達しないため、ここで出さないと
  // 「なぜ LAN 公開になったのか」（シェルプロファイルに残った HOST など）に気付けない
  const setting = hostSetting(hostname, hostSource);
  if (lanPolicy === "refuse") {
    console.error(
      `ERROR: ${setting} (non-loopback bind) would expose the dashboard and usage data to the network. ` +
        "Set CCUSAGE_LEDGER_ALLOW_LAN=1 to override, or use a loopback bind with an SSH tunnel: " +
        sshTunnelHint(port),
    );
    process.exit(1);
  }
  if (lanPolicy === "prompt") {
    const warning = lanBindWarning(hostname, port, setting)!;
    console.warn(warning);
    process.stdout.write("Start anyway? (y/N): ");
    if (!confirmLanStart()) {
      console.error(
        `Aborted. Use a loopback bind (--host ${DEFAULT_HOST}), or set CCUSAGE_LEDGER_ALLOW_LAN=1 to start without confirmation.`,
      );
      process.exit(1);
    }
  } else if (lanPolicy === "warn") {
    console.warn(lanBindWarning(hostname, port, setting)!);
  }

  const app = createApp({ rootDir, cachePath, hostname, port });

  // bind する。Bun 実行時は Bun.serve（requestIP を提供）、Node 実行時は @hono/node-server を使う
  // bind 失敗はランタイムを問わずここで案内文言に変換する（Bun / Node で 2 箇所に散らさない）
  const boundPort = await startServer(app, hostname, port).catch((error: unknown) => {
    throw bindError(error instanceof Error ? error : new Error(String(error)), port);
  });

  // ループバック TCP ポートは同一マシンの全ローカルユーザー/プロセスから閲覧できる。
  // 共有マシンでは他のローカルユーザーが /api/usage の全履歴を読めるため、その旨を起動時に警告する
  // （認証は意図的に実装していない。境界は「画面に届ける人」の制限で担保する設計。AGENTS.md 参照）
  if (isLoopbackHost(hostname)) {
    console.warn(
      "NOTE: the dashboard is bound to loopback and is readable by any local user/process on this machine. " +
        "On a shared machine this exposes your ccusage usage data to other local users.",
    );
  }

  // bind 後にデータ取得する（最大60s 掛かってもサーバーは起動したまま。取得後はメモリの usageBody を更新）。
  // fresh のときだけ usageBody を差し替える。cache フォールバック時は createApp が起動時に
  // 同じ readCache で既に読み込んでいるため、重複読み込み・再設定をしない
  const result = await fetchUsage({ command: DEFAULT_COMMAND, cachePath });
  if (result !== null && result.source === "fresh") {
    app.setUsageBody(JSON.stringify(projectUsageData(result.data)));
  }

  console.log(
    `ccusage ledger: http://${displayHostname(hostname)}:${boundPort}` +
      `${sourceLabel("host", hostSource)}${sourceLabel("port", portSource)}`,
  );
  if (result === null) {
    console.warn("WARN: failed to fetch ccusage data and no cache exists. /api/usage will return an empty dataset.");
  } else {
    console.log(`Data source: ${result.source === "fresh" ? "ccusage cli.js (fresh)" : "cache"}`);
  }

  const autoOpenEnv = {
    SSH_CONNECTION: process.env.SSH_CONNECTION,
    SSH_TTY: process.env.SSH_TTY,
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    isTTY: Boolean(process.stdout.isTTY),
    platform: process.platform,
  };
  if (shouldAutoOpen(autoOpenEnv)) {
    openBrowser(browserUrl(hostname, boundPort));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ERROR: ${messageOf(error)}`);
    process.exit(1);
  });
}
