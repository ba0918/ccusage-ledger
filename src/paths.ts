import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface UnderBaseOptions {
  // パス区切り。プラットフォーム既定ではなく引数に出すのは、Linux から Windows の挙動を
  // 検証できるようにするため（"/" 決め打ちで Windows の静的配信が全滅した経緯がある）
  separator?: string;
  // Windows のようにパスの大文字小文字を区別しないファイルシステム向け
  caseInsensitive?: boolean;
}

// target が base 自身か、その配下にあるか。区切りを付けて比較するのは
// /foo と /foobar、C:\Users\u と C:\Users\u2 のような前方一致の取り違えを防ぐため。
// 静的配信の脱出防止（server.ts）とキャッシュディレクトリの検証（fetch-usage.ts）が
// 同じ規則を使うため、両方から参照できるこのモジュールに置く
export function isUnderBase(target: string, base: string, options: UnderBaseOptions = {}): boolean {
  const separator = options.separator ?? sep;
  // 末尾の余分な区切りだけを落とす。両方の区切り（"/" と "\\"）を一律に剥がすと、
  // POSIX では "\\" が正当なファイル名文字であるため "/app/dist\\" という名前のファイルが
  // "/app/dist" と一致し、そのディレクトリ外のファイルを配信できてしまう
  const trimTrailing = (path: string): string => {
    let end = path.length;
    while (end > separator.length && path.startsWith(separator, end - separator.length)) {
      end -= separator.length;
    }
    return path.slice(0, end);
  };
  const fold = (path: string): string => {
    const trimmed = trimTrailing(path);
    return options.caseInsensitive ? trimmed.toLowerCase() : trimmed;
  };
  const foldedTarget = fold(target);
  const foldedBase = fold(base);
  return foldedTarget === foldedBase || foldedTarget.startsWith(`${foldedBase}${separator}`);
}

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
