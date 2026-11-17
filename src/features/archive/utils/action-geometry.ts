export function getArchiveActionGeometry(naturalHeight: number): {
  height: number;
  marginTop: number;
  marginBottom: number;
} {
  const contentHeight =
    Number.isFinite(naturalHeight) && naturalHeight > 0 ? naturalHeight : 25.5;
  const height = Math.max(44, contentHeight);
  const expansion = (height - contentHeight) / 2;
  return { height, marginTop: 8 - expansion, marginBottom: -expansion };
}
