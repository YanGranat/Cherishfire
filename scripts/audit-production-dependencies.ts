import assert from "node:assert/strict";
import { withAuditDeadline } from "./fixtures/with-audit-deadline";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

type AuditVia = string | { source?: number; severity?: string };
type AuditReport = {
  auditReportVersion?: number;
  vulnerabilities?: Record<string, { severity?: string; via?: AuditVia[] }>;
  metadata?: {
    vulnerabilities?: Record<string, number>;
  };
};

// Native query decoding and outbound query serialization have separate owners.
// Metro asset metadata uses both filename and Buffer image-size overloads.
const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
type Severity = (typeof SEVERITIES)[number];
interface ReviewedResidual {
  severity: Severity;
  via: readonly (string | number)[];
}
// Reviewed risk is a ceiling; withdrawn findings and lower severities are valid.
const REVIEWED_RESIDUAL_PACKAGES: Readonly<Record<string, ReviewedResidual>> = {
  "@expo/cli": { severity: "moderate", via: ["@expo/config", "@expo/config-plugins", "@expo/metro-config", "@expo/prebuild-config", "glob", "minimatch"] },
  "@expo/config": { severity: "moderate", via: ["@expo/config-plugins", "deepmerge", "glob"] },
  "@expo/config-plugins": { severity: "moderate", via: ["glob", "xcode"] },
  "@expo/fingerprint": { severity: "moderate", via: ["glob", "minimatch"] },
  "@expo/metro-config": { severity: "moderate", via: ["@expo/config", "glob"] },
  "@expo/prebuild-config": { severity: "moderate", via: ["@expo/config", "@expo/config-plugins"] },
  "decode-uri-component": { severity: "high", via: [1_147_955, 1_243_857] },
  deepmerge: { severity: "low", via: [1_243_505] },
  expo: { severity: "moderate", via: ["@expo/cli", "@expo/config", "@expo/config-plugins", "@expo/fingerprint", "@expo/metro-config", "expo-asset", "expo-constants"] },
  "expo-asset": { severity: "moderate", via: ["expo-constants"] },
  "expo-constants": { severity: "moderate", via: ["@expo/config"] },
  "expo-linking": { severity: "moderate", via: ["expo-constants"] },
  "expo-notifications": { severity: "moderate", via: ["expo-constants"] },
  "expo-router": { severity: "high", via: ["expo-constants", "expo-linking", "query-string"] },
  glob: { severity: "moderate", via: [1_244_013, "minimatch"] },
  "image-size": { severity: "high", via: [1_239_765, 1_239_766] },
  minimatch: { severity: "moderate", via: [1_244_623] },
  "query-string": { severity: "high", via: ["decode-uri-component"] },
  uuid: { severity: "moderate", via: [1_119_441] },
  xcode: { severity: "moderate", via: ["uuid"] },
};
const REVIEWED_ADVISORY_SEVERITIES: Readonly<Record<number, Severity>> = {
  1_119_441: "moderate",
  1_147_955: "moderate",
  1_239_765: "high",
  1_239_766: "high",
  1_243_505: "low",
  1_243_857: "high",
  1_244_013: "moderate",
  1_244_623: "moderate",
};

function assertReviewedDependencyReport(report: AuditReport): void {
  assert.equal(report.auditReportVersion, 2, "npm audit must return a versioned vulnerability report");
  assert.ok(report.vulnerabilities && !Array.isArray(report.vulnerabilities) && report.metadata?.vulnerabilities, "npm audit report must include vulnerabilities and metadata");
  const observedCounts: Record<string, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    assert.ok(Object.hasOwn(REVIEWED_RESIDUAL_PACKAGES, name), `unreviewed vulnerable package: ${name}`);
    const reviewed = REVIEWED_RESIDUAL_PACKAGES[name];
    const severity = SEVERITIES.indexOf(entry.severity as Severity);
    assert.ok(severity >= 0 && severity <= SEVERITIES.indexOf(reviewed.severity), `vulnerability severity increased for ${name}`);
    observedCounts[entry.severity!] += 1;
    observedCounts.total += 1;
    assert.ok(Array.isArray(entry.via) && entry.via.length > 0, `npm audit must identify advisory links for ${name}`);
    for (const via of entry.via) {
      if (typeof via === "string") {
        assert.ok(reviewed.via.includes(via) && Object.hasOwn(report.vulnerabilities, via), `unreviewed vulnerable dependency link: ${name} -> ${via}`);
      } else {
        assert.ok(via && typeof via.source === "number" && reviewed.via.includes(via.source), `unreviewed advisory for ${name}`);
        const advisoryLimit = REVIEWED_ADVISORY_SEVERITIES[via.source];
        const advisorySeverity = SEVERITIES.indexOf(via.severity as Severity);
        assert.ok(advisoryLimit && advisorySeverity >= 0 && advisorySeverity <= SEVERITIES.indexOf(advisoryLimit), `advisory severity increased for ${name}:${via.source}`);
      }
    }
  }
  const reportedCounts = report.metadata.vulnerabilities;
  for (const [severity, count] of Object.entries(observedCounts)) {
    assert.equal(reportedCounts[severity], count, `npm audit metadata must match vulnerability entries for ${severity}`);
  }
}

function auditDependencyReportPolicy(): void {
  const reportFor = (vulnerabilities: NonNullable<AuditReport["vulnerabilities"]>, counts: Record<string, number>): AuditReport => ({
    auditReportVersion: 2, vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts, total: Object.keys(vulnerabilities).length } },
  });
  const original = reportFor({ "decode-uri-component": { severity: "high", via: [{ source: 1_243_857, severity: "high" }, { source: 1_147_955, severity: "moderate" }] } }, { high: 1 });
  assertReviewedDependencyReport(original);
  assertReviewedDependencyReport(reportFor({}, {}));
  assertReviewedDependencyReport(reportFor({ "decode-uri-component": { severity: "moderate", via: [{ source: 1_243_857, severity: "moderate" }] } }, { moderate: 1 }));
  assert.throws(() => assertReviewedDependencyReport(reportFor({ "unknown-package": { severity: "low", via: [{ source: 1_243_505, severity: "low" }] } }, { low: 1 })), /unreviewed vulnerable package/);
  assert.throws(() => assertReviewedDependencyReport(reportFor({ "decode-uri-component": { severity: "high", via: [{ source: 9_999_999, severity: "high" }] } }, { high: 1 })), /unreviewed advisory/);
  assert.throws(() => assertReviewedDependencyReport(reportFor({ uuid: { severity: "high", via: [{ source: 1_119_441, severity: "moderate" }] } }, { high: 1 })), /vulnerability severity increased/);
  assert.throws(() => assertReviewedDependencyReport(reportFor({ "decode-uri-component": { severity: "high", via: [{ source: 1_147_955, severity: "high" }] } }, { high: 1 })), /advisory severity increased/);
  assert.throws(() => assertReviewedDependencyReport(reportFor({ uuid: { severity: "moderate", via: [{ source: 1_243_857, severity: "high" }] } }, { moderate: 1 })), /unreviewed advisory/);
  assert.throws(() => assertReviewedDependencyReport(reportFor({ "expo-router": { severity: "moderate", via: ["uuid"] }, uuid: { severity: "moderate", via: [{ source: 1_119_441, severity: "moderate" }] } }, { moderate: 2 })), /unreviewed vulnerable dependency link/);
  const wrongCounts = structuredClone(original);
  wrongCounts.metadata!.vulnerabilities!.high = 0;
  assert.throws(() => assertReviewedDependencyReport(wrongCounts), /metadata must match/);
}

const requireDependency = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "..");

function dependencySource(name: string, relative: string): string {
  return readFileSync(resolve(dirname(requireDependency.resolve(`${name}/package.json`)), relative), "utf8");
}

function callsProperty(source: string, owner: string, method: string): boolean {
  const tree = ts.createSourceFile("dependency.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === owner &&
      node.expression.name.text === method) found = true;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const BUILD_OR_SERIALIZATION_ONLY_PACKAGES = [
  "@expo/cli", "@expo/config", "@expo/config-plugins", "@expo/fingerprint",
  "@expo/metro-config", "@expo/prebuild-config", "deepmerge", "glob", "minimatch",
  "uuid", "xcode", "query-string", "decode-uri-component", "image-size", "metro", "@expo/metro",
];

function auditRuntimeImportBoundary(source: string, fileName: string): void {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === "require") &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.deepEqual(imports.filter(name => BUILD_OR_SERIALIZATION_ONLY_PACKAGES.some(owner => name === owner || name.startsWith(`${owner}/`))), [],
    "a new application/runtime import of a residual build or decoding package needs a reachability review");
}

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? filesIn(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
}

type IncomingQueryParser = (path: string, route: { params?: Record<string, unknown> },
  parseConfig?: Record<string, (value: string) => unknown>, hash?: string) => Record<string, unknown> | undefined;
type SystemPathRedirect = (options: { path: string; initial: boolean }) => string;

async function auditMetroAssetPipeline(): Promise<void> {
  const metroRoot = dirname(requireDependency.resolve("metro/package.json"));
  const metroSource = readFileSync(resolve(metroRoot, "src/Assets.js"), "utf8");
  const { getAssetSize, getAssetData } = requireDependency(resolve(metroRoot, "src/Assets.js"));
  const expoMetroRoot = dirname(requireDependency.resolve("@expo/metro-config/package.json"));
  const { getUniversalAssetData } = requireDependency(resolve(expoMetroRoot, "build/transform-worker/getAssets.js"));
  const images = [...filesIn(resolve(projectRoot, "assets")).filter(file => file.endsWith(".png")),
    requireDependency.resolve("expo-router/assets/unmatched.png")];
  assert.ok(images.length > 1);
  for (const file of images) {
    const bytes = readFileSync(file);
    const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    assert.deepEqual(getAssetSize("png", bytes, "fixture.png"), dimensions);
    const localPath = relative(projectRoot, file);
    const data = await getAssetData(file, localPath, [], "ios", "/assets");
    const first = readFileSync(data.files[0]);
    const logicalDimensions = {
      width: first.readUInt32BE(16) / data.scales[0],
      height: first.readUInt32BE(20) / data.scales[0],
    };
    assert.deepEqual({ width: data.width, height: data.height }, logicalDimensions,
      "Metro's filename-based asset metadata must retain dimensions and scale");
    const universal = await getUniversalAssetData(file, localPath, [], "ios", "/assets");
    assert.deepEqual({ width: universal.width, height: universal.height }, logicalDimensions);
    assert.equal(universal.fileHashes.length, universal.files.length,
      "Expo's installed asset pipeline must hash every resolved asset variant");
    for (const hash of universal.fileHashes) assert.match(hash, /^[a-f\d]{32}$/);
  }
  assert.equal(getAssetSize("wav", Buffer.from("audio"), "fixture.wav"), null);
  assert.throws(() => getAssetSize("png", Buffer.alloc(0), "fixture.png"), /cannot be an empty file/);

  // Metro's normal asset path requires a filename overload; zip-backed files
  // require a Buffer overload. Exercise the actual conditional argument owner.
  const metroRequire = createRequire(resolve(metroRoot, "package.json"));
  const imageModule = metroRequire("image-size");
  const imageSize = typeof imageModule === "function" ? imageModule : imageModule.default;
  const fixture = images[0];
  const bytes = readFileSync(fixture);
  const expected = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const verifyArgumentBranches = async (source: string): Promise<void> => {
    for (const zipBacked of [false, true]) {
      const file = zipBacked ? "/fixture.zip/assets/image.png" : fixture;
      let reads = 0;
      const callable = loadSourceCallableForAudit<(...args: any[]) => Promise<{ width: number; height: number }>>(
        source, "getAssetData", {
          _path: { default: requireDependency("node:path") },
          _pathUtils: requireDependency(resolve(metroRoot, "src/lib/pathUtils.js")),
          isAssetTypeAnImage: () => true,
          getAbsoluteAssetInfo: async () => ({ files: [file], scales: [1], name: "image", type: "png", hash: "fixture" }),
          _fs: { default: { readFileSync(input: string) {
            assert.equal(zipBacked, true, "normal asset metadata must use the filename API");
            assert.equal(input, file);
            reads += 1;
            return bytes;
          } } },
          _imageSize: { default(input: string | Buffer) {
            if (zipBacked) assert.ok(Buffer.isBuffer(input), "zip asset metadata must use the Buffer API");
            else assert.equal(input, file, "normal asset metadata must use the filename API");
            return imageSize(input);
          } },
          applyAssetDataPlugins: async (_plugins: unknown[], data: unknown) => data,
        },
      );
      const data = await callable(fixture, "assets/image.png", [], "ios", "/assets");
      assert.deepEqual({ width: data.width, height: data.height }, expected);
      assert.equal(reads, zipBacked ? 1 : 0);
    }
  };
  await verifyArgumentBranches(metroSource);
  const condition = 'assetInfo.files[0].includes(".zip/")';
  assert.equal(metroSource.split(condition).length, 2);
  for (const replacement of ["true", "false"]) {
    await assert.rejects(() => verifyArgumentBranches(metroSource.replace(condition, replacement)), assert.AssertionError,
      "losing either asset argument overload must violate the actual Metro owner contract");
  }
}

async function auditNativeIngress(Url: typeof URL, parseIncoming: IncomingQueryParser): Promise<void> {
  const source = readFileSync(resolve(projectRoot, "app/+native-intent.tsx"), "utf8");
  const validPath = loadSourceCallableForAudit<(path: string) => boolean>(source, "hasValidEncodedPath", { decodeURIComponent });
  const loadRedirect = (text: string) => loadSourceCallableForAudit<SystemPathRedirect>(text, "redirectSystemPath", { URL: Url, hasValidEncodedPath: validPath });
  const redirect = loadRedirect(source);
  const cases = [
    ["cherishfire://habit/41?q=100%25", "/habit/41?q=100%25", "100%"],
    ["cherishfire:///habit/41?q=%252F#section", "/habit/41?q=%252F#section", "%2F"],
    ["CHERISHFIRE://habit/%34%31?q=Caf%C3%A9", "/habit/%34%31?q=Caf%C3%A9", "Café"],
    ["cherishfire://habit/41?q=%ZZ", "/habit/41?q=%ZZ", "%ZZ"],
    ["/habit/41?q=%ZZ", "/habit/41?q=%ZZ", "%ZZ"],
    ["habit/41?q=%2525", "habit/41?q=%2525", "%25"],
  ] as const;
  const untouched = ["https://example.test/habit/41?q=100%25", "exp://example.test/--/habit/41?q=one",
    "exp+example://expo-development-client/?url=example", "other://provider/item?q=one", "custom_scheme://provider/item"];
  const verifyValues = (rewrite: SystemPathRedirect): void => {
    for (const [input, expected] of cases) assert.equal(rewrite({ path: input, initial: true }), expected,
      "owned links must preserve encoded route, query and hash bytes");
    for (const input of untouched) assert.equal(rewrite({ path: input, initial: false }), input,
      "other native URL schemes must retain their existing owner");
    for (const input of ["cherishfire://habit/%ZZ?q=valid", "/habit/%E0%A4%A?q=%ZZ", "cherishfire://["]) {
      assert.equal(rewrite({ path: input, initial: true }), "/", "malformed paths must resolve without throwing");
    }
  };
  verifyValues(redirect);
  const extracted: { extractExpoPathFromURL?: (prefixes: string[], url: string) => string } = {};
  runInNewContext(dependencySource("expo-router", "build/fork/extractPathFromURL.js"), {
    exports: extracted, URL: Url, decodeURI, decodeURIComponent,
  });
  assert.ok(extracted.extractExpoPathFromURL);
  const extract = extracted.extractExpoPathFromURL;
  const subscribeSource = dependencySource("expo-router", "build/link/linking.js");
  const configSource = dependencySource("expo-router", "build/getLinkingConfig.js");
  for (const promiseInitialUrl of [false, true]) {
    for (const [input, expectedPath, expectedValue] of cases) {
      const events: string[] = [];
      const hook = { redirectSystemPath(options: { path: string; initial: boolean }) {
        events.push(options.initial ? "hook:cold" : "hook:warm");
        return redirect(options);
      } };
      let warmCallback: ((event: { url: string }) => Promise<void>) | undefined;
      let removals = 0;
      const subscribe = loadSourceCallableForAudit<(...args: any[]) => any>(subscribeSource, "subscribe", {
        isExpoGo: false, getRoutesRedirects_1: { applyRedirects: (path: string) => path },
        Linking: { addEventListener(_event: string, callback: typeof warmCallback) {
          warmCallback = callback;
          return { remove() { removals += 1; } };
        } },
      });
      let loads = 0;
      const context = Object.assign(() => hook, { keys: () => ["./+native-intent.tsx"] });
      const getConfig = loadSourceCallableForAudit<(...args: any[]) => any>(configSource, "getLinkingConfig", {
        expo_modules_core_1: { Platform: { OS: "android" } }, getNavigationConfig: () => ({ screens: {} }),
        getRoutesRedirects_1: { applyRedirects: (path: string) => path }, native_1: { getActionFromState() {} },
        linking_1: { subscribe, getInitialURL() {
          events.push("initial-url"); loads += 1;
          return promiseInitialUrl ? Promise.resolve(input) : input;
        } },
      });
      const config = getConfig({}, context, () => ({ segments: [] }), {});
      const first = config.getInitialURL();
      assert.equal(config.getInitialURL(), first, "cold ingress must keep the installed owner's memoized result");
      const cold = await first;
      events.push("extract");
      const incoming = extract([], cold);
      assert.equal(incoming, expectedPath.replace(/^\//, ""), "cold extraction must preserve the intended encoded route");
      events.push("parse");
      assert.equal(parseIncoming(incoming, {})?.q, expectedValue);
      assert.equal(loads, 1);
      assert.deepEqual(events, ["initial-url", "hook:cold", "extract", "parse"],
        "cold normalization must precede absolute-URL extraction for sync and Promise owners");
      events.length = 0;
      let warmValue: unknown;
      const unsubscribe = config.subscribe((url: string) => {
        events.push("extract");
        const path = extract([], url);
        assert.equal(path, expectedPath.replace(/^\//, ""), "warm extraction must preserve the intended encoded route");
        events.push("parse");
        warmValue = parseIncoming(path, {})?.q;
      });
      assert.ok(warmCallback);
      await warmCallback({ url: input });
      assert.equal(warmValue, expectedValue);
      assert.deepEqual(events, ["hook:warm", "extract", "parse"], "warm normalization must precede Router extraction");
      unsubscribe();
      assert.equal(removals, 1);
    }
  }
  for (const [target, replacement] of [
    ['return `${pathname}${url.search}${url.hash}`;', 'return pathname;'],
    ['if (!hasValidEncodedPath(pathname)) return "/";', ""],
    ['if (/^[a-z][a-z\\d+.-]*:/i.test(path) || path.includes("://")) return path;', 'if (true) return "/";'],
  ]) {
    assert.equal(source.split(target).length, 2, "an ingress mutation must select one current source boundary");
    assert.throws(() => verifyValues(loadRedirect(source.replace(target, replacement))), assert.AssertionError,
      "lost URL data, missing path validation and unrelated-scheme rewrites must fail the ingress contract");
  }
}

async function auditInstalledInterop(): Promise<void> {
  for (const file of ["app", "src"].flatMap(root => filesIn(resolve(projectRoot, root))).filter(file => /\.[jt]sx?$/.test(file))) {
    auditRuntimeImportBoundary(readFileSync(file, "utf8"), file);
  }
  for (const [owner, entry] of [["expo", "src/Expo.ts"], ["expo-constants", "build/Constants.js"],
    ["expo-asset", "build/index.js"], ["expo-asset", "build/Asset.js"], ["expo-linking", "build/Linking.js"], ["expo-notifications", "build/index.js"]]) {
    auditRuntimeImportBoundary(dependencySource(owner, entry), entry);
  }
  const routerRoot = dirname(requireDependency.resolve("expo-router/package.json"));
  const expoRoot = dirname(requireDependency.resolve("expo/package.json"));
  const expoUrl = createRequire(resolve(expoRoot, "package.json"))("whatwg-url-without-unicode");
  assert.match(dependencySource("expo", "src/winter/url.ts"), /import \{ URL, URLSearchParams \} from 'whatwg-url-without-unicode'/);
  assert.match(dependencySource("expo", "src/winter/runtime.native.ts"), /install\('URL', \(\) => require\('\.\/url'\)\.URL\)/);
  const incomingSource = dependencySource("expo-router", "build/fork/getStateFromPath-forks.js");
  const parseIncoming = loadSourceCallableForAudit<IncomingQueryParser>(incomingSource, "parseQueryParams", {
    URL: expoUrl.URL, process: { env: { NODE_ENV: "production" } },
  });
  assert.match(incomingSource, /new URL\(path, 'https:\/\/phony\.example'\)\.searchParams/,
    "the incoming Router parser must use the installed Expo URL implementation rather than the residual decoder");
  assert.ok(callsProperty(dependencySource("expo-router", "build/fork/getStateFromPath.js"), "expo", "parseQueryParams"));
  assert.equal(callsProperty(dependencySource("expo-router", "build/fork/getStateFromPath.js"), "queryString", "parse"), false);
  assert.match(dependencySource("expo-router", "build/link/linking.js"), /require\("\.\.\/fork\/getStateFromPath"\)/);
  assert.match(dependencySource("expo-router", "build/getLinkingConfig.js"), /getStateFromPath: \(path, options\) => \{\s*return \(0, linking_1\.getStateFromPath\)/);
  assert.match(dependencySource("expo-router", "build/ExpoRoot.js"), /linking=\{store\.linking\}/);

  const queryString = createRequire(resolve(routerRoot, "package.json"))("query-string");
  const serialize = loadSourceCallableForAudit<(path: string, params: Record<string, unknown>) => string>(
    dependencySource("expo-router", "build/fork/getPathFromState-forks.js"), "appendQueryAndHash", { queryString },
  );
  const path = "/habit/41?tag=one&tag=two&empty=&flag&space=a+b&encoded=%2B&text=%E2%9C%93";
  assert.deepEqual({ ...parseIncoming(path, {}) }, {
    tag: ["one", "two"], empty: "", flag: "", space: "a b", encoded: "+", text: "✓",
  });
  assert.equal(parseIncoming("/habit/41", {}), undefined);
  assert.deepEqual({ ...parseIncoming("/habit/41?id=99&count=2", { params: { id: "41" } }, { count: Number }, "#section") }, { "#": "section", count: 2 });
  assert.deepEqual({ ...parseIncoming("/habit/41?q=%E0%A4%A&literal=%ZZ", {}) }, { q: "\uFFFD\uFFFD%A", literal: "%ZZ" });
  const named = parseIncoming("/habit/41?__proto__=value&constructor=other", {})!;
  assert.equal(Object.getPrototypeOf(named), null);
  assert.equal(named.__proto__, "value");
  assert.equal(named.constructor, "other");
  assert.equal(serialize("/habit/41", { tag: ["a", "b"], empty: "", flag: null, space: "a b", "#": "section" }),
    "/habit/41?tag=a&tag=b&empty=&flag&space=a%20b#section");
  const values = { text: "a&b=c?/#", unicode: "Café", percent: "%FF", slash: "a/b" };
  assert.deepEqual({ ...parseIncoming(serialize("/habit/41", values), {}) }, values);
  await auditNativeIngress(expoUrl.URL, parseIncoming);

  const lock = JSON.parse(readFileSync(resolve(projectRoot, "package-lock.json"), "utf8")) as {
    packages: Record<string, { dependencies?: Record<string, string> }>;
  };
  assert.deepEqual(Object.entries(lock.packages).filter(([, value]) => value.dependencies?.["query-string"]).map(([name]) => name), ["node_modules/expo-router"],
    "a new query-string consumer needs a separate decoder reachability review");
  assert.deepEqual(Object.entries(lock.packages).filter(([, value]) => value.dependencies?.["decode-uri-component"]).map(([name]) => name), ["node_modules/query-string"]);
  assert.deepEqual(Object.entries(lock.packages).filter(([, value]) => value.dependencies?.["image-size"]).map(([name]) => name), ["node_modules/metro"],
    "a new image-size consumer needs a separate asset-parser reachability review");

  const coreRoot = dirname(requireDependency.resolve("@react-navigation/core/package.json"));
  const coreParser = await import(pathToFileURL(resolve(coreRoot, "lib/module/getStateFromPath.js")).href);
  const coreSerializer = await import(pathToFileURL(resolve(coreRoot, "lib/module/getPathFromState.js")).href);
  const config = { screens: { Habit: "habit/:id" } };
  const state = coreParser.getStateFromPath(path, config);
  const roundtrip = coreParser.getStateFromPath(coreSerializer.getPathFromState(state, config), config);
  assert.deepEqual(roundtrip.routes[0].params, state.routes[0].params,
    "the installed core parser and serializer must preserve route and query values");
  assert.equal(state.routes[0].params.id, "41");
  assert.doesNotThrow(() => coreParser.getStateFromPath("/habit/41?q=%E0%A4%A&literal=%ZZ", config));
  assert.equal(callsProperty(dependencySource("@react-navigation/core", "lib/module/getStateFromPath.js"), "queryString", "parse"), true);
  assert.match(dependencySource("@react-navigation/core", "lib/module/getStateFromPath.js"), /from "\.\/queryString\.js"/,
    "core parsing must use its maintained internal parser instead of the residual CJS dependency");

  await auditMetroAssetPipeline();
  const shellQuote = requireDependency("shell-quote");
  assert.deepEqual(shellQuote.parse('echo "a b"'), ["echo", "a b"]);
  assert.equal(shellQuote.quote(["echo", "a b"]), "echo 'a b'");
  assert.throws(() => shellQuote.quote(["echo", { comment: "comment" }, "value\nnext"]), TypeError);
  const postcss = requireDependency("postcss");
  assert.equal(postcss.parse("a{color:red}").first.first.value, "red");
  assert.equal(requireDependency("postcss-selector-parser")().processSync(".a > .b"), ".a > .b");
  for (const owner of ["@expo/plist", "plist"]) {
    const xml = createRequire(requireDependency.resolve(`${owner}/package.json`))("@xmldom/xmldom");
    const document = new xml.DOMParser().parseFromString("<root><value>text</value></root>", "text/xml");
    assert.equal(new xml.XMLSerializer().serializeToString(document), "<root><value>text</value></root>");
  }
  for (const owner of ["@expo/xcpretty", "@istanbuljs/load-nyc-config"]) {
    const yaml = createRequire(requireDependency.resolve(`${owner}/package.json`))("js-yaml");
    assert.deepEqual(yaml.load("name: value\ncount: 2"), { name: "value", count: 2 });
  }
  const forge = requireDependency("node-forge");
  assert.equal(forge.pem.decode(forge.pem.encode({ type: "TEST", body: "a" }))[0].body, "a");
  assert.equal(typeof requireDependency("compression")(), "function");
  assert.equal(new (requireDependency("undici").Headers)({ accept: "application/json" }).get("accept"), "application/json");
}

async function main(): Promise<void> {
  auditDependencyReportPolicy();
  await auditInstalledInterop();

  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error(
      "npm_execpath is unavailable; run this audit through `npm run audit:deps`",
    );
  }

  // Spawning npm.cmd directly is rejected with EINVAL by some current
  // Windows/Node combinations. Run npm's JavaScript entry point with the same
  // Node executable instead; this also avoids a shell and preserves JSON bytes.
  const result = spawnSync(
    process.execPath,
    [npmExecPath, "audit", "--omit=dev", "--json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.error) throw result.error;
  if (!result.stdout.trim()) {
    throw new Error(`npm audit returned no JSON: ${result.stderr.trim()}`);
  }

  const report = JSON.parse(result.stdout) as AuditReport;
  assertReviewedDependencyReport(report);

  console.log(
    "Production dependency audit passed.",
  );
}

void withAuditDeadline(main, "Production dependency audit", 90_000).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
