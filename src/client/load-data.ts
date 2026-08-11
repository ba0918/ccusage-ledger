import type { UsageData } from "../types";
import { isUsageData } from "../usage-data";

export async function loadUsageData(
  embedded: unknown,
  fetchFromApi: () => Promise<unknown>,
): Promise<UsageData> {
  if (isUsageData(embedded)) { return embedded; }
  // /api/usage のレスポンスも検証を通してから使う（型が壊れたデータで描画をクラッシュさせない）
  const fetched = await fetchFromApi();
  if (!isUsageData(fetched)) { throw new Error("invalid usage data from /api/usage"); }
  return fetched;
}
