function hasValidEncodedPath(path: string): boolean {
  try {
    decodeURIComponent(path.split(/[?#]/, 1)[0]);
    return true;
  } catch {
    return false;
  }
}
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string {
  if (!/^cherishfire:/i.test(path)) {
    // Other URL schemes retain their existing platform/Router owner.
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.includes("://")) return path;
    return hasValidEncodedPath(path) ? path : "/";
  }
  try {
    const url = new URL(path);
    const route = `${url.host}${url.pathname}`;
    const pathname = route.startsWith("/") ? route : `/${route}`;
    if (!hasValidEncodedPath(pathname)) return "/";
    // Relative paths bypass absolute-URL extraction; the Router query parser
    // then decodes the preserved search parameters exactly once.
    return `${pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
