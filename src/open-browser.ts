import { spawnSync } from "node:child_process";
import { isIP } from "node:net";

export interface OpenEnv {
  SSH_CONNECTION?: string;
  SSH_TTY?: string;
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  isTTY?: boolean;
  platform?: string;
}

export function shouldAutoOpen(env: OpenEnv): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) { return false; }
  if (!env.isTTY) { return false; }
  if (env.platform === "darwin" || env.platform === "win32") { return true; }
  if (env.platform === "linux") {
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  }
  return false;
}

// ワイルドカード bind（0.0.0.0 / ::）をブラウザで開けるループバックアドレスに読み替える。
// IPv6 ホストは URL では [..] で括る（::1 を http://:::3000 のような不正 URL にしない）。
// 表示用 URL の組み立て（browserUrl）とサーバーの起動ログで同じ読み替えを使う
export function displayHostname(hostname: string): string {
  if (hostname === "0.0.0.0" || hostname === "::") { return "127.0.0.1"; }
  return isIP(hostname) === 6 ? `[${hostname}]` : hostname;
}

export function browserUrl(hostname: string, port: number): string {
  return `http://${displayHostname(hostname)}:${port}`;
}

export interface OpenOptions {
  platform?: string;
  spawn?: (command: string[]) => { exitCode: number };
}

function defaultOpen(command: string[]): { exitCode: number } {
  // spawnSync の戻り値は status（signal で kill された場合は null）を exitCode として使う
  const result = spawnSync(command[0]!, command.slice(1), { stdio: "ignore" });
  return { exitCode: result.status ?? 1 };
}

// プラットフォーム別のブラウザ起動コマンド。Windows は cmd の start を使う
// （第 2 引数の "" はウィンドウタイトル。省略すると URL がタイトルとして解釈される）。
// browserUrl が生成するのは http://<host>:<port> のみで & や ^ を含まないため、
// cmd のメタ文字によるコマンド分割は起こらない
export function browserCommand(platform: string, url: string): string[] {
  if (platform === "darwin") { return ["open", url]; }
  if (platform === "win32") { return ["cmd", "/c", "start", "", url]; }
  return ["xdg-open", url];
}

export function openBrowser(url: string, options: OpenOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultOpen;
  const command = browserCommand(platform, url);
  const result = spawn(command);
  if (result.exitCode !== 0) {
    console.warn(`WARN: could not open the browser automatically (${command[0]}). Open it manually: ${url}`);
  }
}
