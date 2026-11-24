import { createRequire } from "node:module";
import path from "node:path";

/** Use the same TypeScript parser and UTF-16 coordinates as the SCIP indexer. */
async function compiler() {
  return typeof ARCHIVIEW_SCIP_COMPILER === "undefined"
    ? createRequire(createRequire(import.meta.url).resolve("@sourcegraph/scip-typescript"))("typescript")
    : (await import(new URL(ARCHIVIEW_SCIP_COMPILER, import.meta.url).href)).default;
}

export async function loadImportSites() {
  const ts = await compiler();
  return function importSites(file, text, sideEffect) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    const sites = new Set();
    function record(literal) {
      if (!literal || !ts.isStringLiteralLike(literal)) return;
      const { line, character } = source.getLineAndCharacterOfPosition(literal.getStart(source));
      sites.add((line + 1) + ":" + (character + 1));
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isJSDocImportTag(node)) {
        record(node.moduleSpecifier);
        if (sideEffect && ts.isImportDeclaration(node) && !node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const literal = node.moduleSpecifier;
          const start = source.getLineAndCharacterOfPosition(literal.getStart(source));
          const end = source.getLineAndCharacterOfPosition(literal.end);
          sideEffect(literal.text, start.line === end.line
            ? [start.line, start.character, end.character] : [start.line, start.character, end.line, end.character]);
        }
      } else if (ts.isExternalModuleReference(node)) {
        record(node.expression);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        record(node.argument.literal);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const requireCall = ts.isIdentifier(callee) && callee.text === "require";
        if (callee.kind === ts.SyntaxKind.ImportKeyword || requireCall) record(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
      node.jsDoc?.forEach(visit);
    }
    visit(source);
    return sites;
  };
}

// TypeScript can resolve a side-effect import of a script without exports even when its checker
// provides no symbol for the module literal. Use the importing project's resolution options.
export async function sideEffectResolver(root, projects) {
  const ts = await compiler();
  const key = file => ts.sys.useCaseSensitiveFileNames ? path.normalize(file) : path.normalize(file).toLowerCase();
  const optionsByFile = new Map();
  const visited = new Set();
  function readProject(configFile) {
    if (visited.has(key(configFile))) return;
    visited.add(key(configFile));
    const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
    if (!parsed) return;
    for (const ref of parsed.projectReferences || []) readProject(ts.resolveProjectReferencePath(ref));
    for (const file of parsed.fileNames) {
      if (!optionsByFile.has(key(file))) optionsByFile.set(key(file), parsed.options);
    }
  }
  return (file, specifier) => {
    if (!visited.size) {
      for (const config of projects.length ? projects : ["tsconfig.json"]) readProject(path.resolve(root, config));
    }
    const source = path.join(root, file);
    const options = optionsByFile.get(key(source));
    if (!options) return;
    const mode = ts.getImpliedNodeFormatForFile(source, undefined, ts.sys, options);
    const resolved = ts.resolveModuleName(specifier, source, options, ts.sys, undefined, undefined, mode).resolvedModule;
    return resolved && path.relative(root, resolved.resolvedFileName).split(path.sep).join("/");
  };
}
