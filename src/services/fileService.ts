import * as fs from "fs";
import * as path from "path";
import { FileSystemService } from "./fileSystemService";

// Create a singleton FileSystemService for backward compatibility
const fileSystemService = new FileSystemService();

/**
 * @deprecated Use FileSystemService.ensureDirectoryExists instead.
 */
export function ensureDirectoryExists(filePath: string): Promise<void> {
  return fileSystemService.ensureDirectoryExists(filePath).then((result) => {
    if (result.isFailure()) {
      throw result.error;
    }
    return undefined;
  });
}

/**
 * @deprecated Use FileSystemService.appendToFile instead.
 */
export function appendToFile(filePath: string, content: string): Promise<void> {
  return fileSystemService.appendToFile(filePath, content).then((result) => {
    if (result.isFailure()) {
      throw result.error;
    }
    return undefined;
  });
}

/**
 * @deprecated Use FileSystemService.validatePath instead.
 */
export function validatePath(filePath: string): boolean {
  return fileSystemService.validatePath(filePath);
}
