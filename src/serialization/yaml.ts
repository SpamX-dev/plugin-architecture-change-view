import { parseDocument, isAlias, isMap, isScalar, isSeq } from "yaml";

/** Парсер запрещает дубликаты, aliases, нестандартные теги и несколько документов. */
export function parseYaml<T>(text: string, validate: (value: unknown) => T): T {
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, version: "1.2" });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join("; "));
  // Ограничиваем YAML обычными типами данных до преобразования: иначе ключ 1
  // превратится в строку, а .nan потеряет смысл при каноническом JSON-хешировании.
  const inspect = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === "object" && "tag" in node && node.tag &&
        !["str", "int", "float", "bool", "null", "map", "seq"].some((name) => node.tag === "tag:yaml.org,2002:" + name))
      throw new Error("Custom YAML tag");
    if (isAlias(node)) throw new Error("YAML aliases are not allowed");
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error("YAML mapping keys must be strings");
        inspect(pair.key);
        inspect(pair.value);
      }
    } else if (isSeq(node)) node.items.forEach(inspect);
    else if (!isScalar(node) || !["string", "boolean", "number"].includes(typeof node.value) && node.value !== null ||
      typeof node.value === "number" && !Number.isFinite(node.value)) throw new Error("Unsupported YAML value");
  };
  inspect(doc.contents);
  return validate(doc.toJS({ maxAliasCount: 0 }));
}

/** Decodes persisted records before format-specific integrity checks. */
export function parseReportYaml<T = unknown>(text: string): T {
  return parseYaml(text, (value) => value as T);
}
