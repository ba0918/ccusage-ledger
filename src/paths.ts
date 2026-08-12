import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// このファイルがあるディレクトリ。import.meta.dir は Bun 固有のため Node 互換で解決する
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// package.json が存在するディレクトリを起点から親へ遡って探す。
// ソース実行時は src/ の親、バンドル実行時はバンドルが置かれた場所がパッケージルートになる。
// 静的ファイル（index.html / dist / public）はこのディレクトリに同居する
export function resolvePackageDir(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, "package.json"))) { return current; }
    const parent = dirname(current);
    if (parent === current) { return current; }
    current = parent;
  }
}

export const PACKAGE_DIR = resolvePackageDir(MODULE_DIR);

export interface CachePathEnv {
  XDG_CACHE_HOME?: string;
  HOME?: string;
  [key: string]: string | undefined;
}

export function defaultCachePath(env: CachePathEnv = {}): string {
  const base = env.XDG_CACHE_HOME ?? join(env.HOME ?? homedir(), ".cache");
  return join(base, "ccusage-ledger", "usage.json");
}
