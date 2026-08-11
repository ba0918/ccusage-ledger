import type { UsageData } from "../types";
import { isUsageData } from "../usage-data";

export async function loadUsageData(
  embedded: unknown,
  fetchFromApi: () => Promise<UsageData>,
): Promise<UsageData> {
  if (isUsageData(embedded)) return embedded;
  return fetchFromApi();
}
