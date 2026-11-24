import { watch, type FSWatcher, type WatchEventType } from "node:fs";
import path from "node:path";

export interface FileChangeEvent {
  type: WatchEventType;
  /** The OS may signal a change without identifying the affected entry. */
  file: string | null;
}

/** Subscribe recursively to directory changes, watching overlapping roots only once. */
export function watchFileChanges(directories: string[], onChange: (event: FileChangeEvent) => void, onError: (error: Error) => void) {
  const roots = directories.map(directory => path.resolve(directory)).sort((a, b) => a.length - b.length);
  const watched: string[] = [];
  const handles: FSWatcher[] = [];
  const close = () => { for (const handle of handles.splice(0)) handle.close(); };
  try {
    for (const root of roots) {
      if (watched.some(parent => {
        const relative = path.relative(parent, root);
        return !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
      })) continue;
      const watcher = watch(root, { recursive: true, persistent: false }, (type, name) =>
        onChange({ type, file: name ? path.resolve(root, name) : null }));
      watcher.on("error", onError);
      handles.push(watcher);
      watched.push(root);
    }
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}
