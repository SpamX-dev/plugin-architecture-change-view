export function loadImportSites(): Promise<(file: string, text: string, sideEffect?: (specifier: string, range: number[]) => void) => Set<string>>;
export function sideEffectResolver(root: string, projects: string[]): Promise<(file: string, specifier: string) => string | undefined>;
