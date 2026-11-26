export function loadImportSites(root?: string, projects?: string[]): Promise<(file: string, text: string,
  onLiteral?: (range: number[], target?: string) => false | void) => Set<string>>;
