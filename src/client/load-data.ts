import type { UsageData } from "../types";

export function isUsageData(value: unknown): value is UsageData {
  if (typeof value !== "object" || value === null) return false;
  const sections = ["daily", "monthly"];
  return sections.every((section) => Array.isArray((value as Record<string, unknown>)[section]));
}

export async function loadUsageData(
  embedded: unknown,
  fetchFromApi: () => Promise<UsageData>,
): Promise<UsageData> {
  if (isUsageData(embedded)) return embedded;
  return fetchFromApi();
}
