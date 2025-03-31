import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import { ILogService } from "./interfaces/ILogService";
import {
  TempFileHandle,
  TempDirectoryHandle,
} from "./interfaces/ITempFileHandles";

/**
 * Manages temporary files and ensures proper cleanup
 */
export class TempFileManager {
  private tempFiles: Set<string> = new Set();
  private tempDirs: Set<string> = new Set();
  private readonly logService?: ILogService;

  constructor(logService?: ILogService) {
    this.logService = logService;

    // Set up process exit handler to clean up temp files
    process.once("exit", () => this.cleanupAllSync());

    // Also try to catch SIGINT, SIGTERM
    process.once("SIGINT", () => {
      this.cleanupAll().finally(() => process.exit(0));
    });

    process.once("SIGTERM", () => {
      this.cleanupAll().finally(() => process.exit(0));
    });

    this.logService?.debug("TempFileManager initialized with auto-cleanup");
  }

  /**
   * Tracks a file for automatic cleanup
   * @param filePath Path to track for cleanup
   */
  public trackFile(filePath: string): void {
    this.tempFiles.add(filePath);
    this.logService?.debug(`Tracking temporary file: ${filePath}`);
  }

  /**
   * Untrack a file (won't be cleaned up automatically)
   * @param filePath File path to untrack
   */
  public untrackFile(filePath: string): void {
    this.tempFiles.delete(filePath);
    this.logService?.debug(`Untracking temporary file: ${filePath}`);
  }

  /**
   * Tracks a directory for automatic cleanup
   * @param dirPath Directory path to track
   */
  public trackDirectory(dirPath: string): void {
    this.tempDirs.add(dirPath);
    this.logService?.debug(`Tracking temporary directory: ${dirPath}`);
  }

  /**
   * Untrack a directory (won't be cleaned up automatically)
   * @param dirPath Directory path to untrack
   */
  public untrackDirectory(dirPath: string): void {
    this.tempDirs.delete(dirPath);
    this.logService?.debug(`Untracking temporary directory: ${dirPath}`);
  }

  /**
   * Generates a temporary file path
   * @param options Options for the temp file path
   * @returns The generated temporary file path
   */
  public generateTempFilePath(options?: {
    prefix?: string;
    suffix?: string;
  }): string {
    const tempDir = os.tmpdir();
    const prefix = options?.prefix || "commit-tracker-";
    const suffix = options?.suffix || "";
    const uniqueId = uuidv4();

    return path.join(tempDir, `${prefix}${uniqueId}${suffix}`);
  }

  /**
   * Generates a temporary directory path
   * @param options Options for the temp directory path
   * @returns The generated temporary directory path
   */
  public generateTempDirectoryPath(options?: { prefix?: string }): string {
    const tempDir = os.tmpdir();
    const prefix = options?.prefix || "commit-tracker-dir-";
    const uniqueId = uuidv4();

    return path.join(tempDir, `${prefix}${uniqueId}`);
  }

  /**
   * Clean up all tracked temporary files and directories
   */
  public async cleanupAll(): Promise<void> {
    const fs = require("fs").promises;

    this.logService?.info(
      `Cleaning up ${this.tempFiles.size} temporary files and ${this.tempDirs.size} directories`
    );

    // Clean up files first
    for (const filePath of this.tempFiles) {
      try {
        await fs.unlink(filePath);
        this.logService?.debug(`Cleaned up temporary file: ${filePath}`);
      } catch (error) {
        this.logService?.error(
          `Failed to clean up temporary file: ${filePath}`,
          error
        );
      }
    }

    // Then clean up directories
    for (const dirPath of this.tempDirs) {
      try {
        await fs.rm(dirPath, { recursive: true, force: true });
        this.logService?.debug(`Cleaned up temporary directory: ${dirPath}`);
      } catch (error) {
        this.logService?.error(
          `Failed to clean up temporary directory: ${dirPath}`,
          error
        );
      }
    }

    // Clear the sets
    this.tempFiles.clear();
    this.tempDirs.clear();

    this.logService?.info("Temporary file cleanup complete");
  }

  /**
   * Synchronous cleanup for process exit
   */
  private cleanupAllSync(): void {
    const fs = require("fs");

    // Clean up files first
    for (const filePath of this.tempFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        // Can't log during exit
      }
    }

    // Then clean up directories
    for (const dirPath of this.tempDirs) {
      try {
        fs.rmdirSync(dirPath, { recursive: true });
      } catch (error) {
        // Can't log during exit
      }
    }
  }
}
