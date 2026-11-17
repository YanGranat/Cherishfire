import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** Execute a current source callable without mounting its platform host. */
export function loadSourceCallableForAudit<T>(
  source: string,
  name: string,
  environment: Record<string, unknown>,
  jsx = false,
): T {
  const tree = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callableText: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        callableText = node.initializer.getText(tree);
      } else if (ts.isCallExpression(node.initializer)) {
        callableText = node.initializer.arguments[0]?.getText(tree);
      }
    } else if (ts.isMethodDeclaration(node) && node.name.getText(tree) === name && node.body) {
      const modifiers = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        ? [ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)] : undefined;
      const expression = ts.factory.createFunctionExpression(
        modifiers, node.asteriskToken, undefined, node.typeParameters,
        node.parameters, node.type, node.body,
      );
      callableText = ts.createPrinter().printNode(ts.EmitHint.Expression, expression, tree);
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      const declaration = ts.factory.updateFunctionDeclaration(
        node,
        node.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword),
        node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, node.body,
      );
      callableText = ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(callableText, `${name} must exist in the current source`);
  const code = ts.transpileModule(`(${callableText})`, {
    fileName: jsx ? "component.tsx" : "component.ts",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;
  return runInNewContext(code, environment) as T;
}
