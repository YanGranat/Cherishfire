export interface YearHeatmapPathGroup {
  color: string;
  path: string;
}

export interface YearHeatmapPathLayout {
  columns: number;
  rows: number;
  height: number;
  groups: YearHeatmapPathGroup[];
}

function appendRoundedRectPath(
  x: number,
  y: number,
  size: number,
  radius: number,
): string {
  const right = x + size;
  const bottom = y + size;
  return [
    `M${x + radius} ${y}`,
    `H${right - radius}`,
    `A${radius} ${radius} 0 0 1 ${right} ${y + radius}`,
    `V${bottom - radius}`,
    `A${radius} ${radius} 0 0 1 ${right - radius} ${bottom}`,
    `H${x + radius}`,
    `A${radius} ${radius} 0 0 1 ${x} ${bottom - radius}`,
    `V${y + radius}`,
    `A${radius} ${radius} 0 0 1 ${x + radius} ${y}`,
    "Z",
  ].join("");
}

/**
 * Converts a row-major cell grid into a bounded set of SVG paths.
 * One path is emitted per used color, so a full year mounts at most
 * nine drawing nodes instead of 365 native Views.
 */
export function buildYearHeatmapPathLayout(args: {
  colors: readonly string[];
  availableWidth: number;
  cellSize: number;
  gap: number;
  radius: number;
}): YearHeatmapPathLayout {
  const { colors, availableWidth, cellSize, gap } = args;
  const columns = Math.max(
    1,
    Math.floor((Math.max(0, availableWidth) + gap) / (cellSize + gap)),
  );
  const rows = colors.length === 0 ? 0 : Math.ceil(colors.length / columns);
  const height =
    rows === 0 ? 0 : rows * cellSize + Math.max(0, rows - 1) * gap;
  const radius = Math.max(0, Math.min(args.radius, cellSize / 2));
  const pathsByColor = new Map<string, string[]>();

  colors.forEach((color, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const path = appendRoundedRectPath(
      column * (cellSize + gap),
      row * (cellSize + gap),
      cellSize,
      radius,
    );
    const paths = pathsByColor.get(color);
    if (paths) paths.push(path);
    else pathsByColor.set(color, [path]);
  });

  return {
    columns,
    rows,
    height,
    groups: Array.from(pathsByColor, ([color, paths]) => ({
      color,
      path: paths.join(""),
    })),
  };
}
