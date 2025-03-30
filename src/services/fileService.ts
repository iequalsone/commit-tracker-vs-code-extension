import * as fs from "fs";
import * as path from "path";

/**
 * @deprecated Use FileSystemService instead. This service will be removed in a future release.
 */
export function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  return fs.promises.mkdir(dir, { recursive: true }).then(() => undefined);
}

/**
 * @deprecated Use FileSystemService instead. This service will be removed in a future release.
 */
export function appendToFile(filePath: string, content: string): Promise<void> {
  return fs.promises.appendFile(filePath, content);
}

/**
 * @deprecated Use FileSystemService instead. This service will be removed in a future release.
 */
export function validatePath(filePath: string): boolean {
  return path.isAbsolute(filePath) && !filePath.includes("..");
}
