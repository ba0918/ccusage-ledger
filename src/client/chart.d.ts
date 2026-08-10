interface ChartDatasetConfig {
  label: string;
  data: (number | null)[];
  backgroundColor?: string | string[];
  borderColor?: string;
  fill?: boolean | "origin";
}

interface ChartData {
  labels: string[];
  datasets: ChartDatasetConfig[];
}

interface ChartOptions {
  responsive?: boolean;
  maintainAspectRatio?: boolean;
  scales?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
}

interface ChartConfig {
  type: string;
  data: ChartData;
  options?: ChartOptions;
}

interface ChartInstance {
  destroy(): void;
}

declare const Chart: {
  new (context: HTMLCanvasElement, config: ChartConfig): ChartInstance;
};
