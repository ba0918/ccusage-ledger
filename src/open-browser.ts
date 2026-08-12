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
  if (env.platform === "darwin") { return true; }
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

export function openBrowser(url: string, options: OpenOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultOpen;
  const command = platform === "darwin" ? "open" : "xdg-open";
  const result = spawn([command, url]);
  if (result.exitCode !== 0) {
    console.warn(`WARN: could not open the browser automatically (${command}). Open it manually: ${url}`);
  }
}
