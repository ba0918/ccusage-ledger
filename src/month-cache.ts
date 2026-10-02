import type { UsageData } from "./types";
import { SECTIONS, isUsageData } from "./usage-data";

export interface CacheMetadata {
  version: 1;
  fingerprint: string;
  refreshedAt: number;
  fullAt: number;
}

export function refreshSince(now: Date, metadata: CacheMetadata | undefined, fingerprint: string, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
  if (metadata?.version !== 1 || !Number.isFinite(metadata.fullAt) || !Number.isFinite(metadata.refreshedAt) || metadata.refreshedAt > now.getTime() || metadata.fullAt > metadata.refreshedAt || metadata.fingerprint !== fingerprint || now.getTime() - metadata.fullAt >= 7 * 86400000 || now.getTime() < metadata.fullAt) { return null; }
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")!.value);
  const monthIndex = Number(parts.find((part) => part.type === "month")!.value) - 1;
  const month = new Date(year, monthIndex - 1, 1);
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-01`;
}

export function replaceCoverage(cached: UsageData, fresh: UsageData, since: string): UsageData {
  const result: UsageData = {};
  for (const section of SECTIONS) {
    const boundary = section === "daily" ? since : since.slice(0, 7);
    if ((fresh[section] ?? []).some((entry) => entry.period < boundary)) { throw new Error("ccusage returned records outside refreshed coverage"); }
    result[section] = [...(cached[section] ?? []).filter((entry) => entry.period < boundary), ...(fresh[section] ?? [])];
  }
  if (!isUsageData(result)) { throw new Error("merged usage data exceeds validation limits"); }
  return result;
}
