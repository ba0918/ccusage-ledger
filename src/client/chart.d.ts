interface ChartDatasetConfig {
  label?: string;
  data: (number | null)[];
  backgroundColor?: string | string[];
  borderColor?: string | string[];
  borderWidth?: number;
  fill?: boolean | "origin";
  tension?: number;
  cutout?: string | number;
}

interface ChartData {
  labels: string[];
  datasets: ChartDatasetConfig[];
}

interface ChartOptions {
  responsive?: boolean;
  maintainAspectRatio?: boolean;
  indexAxis?: "x" | "y";
  interaction?: Record<string, unknown>;
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
  update(): void;
  data: ChartData;
  options: ChartOptions;
}

declare const Chart: {
  new (context: HTMLCanvasElement, config: ChartConfig): ChartInstance;
};
