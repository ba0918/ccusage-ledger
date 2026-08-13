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
  // Chart.js の click ハンドラ。elements はクリック位置のヒット要素（index = カテゴリ軸の
  // インデックス）。積み上げグラフの棒クリックで期間を特定するために使う
  onClick?: (event: unknown, elements: ReadonlyArray<{ index?: number }>) => void;
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
