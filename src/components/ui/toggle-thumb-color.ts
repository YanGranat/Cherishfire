const HEX_CHANNEL_PATTERN = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/;

export const TOGGLE_THUMB_ANIMATION_DURATION_MS = 250;
export const LIGHT_TOGGLE_OFF_THUMB_COLOR = "#E0E0E0";
export const DARK_TOGGLE_OFF_THUMB_COLOR = "#CFCFCF";
export const TOGGLE_ON_THUMB_COLOR = "#FFFFFF";

function parseHexChannels(color: string): readonly [number, number, number] {
  const match = HEX_CHANNEL_PATTERN.exec(color.toUpperCase());
  if (!match) return [255, 255, 255];
  return [
    Number.parseInt(match[1], 16),
    Number.parseInt(match[2], 16),
    Number.parseInt(match[3], 16),
  ];
}

export function getToggleThumbColor(
  offColor: string,
  progress: number
): string {
  const boundedProgress = Math.max(0, Math.min(1, progress));
  const from = parseHexChannels(offColor);
  const to = parseHexChannels(TOGGLE_ON_THUMB_COLOR);
  const channels = from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * boundedProgress)
  );
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}
