export const STATE_DIRECTORY = ".archiview";
export const MODULE_TREE_FILE = STATE_DIRECTORY + "/modules.tree";

/** Unmapped modules use the repository map as their document-location hint. */
export function isModuleDocumentFile(file: string, documentPath: string | undefined) {
  return file === documentPath && file !== MODULE_TREE_FILE;
}
