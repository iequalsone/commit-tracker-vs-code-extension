import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import { ILogService } from "./interfaces/ILogService";
import { IPathUtils } from "./interfaces/IPathUtils";
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
  private readonly pathUtils: IPathUtils;
  private activeFiles: Set<string> = new Set();
  private activeDirectories: Set<string> = new Set();
  private exitHandlerRegistered = false;

  constructor(logService?: ILogService, pathUtils?: IPathUtils) {
    this.logService = logService;
    this.pathUtils = pathUtils!;

    // Set up process exit handler to clean up temp files
    // process.once("exit", () => this.cleanupAllSync());

    // Also try to catch SIGINT, SIGTERM
    process.once("SIGINT", () => {
      this.cleanupAll().finally(() => process.exit(0));
    });

    process.once("SIGTERM", () => {
      this.cleanupAll().finally(() => process.exit(0));
    });

    this.logService?.debug("TempFileManager initialized with auto-cleanup");
    this.registerExitHandler();
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
   * Clean up all active temporary files and directories
   */
  public async cleanupAll(): Promise<void> {
    await this.cleanupFiles();
    await this.cleanupDirectories();
  }

  /**
   * Clean up all active temporary files
   */
  private async cleanupFiles(): Promise<void> {
    const errors: Error[] = [];

    for (const filePath of this.activeFiles) {
      try {
        await fs.unlink(filePath).catch(() => {}); // Ignore errors on individual files
      } catch (error) {
        errors.push(new Error(`Failed to delete ${filePath}: ${error}`));
      }
    }

    this.activeFiles.clear();

    if (errors.length > 0) {
      this.logService?.warn(
        `Errors cleaning up temporary files: ${errors.length} failures`
      );
    }
  }

  /**
   * Clean up all active temporary directories
   */
  private async cleanupDirectories(): Promise<void> {
    const errors: Error[] = [];

    for (const dirPath of this.activeDirectories) {
      try {
        await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {}); // Ignore errors on individual directories
      } catch (error) {
        errors.push(new Error(`Failed to delete ${dirPath}: ${error}`));
      }
    }

    this.activeDirectories.clear();

    if (errors.length > 0) {
      this.logService?.warn(
        `Errors cleaning up temporary directories: ${errors.length} failures`
      );
    }
  }

  /**
   * Synchronous cleanup for process exit
  private cleanupAllSync(): void {
    // Clean up files first
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

  /**
   * Creates a temporary file with the given content
   * @param content Content for the temporary file
   * @param options Options for the temporary file
   * @returns Handle for the temporary file
   */
  public async createTempFile(
    content: string,
    options?: {
      prefix?: string;
      suffix?: string;
      directory?: string;
      mode?: number;
      deleteOnExit?: boolean;
    }
  ): Promise<TempFileHandle> {
    const prefix = options?.prefix || "temp-";
    const suffix = options?.suffix || ".tmp";
    const directory = options?.directory || os.tmpdir();
    const mode = options?.mode || 0o644;
    const deleteOnExit = options?.deleteOnExit !== false; // Default to true

    // Create a unique filename
    const tempFileName = `${prefix}${uuidv4()}${suffix}`;
    const tempFilePath = path.join(directory, tempFileName);

    try {
      // Ensure directory exists
      await fs.mkdir(directory, { recursive: true });

      // Write content to file
      await fs.writeFile(tempFilePath, content, { mode });

      if (deleteOnExit) {
        this.activeFiles.add(tempFilePath);
      }

      this.logService?.debug(`Created temp file: ${tempFilePath}`);

      return {
        path: tempFilePath,
        content,
        async cleanup() {
          try {
            await fs.unlink(tempFilePath);
            return;
          } catch (error) {
            throw new Error(`Failed to clean up temp file: ${error}`);
          }
        },
        async refresh(newContent: string) {
          try {
            await fs.writeFile(tempFilePath, newContent, { mode });
            content = newContent;
            return;
          } catch (error) {
            throw new Error(`Failed to refresh temp file: ${error}`);
          }
        },
      };
    } catch (error) {
      throw new Error(`Failed to create temp file: ${error}`);
    }
  }

  /**
   * Creates a temporary executable script
   * @param content Script content
   * @param options Options for the script
   * @returns Handle for the temporary script
   */
  public async createTempScript(
    content: string,
    options?: {
      prefix?: string;
      suffix?: string;
      directory?: string;
      deleteOnExit?: boolean;
    }
  ): Promise<TempFileHandle> {
    // First create a normal temp file
    const handle = await this.createTempFile(content, {
      prefix: options?.prefix || "script-",
      suffix: options?.suffix || this.pathUtils.getExecutableExtension(),
      directory: options?.directory,
      mode: 0o644,
      deleteOnExit: options?.deleteOnExit,
    });

    // Then make it executable
    await this.pathUtils.makeExecutable(handle.path);

    this.logService?.debug(`Created executable script: ${handle.path}`);

    return handle;
  }

  /**
   * Creates a temporary directory
   * @param options Options for the temporary directory
   * @returns Handle for the temporary directory
   */
  public async createTempDirectory(options?: {
    prefix?: string;
    directory?: string;
    deleteOnExit?: boolean;
  }): Promise<TempDirectoryHandle> {
    const prefix = options?.prefix || "dir-";
    const parentDir = options?.directory || os.tmpdir();
    const deleteOnExit = options?.deleteOnExit !== false; // Default to true

    // Create a unique directory name
    const tempDirName = `${prefix}${uuidv4()}`;
    const tempDirPath = path.join(parentDir, tempDirName);

    try {
      // Create the directory
      await fs.mkdir(tempDirPath, { recursive: true });

      if (deleteOnExit) {
        this.activeDirectories.add(tempDirPath);
      }

      this.logService?.debug(`Created temp directory: ${tempDirPath}`);

      return {
        path: tempDirPath,
        async cleanup() {
          // Recursively delete the directory and contents
          try {
            await fs.rm(tempDirPath, { recursive: true, force: true });
            return;
          } catch (error) {
            throw new Error(`Failed to clean up temp directory: ${error}`);
          }
        },
        async createFile(fileName: string, content: string): Promise<string> {
          const filePath = path.join(tempDirPath, fileName);
          await fs.writeFile(filePath, content);
          return filePath;
        },
        async listFiles(): Promise<string[]> {
          const files = await fs.readdir(tempDirPath);
          return files.map((file) => path.join(tempDirPath, file));
        },
      };
    } catch (error) {
      throw new Error(`Failed to create temp directory: ${error}`);
    }
  }

  /**
   * Register handler to clean up temp files on process exit
   */
  private registerExitHandler(): void {
    if (this.exitHandlerRegistered) {
      return;
    }

    // Handle process exit
    // Handle process exit
    process.on("exit", () => {
      // Sync cleanup since we're exiting
      for (const filePath of this.activeFiles) {
        try {
          fsSync.unlinkSync(filePath);
        } catch {
          // Ignore cleanup errors during exit
        }
      }

      // Note: Can't do recursive directory deletion synchronously easily
      // Best effort for top-level directories
      for (const dirPath of this.activeDirectories) {
        try {
          fsSync.rmdirSync(dirPath);
        } catch {
          // Ignore cleanup errors during exit
        }
      }
    });
    this.exitHandlerRegistered = true;
  }

  /**
   * Dispose of resources
   */
  public async dispose(): Promise<void> {
    await this.cleanupAll();
  }
}
