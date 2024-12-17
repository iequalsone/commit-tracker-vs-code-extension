import * as fs from 'fs';
import * as path from 'path';

export function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  return fs.promises.mkdir(dir, { recursive: true }).then(() => undefined);
}

export function appendToFile(filePath: string, content: string): Promise<void> {
  return fs.promises.appendFile(filePath, content);
}

export function validatePath(filePath: string): boolean {
  return path.isAbsolute(filePath) && !filePath.includes('..');
}
