export interface ModelBreakdown {
  modelName: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AgentBreakdown {
  agent: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

export interface PeriodEntry {
  period: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
  metadata?: { agents?: string[] };
  agents?: AgentBreakdown[];
  device?: string;
}

export interface Totals {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface UsageData {
  daily?: PeriodEntry[];
  weekly?: PeriodEntry[];
  monthly?: PeriodEntry[];
  totals?: Totals;
  device?: string;
}
