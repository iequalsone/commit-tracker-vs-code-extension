import * as fs from 'fs';
import * as path from 'path';

export function ensureDirectoryExists(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function appendToFile(filePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.appendFile(filePath, content, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function validatePath(filePath: string): boolean {
  return path.isAbsolute(filePath) && !filePath.includes('..');
}
