import { homedir } from "node:os";
import { join } from "node:path";

export const PACKAGE_DIR = join(import.meta.dir, "..");

export interface CachePathEnv {
  XDG_CACHE_HOME?: string;
  HOME?: string;
}

export function defaultCachePath(env: CachePathEnv = {}): string {
  const base = env.XDG_CACHE_HOME ?? join(env.HOME ?? homedir(), ".cache");
  return join(base, "ccusage-ledger", "usage.json");
}
