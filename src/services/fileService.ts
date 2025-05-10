import * as fs from "fs";
import * as path from "path";
import { Result, success, failure } from "../utils/results";
import { FileSystemService } from "./fileSystemService";
import { IFileSystemService } from "./interfaces/IFileSystemService";

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

/**
 * @deprecated Use FileSystemService.writeFile instead.
 */
export function writeFile(filePath: string, content: string): Promise<void> {
  return fileSystemService.writeFile(filePath, content).then((result) => {
    if (result.isFailure()) {
      throw result.error;
    }
    return undefined;
  });
}

/**
 * @deprecated Use FileSystemService.readFile instead.
 */
export function readFile(filePath: string): Promise<string> {
  return fileSystemService.readFile(filePath).then((result) => {
    if (result.isFailure()) {
      throw result.error;
    }
    return result.value;
  });
}

/**
 * @deprecated Use FileSystemService.exists or FileSystemService.fileExists instead.
 */
export function fileExists(filePath: string): Promise<boolean> {
  return fileSystemService.fileExists(filePath).then((result) => {
    if (result.isFailure()) {
      throw result.error;
    }
    return result.value;
  });
}

/**
 * @deprecated Use FileSystemService.createTempFile instead.
 */
export function createTempFile(
  content: string,
  options?: { prefix?: string; suffix?: string }
): Promise<string> {
  return fileSystemService.createTempFile(content, options).then((result) => {
    if (result.isFailure()) {
      throw result.error;
    }
    return result.value;
  });
}

/**
 * @deprecated Use FileSystemService.createExecutableScript instead.
 */
export function createExecutableScript(
  content: string,
  options?: { prefix?: string; suffix?: string }
): Promise<string> {
  return fileSystemService
    .createExecutableScript(content, options)
    .then((result) => {
      if (result.isFailure()) {
        throw result.error;
      }
      return result.value;
    });
}

/**
 * @deprecated Use FileSystemService.directoryExists instead.
 */
export function directoryExists(dirPath: string): Promise<boolean> {
  return fileSystemService.directoryExists(dirPath).then((result) => {
    if (result.isFailure()) {
      throw result.error;
    }
    return result.value;
  });
}

/**
 * @deprecated Use FileSystemService.deleteFile instead.
 */
export function deleteFile(filePath: string): Promise<void> {
  return fileSystemService.deleteFile(filePath).then((result) => {
    if (result.isFailure()) {
      throw result.error;
    }
    return undefined;
  });
}
