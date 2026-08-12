// ID から要素を取得する共通ヘルパー。main.ts / charts.ts / table.ts で同じ契約を使う。
// index.html と ID がずれた場合は null に非 null キャストして静かに runtime 例外になるため、
// main() 冒頭の assertElements で欠落を早期検出する
export function el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}
