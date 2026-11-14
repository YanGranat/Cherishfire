import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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
const imageCodecPlugin = require("../plugins/with-android-image-codecs.js") as ImageCodecPlugin;
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
