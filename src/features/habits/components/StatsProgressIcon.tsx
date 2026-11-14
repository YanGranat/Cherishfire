import React from "react";
import { PixelRatio, View } from "react-native";

interface StatsProgressIconProps {
  progress: number; // 0..1
  size?: number;
  color: string;
  fillColor: string;
}

const BASE_SIZE = 22;
const BAR_BOTTOM_OFFSET = 2;
const BAR_SPECS = [
  { left: 1.6, width: 3.6, height: 6.2 },
  { left: 6.5, width: 3.6, height: 20 },
  { left: 11.4, width: 3.6, height: 11.4 },
  { left: 16.3, width: 3.6, height: 15.1 },
] as const;
const MAX_BAR_HEIGHT = Math.max(...BAR_SPECS.map((bar) => bar.height));

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function StatsProgressIcon({
  progress,
  size = BASE_SIZE,
  color,
  fillColor,
}: StatsProgressIconProps) {
  const clamped = clampProgress(progress);
  const scale = size / BASE_SIZE;
  const fillLevelPx = MAX_BAR_HEIGHT * clamped;
  const borderRadius = PixelRatio.roundToNearestPixel(1.0 * scale);
  const barBottom = PixelRatio.roundToNearestPixel(BAR_BOTTOM_OFFSET * scale);
  const minFillHeight = PixelRatio.roundToNearestPixel(1 * scale);

  return (
    <View style={{ width: size, height: size }}>
      {BAR_SPECS.map((bar, index) => {
        const left = PixelRatio.roundToNearestPixel(bar.left * scale);
        const width = PixelRatio.roundToNearestPixel(bar.width * scale);
        const fullHeight = PixelRatio.roundToNearestPixel(bar.height * scale);
        const rawFillHeight = Math.min(
          fullHeight,
          Math.max(0, fillLevelPx * scale)
        );
        const visibleFillHeight =
          rawFillHeight > 0
            ? Math.min(
                fullHeight,
                Math.max(
                  PixelRatio.roundToNearestPixel(rawFillHeight),
                  minFillHeight
                )
              )
            : 0;

        return (
          <View
            key={index}
            style={{
              position: "absolute",
              left,
              bottom: barBottom,
              width,
              height: fullHeight,
              borderRadius,
              overflow: "hidden",
              backgroundColor: color,
            }}
          >
            {visibleFillHeight > 0 ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: visibleFillHeight,
                  backgroundColor: fillColor,
                }}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
