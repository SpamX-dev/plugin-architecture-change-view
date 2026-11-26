import { createRequire } from "node:module";
import path from "node:path";

/** Use the same TypeScript parser and UTF-16 coordinates as the SCIP indexer. */
async function compiler() {
  return typeof ARCHIVIEW_SCIP_COMPILER === "undefined"
    ? createRequire(createRequire(import.meta.url).resolve("@sourcegraph/scip-typescript"))("typescript")
    : (await import(new URL(ARCHIVIEW_SCIP_COMPILER, import.meta.url).href)).default;
}

export async function loadImportSites(root, projects = []) {
  const ts = await compiler();
  const resolveTarget = root && projectResolver(ts, root, projects);
  return function importSites(file, text, onLiteral) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const sites = new Set();
    let checker;
    function declaration(identifier) {
      if (!checker) {
        // Resolve lexical bindings from the saved source alone, including parameters and imports.
        const options = { allowJs: true, noLib: true, noResolve: true, types: [] };
        const host = { ...ts.createCompilerHost(options), getCurrentDirectory: () => "",
          fileExists: name => name === file, readFile: name => name === file ? text : undefined,
          getSourceFile: name => name === file ? source : undefined, directoryExists: () => false, getDirectories: () => [] };
        checker = ts.createProgram([file], options, host).getTypeChecker();
      }
      return checker.getSymbolAtLocation(identifier)?.declarations?.[0];
    }
    function ambient(identifier, name) {
      if (!ts.isIdentifier(identifier) || identifier.text !== name) return false;
      const binding = declaration(identifier);
      return !binding || Boolean(ts.getCombinedModifierFlags(binding) & ts.ModifierFlags.Ambient);
    }
    const unwrap = expression => expression && ts.skipOuterExpressions(expression);
    const builtin = name => name === "module" || name === "node:module";
    const constant = binding => binding && ts.isVariableDeclaration(binding) && (binding.parent.flags & ts.NodeFlags.Const);
    function builtinImport(binding) {
      const imported = binding && ts.findAncestor(binding, ts.isImportDeclaration);
      return imported && !imported.importClause?.isTypeOnly && !binding.isTypeOnly && builtin(imported.moduleSpecifier.text);
    }
    function commonJsBuiltin(expression) {
      const call = unwrap(expression);
      if (!call || !ts.isCallExpression(call) || !ambient(unwrap(call.expression), "require")) return false;
      const name = unwrap(call.arguments[0]);
      return name && ts.isStringLiteralLike(name) && builtin(name.text);
    }
    function nodeModule(expression) {
      if (!ts.isIdentifier(expression)) return commonJsBuiltin(expression);
      const binding = declaration(expression);
      return builtinImport(binding) && (ts.isNamespaceImport(binding) || ts.isImportClause(binding)) ||
        constant(binding) && commonJsBuiltin(binding.initializer);
    }
    function createRequireFactory(factory) {
      if (ts.isPropertyAccessExpression(factory))
        return factory.name.text === "createRequire" && nodeModule(unwrap(factory.expression));
      if (!ts.isIdentifier(factory)) return false;
      const binding = declaration(factory);
      if (!binding) return false;
      if (ts.isImportSpecifier(binding))
        return (binding.propertyName ?? binding.name).text === "createRequire" && builtinImport(binding);
      if (!ts.isBindingElement(binding) || (binding.propertyName ?? binding.name).text !== "createRequire") return false;
      const variable = binding.parent.parent;
      return constant(variable) && variable.initializer && nodeModule(unwrap(variable.initializer));
    }
    function localLoader(expression) {
      let call = unwrap(expression);
      if (ambient(call, "require")) return true;
      if (ts.isIdentifier(call)) {
        const binding = declaration(call);
        if (!constant(binding)) return false;
        call = unwrap(binding.initializer);
      }
      if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1) return false;
      const base = unwrap(call.arguments[0]);
      const local = ambient(base, "__filename") || ts.isPropertyAccessExpression(base) &&
        ["url", "filename"].includes(base.name.text) && ts.isImportMeta(unwrap(base.expression));
      return local && createRequireFactory(unwrap(call.expression));
    }
    function record(literal, usage, requireMode = false) {
      if (!literal || !ts.isStringLiteralLike(literal)) return;
      const { line, character } = source.getLineAndCharacterOfPosition(literal.getStart(source));
      if (onLiteral) {
        const end = source.getLineAndCharacterOfPosition(literal.end);
        const included = onLiteral(line === end.line ? [line, character, end.character] : [line, character, end.line, end.character],
          resolveTarget?.(file, literal, usage, requireMode));
        if (included === false) return;
      }
      sites.add((line + 1) + ":" + (character + 1));
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isJSDocImportTag(node)) {
        record(node.moduleSpecifier);
      } else if (ts.isExternalModuleReference(node)) {
        record(node.expression);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        // ImportType syntax also covers JSDoc @typedef {import("...").Type}, often omitted by SCIP.
        record(node.argument.literal);
      } else if (ts.isCallExpression(node)) {
        const argument = node.arguments[0];
        const literal = unwrap(argument);
        if (literal && ts.isStringLiteralLike(literal)) {
          const callee = unwrap(node.expression);
          if (callee.kind === ts.SyntaxKind.ImportKeyword) record(literal, argument);
          else if (localLoader(callee)) record(literal, argument, true);
        }
      }
      ts.forEachChild(node, visit);
      node.jsDoc?.forEach(visit);
    }
    visit(source);
    return sites;
  };
}

// The program owns the package scope and implied module format of the file. Type-only imports
// may override that format at a single literal, even when another import uses the same specifier.
function projectResolver(ts, root, projects) {
  const key = file => ts.sys.useCaseSensitiveFileNames ? path.normalize(file) : path.normalize(file).toLowerCase();
  const projectsByFile = new Map();
  const visited = new Set();
  function readProject(configFile) {
    if (visited.has(key(configFile))) return;
    visited.add(key(configFile));
    const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
    if (!parsed) return;
    for (const ref of parsed.projectReferences || []) readProject(ts.resolveProjectReferencePath(ref));
    const project = { parsed };
    for (const file of parsed.fileNames) if (!projectsByFile.has(key(file))) projectsByFile.set(key(file), project);
  }
  return (file, literal, usage, requireMode) => {
    if (!visited.size) {
      for (const config of projects.length ? projects : ["tsconfig.json"]) readProject(path.resolve(root, config));
    }
    const source = path.join(root, file);
    const project = projectsByFile.get(key(source));
    if (!project) return;
    const { fileNames, options, projectReferences } = project.parsed;
    const program = project.program ??= ts.createProgram({ rootNames:fileNames, options, projectReferences });
    const sourceFile = program.getSourceFile(source);
    if (!sourceFile) return;
    const cached = !usage && program.getResolvedModuleFromModuleSpecifier(literal, sourceFile);
    const resolution = cached || ts.resolveModuleName(literal.text, source, options, ts.sys, undefined, undefined,
      requireMode ? ts.ModuleKind.CommonJS : program.getModeForUsageLocation(sourceFile, usage ?? literal));
    const resolved = resolution.resolvedModule;
    return resolved && path.relative(root, resolved.resolvedFileName).split(path.sep).join("/");
  };
}
