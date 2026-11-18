const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");
const fs = require("node:fs");
const { toNormalUrl } = require("jsc-safe-url");

const config = getDefaultConfig(__dirname);
config.resolver.sourceExts.push("sql");
const defaultBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(defaultBlockList) ? defaultBlockList : defaultBlockList ? [defaultBlockList] : []),
  ...["workspace", "temporary_files", "local_dev_docs", "artifacts", ".signing"].map((directory) => {
    const absolutePath = path.resolve(__dirname, directory).split(path.sep)
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\\\/]");
    return new RegExp(`^${absolutePath}(?:[\\\\/]|$)`, path.sep === "\\" ? "i" : "");
  }),
].map((pattern) => path.sep === "\\"
  ? new RegExp(pattern.source, [...new Set(pattern.flags + "i")].join(""))
  : pattern);
const defaultEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const enhanced = defaultEnhanceMiddleware
    ? defaultEnhanceMiddleware(middleware, server)
    : middleware;
  return (request, response, next) => {
    let assetPath;
    try {
      const rewritten = config.server.rewriteRequestUrl(toNormalUrl(request.url));
      const normalized = toNormalUrl(rewritten);
      const routedPath = new URL(normalized, "http://localhost").pathname;
      const url = new URL(normalized, "resolve://");
      if (routedPath === "/assets" || routedPath.startsWith("/assets/")) {
        const decodedPath = url.pathname.split("/").map(decodeURIComponent).join("/");
        assetPath = decodedPath.match(/^\/assets\/(.+)$/)?.[1];
        if (!assetPath) assetPath = url.searchParams.get("unstable_path")?.split("?")[0];
      }
    } catch {
      // Malformed URLs retain the server's normal error handling.
    }
    const blocked = (absolutePath) => config.resolver.blockList.some((pattern) => pattern.test(absolutePath));
    let blockedAsset = false;
    if (assetPath) {
      const absolutePath = path.resolve(__dirname, assetPath);
      blockedAsset = blocked(absolutePath);
      if (!blockedAsset) {
        try {
          // Directory aliases also cover requests for density-specific variants.
          blockedAsset = blocked(path.join(fs.realpathSync.native(path.dirname(absolutePath)), path.basename(absolutePath)));
          if (!blockedAsset && fs.existsSync(absolutePath)) blockedAsset = blocked(fs.realpathSync.native(absolutePath));
        } catch {
          blockedAsset = true;
        }
      }
    }
    if (blockedAsset) {
      response.statusCode = 404;
      response.setHeader("Cache-Control", "no-store");
      response.end("Not found");
      return;
    }
    return enhanced(request, response, next);
  };
};
module.exports = withNativeWind(config, { input: "./global.css" });
