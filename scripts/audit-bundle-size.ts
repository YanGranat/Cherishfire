import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";

function auditMetroFileBoundary(source: string): void {
  for (const [platformPath, root] of [[path.posix, "/project"], [path.win32, "C:\\project"]] as const) {
    const inherited = /inherited-exclusion/;
    let delegated = 0;
    let defaultsApplied = 0;
    const config = {
      resolver: { sourceExts: [] as string[], blockList: [inherited] },
      server: { rewriteRequestUrl: (url: string) => url, enhanceMiddleware: (middleware: (...args: any[]) => unknown, _server: unknown) => {
        defaultsApplied++;
        return middleware;
      } },
    };
    const module = { exports: {} as typeof config };
    runInNewContext(source, {
      __dirname: root, module, URL,
      require: (name: string) => {
        if (name === "expo/metro-config") return { getDefaultConfig: () => config };
        if (name === "nativewind/metro") return { withNativeWind: (value: unknown) => value };
        if (name === "node:path") return platformPath;
        if (name === "jsc-safe-url") return createRequire(import.meta.url)("jsc-safe-url");
        if (name === "node:fs") return {
          realpathSync: { native: (value: string) =>
            value === platformPath.resolve(root, "assets/linked.png")
              ? platformPath.resolve(root, "temporary_files/example.png")
              : value.replace(/TEMPOR~1/g, "temporary_files"),
          },
          existsSync: (value: string) => !value.endsWith("variant.png"),
        };
        throw new Error(`Unexpected Metro config dependency: ${name}`);
      },
    });
    const patterns = module.exports.resolver.blockList;
    const blocked = (relative: string) => patterns.some((pattern) => pattern.test(platformPath.resolve(root, relative)));
    assert.ok(patterns.some((pattern) => pattern.source === inherited.source), "Metro defaults must remain active");
    assert.ok(blocked("inherited-exclusion/example.png"));
    assert.equal(new Set(patterns.map((pattern) => pattern.flags)).size, 1, "Metro combines exclusions only when their flags match");
    for (const directory of ["workspace", "temporary_files", "local_dev_docs", "artifacts", ".signing"]) {
      assert.ok(blocked(`${directory}/nested/file.json`), "local-only work must not enter Metro's file map");
      const normalizedPath = platformPath.resolve(root, `${directory}/nested/file.json`).replace(/\\/g, "/");
      assert.ok(patterns.some((pattern) => pattern.test(normalizedPath)), "Metro's Windows watcher normalizes paths to POSIX separators");
      assert.ok(blocked(directory));
      assert.equal(blocked(`${directory}_other/file.json`), false);
    }
    for (const file of ["app/index.tsx", "src/features/workspace/example.ts", "src/features/temporary_files/example.ts", "assets/icon.png", "scripts/fixtures/example.json"]) {
      assert.equal(blocked(file), false, "ordinary source and assets must remain resolvable");
    }
    assert.ok(module.exports.resolver.sourceExts.includes("sql"));
    const middleware = module.exports.server.enhanceMiddleware(() => { delegated++; }, {});
    assert.equal(defaultsApplied, 1);
    const request = (url: string, shouldBlock: boolean) => {
      const previous = delegated;
      let ended = false;
      const headers: Record<string, string> = {};
      const response = { statusCode: 200, setHeader: (key: string, value: string) => { headers[key] = value; }, end: () => { ended = true; } };
      middleware({ url }, response, () => {});
      assert.equal(ended, shouldBlock, `unexpected local asset admission: ${url}`);
      assert.equal(delegated, previous + (shouldBlock ? 0 : 1));
      if (shouldBlock) {
        assert.equal(response.statusCode, 404);
        assert.equal(headers["Cache-Control"], "no-store");
      }
    };
    for (const url of [
      "/assets/workspace/example.png",
      "/assets/workspace%2Fexample.png",
      "/assets?unstable_path=workspace%2Fexample.png",
      "/assets/temporary_files/example.png?platform=android",
      "/assets/temporary_files%2Fexample.png",
      "/assets/assets/%2e%2e/temporary_files/example.png",
      "/assets/assets/%2e%2e%2ftemporary_files/example.png",
      "/assets/local_dev_docs/example.pdf",
      "/assets/.signing/example.png",
      "/assets/artifacts/example.png",
      "/assets/assets/linked.png",
      "/assets?unstable_path=temporary_files%2Fexample.png",
      "/assets/?unstable_path=temporary_files%2Fexample.png%3Fplatform%3Dandroid",
      "/assets//&unstable_path=temporary_files%2Fexample.png",
      "/assets\\?unstable_path=temporary_files%2Fexample.png",
      `/assets?unstable_path=${encodeURIComponent(platformPath.resolve(root, "temporary_files/example.png"))}`,
    ]) request(url, true);
    if (platformPath === path.win32) {
      request("/assets/Workspace/example.png", true);
      request("/assets/workspace%5Cexample.png", true);
      request("/assets/Temporary_Files/example.png", true);
      request("/assets/temporary_files%5Cexample.png", true);
      request("/assets/TEMPOR~1/variant.png", true);
    }
    for (const url of ["/assets/assets/icon.png", "/assets/workspace_other/icon.png", "/assets/temporary_files_other/icon.png", "/status", "/index.bundle", "/assets/%invalid", "/assets?unstable_path=assets/icon.png"]) request(url, false);
  }
}
const metroConfigSource = fs.readFileSync("metro.config.js", "utf8");
auditMetroFileBoundary(metroConfigSource);
assert.throws(() => auditMetroFileBoundary(metroConfigSource.replace('"workspace", ', "")), { name: "AssertionError" });
assert.throws(() => auditMetroFileBoundary(metroConfigSource.replace('"temporary_files", ', "")), { name: "AssertionError" });
for (const [target, replacement] of [
  ["if (blockedAsset)", "if (false)"],
  ["fs.realpathSync.native(path.dirname(absolutePath))", "path.dirname(absolutePath)"],
]) {
  assert.ok(metroConfigSource.includes(target));
  assert.throws(() => auditMetroFileBoundary(metroConfigSource.replace(target, replacement)), { name: "AssertionError" });
}

const SOURCE_ROOTS = ["app", "src"];
const ALLOWED_ICON_FAMILIES = new Set([
  "Entypo",
  "FontAwesome6",
  "Ionicons",
  "MaterialIcons",
  "Octicons",
]);

function collectSourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectSourceFiles(fullPath));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}

const failures: string[] = [];
const usedIconFamilies = new Set<string>();

for (const file of SOURCE_ROOTS.flatMap(collectSourceFiles)) {
  const sourceText = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;

    if (moduleName === "@expo/vector-icons") {
      failures.push(`${file}: imports the all-family vector-icons barrel`);
      continue;
    }

    if (moduleName.startsWith("@expo/vector-icons/")) {
      const family = moduleName.slice("@expo/vector-icons/".length);
      usedIconFamilies.add(family);
      if (!ALLOWED_ICON_FAMILIES.has(family)) {
        failures.push(`${file}: unexpected icon font family ${family}`);
      }
    }

    if (moduleName === "date-fns" && !statement.importClause?.isTypeOnly) {
      failures.push(`${file}: imports the date-fns runtime barrel`);
    }

    if (moduleName === "date-fns/locale") {
      failures.push(`${file}: imports every date-fns locale`);
    }
  }
}

for (const family of ALLOWED_ICON_FAMILIES) {
  if (!usedIconFamilies.has(family)) {
    failures.push(`expected icon family is no longer used: ${family}`);
  }
}

const appJson = JSON.parse(fs.readFileSync("app.json", "utf8")) as {
  expo?: { plugins?: unknown[] };
};
if (!appJson.expo?.plugins?.includes("./plugins/with-android-image-codecs")) {
  failures.push("app.json must register the Android image-codec config plugin");
}

const imageCodecPluginSource = fs.readFileSync(
  "plugins/with-android-image-codecs.js",
  "utf8"
);
for (const property of ["expo.gif.enabled", "expo.webp.enabled"]) {
  if (!imageCodecPluginSource.includes(property)) {
    failures.push(`image-codec config plugin does not own ${property}`);
  }
}

type GradleProperty = {
  type: "property";
  key: string;
  value: string;
};
type ImageCodecPlugin = ((config: unknown) => unknown) & {
  applyDisabledImageCodecs: (properties: GradleProperty[]) => void;
};
const imageCodecPlugin = createRequire(import.meta.url)("../plugins/with-android-image-codecs.js") as ImageCodecPlugin;
const codecProperties: GradleProperty[] = [
  { type: "property", key: "expo.gif.enabled", value: "true" },
];
imageCodecPlugin.applyDisabledImageCodecs(codecProperties);
for (const property of ["expo.gif.enabled", "expo.webp.enabled"]) {
  const matches = codecProperties.filter((item) => item.key === property);
  if (matches.length !== 1 || matches[0]?.value !== "false") {
    failures.push(
      `image-codec config plugin must force exactly one false value for ${property}`
    );
  }
}

if (failures.length > 0) {
  throw new Error(`Bundle size audit failed:\n${failures.join("\n")}`);
}

console.log(
  `Bundle size audit passed: ${usedIconFamilies.size} icon families, direct date-fns imports, GIF/WebP decoders disabled.`
);
