import * as fs from "fs";
import * as path from "path";
import { IFileSystemService } from "./interfaces/IFileSystemService";
import { ILogService } from "./interfaces/ILogService";
import { Result, success, failure } from "../utils/results";

/**
 * Default implementation of IFileSystemService using Node.js fs module
 */
export class FileSystemService implements IFileSystemService {
  private readonly logService?: ILogService;
  private readonly cacheEnabled: boolean;
  private readonly cacheExpiryMs: number;
  private readonly fileCache: Map<
    string,
    { content: string; timestamp: number }
  >;

  /**
   * Creates a new FileSystemService
   * @param options Configuration options for the service
   */
  constructor(options?: {
    logService?: ILogService;
    cacheEnabled?: boolean;
    cacheExpiryMs?: number;
  }) {
    this.logService = options?.logService;
    this.cacheEnabled = options?.cacheEnabled ?? false;
    this.cacheExpiryMs = options?.cacheExpiryMs ?? 5000; // 5 seconds default cache expiry
    this.fileCache = new Map();

    this.logService?.debug("FileSystemService initialized", {
      cacheEnabled: this.cacheEnabled,
      cacheExpiryMs: this.cacheExpiryMs,
    });
  }

  /**
   * Read a file from the file system
   * @param filePath Path to the file
   * @returns Result containing the file content or an error
   */
  public async readFile(filePath: string): Promise<Result<string, Error>> {
    try {
      this.logService?.debug(`Reading file: ${filePath}`);

      // Security check
      if (!this.validatePath(filePath)) {
        return failure(new Error(`Invalid file path: ${filePath}`));
      }

      // Check cache if enabled
      if (this.cacheEnabled) {
        const cached = this.fileCache.get(filePath);
        const now = Date.now();

        if (cached && now - cached.timestamp < this.cacheExpiryMs) {
          this.logService?.debug(`Cache hit for file: ${filePath}`);
          return success(cached.content);
        }
      }

      // Read file
      const content = await fs.promises.readFile(filePath, "utf-8");

      // Cache the result if caching is enabled
      if (this.cacheEnabled) {
        this.fileCache.set(filePath, { content, timestamp: Date.now() });
      }

      return success(content);
    } catch (error) {
      this.logService?.error(`Error reading file: ${filePath}`, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Write content to a file
   * @param filePath Path to the file
   * @param content Content to write
   * @param options Optional write options
   * @returns Result indicating success or failure
   */
  public async writeFile(
    filePath: string,
    content: string,
    options?: {
      encoding?: string;
      mode?: number;
      flag?: string;
      atomic?: boolean;
    }
  ): Promise<Result<void, Error>> {
    try {
      this.logService?.debug(`Writing to file: ${filePath}`);

      // Security check
      if (!this.validatePath(filePath)) {
        return failure(new Error(`Invalid file path: ${filePath}`));
      }

      // Ensure the directory exists
      const dirResult = await this.ensureDirectoryExists(
        path.dirname(filePath)
      );
      if (dirResult.isFailure()) {
        return failure(dirResult.error);
      }

      // Atomic write operation if requested
      if (options?.atomic) {
        const tempPath = `${filePath}.tmp.${Date.now()}`;

        // Write to temp file first
        await fs.promises.writeFile(tempPath, content, {
          encoding: options.encoding as BufferEncoding,
          mode: options.mode,
          flag: options.flag,
        });

        // Rename to target file (atomic on most file systems)
        await fs.promises.rename(tempPath, filePath);

        // Invalidate cache if caching is enabled
        if (this.cacheEnabled) {
          this.fileCache.delete(filePath);
        }

        return success(undefined);
      }

      // Regular write
      await fs.promises.writeFile(filePath, content, {
        encoding: options?.encoding as BufferEncoding,
        mode: options?.mode,
        flag: options?.flag,
      });

      // Invalidate cache if caching is enabled
      if (this.cacheEnabled) {
        this.fileCache.delete(filePath);
      }

      return success(undefined);
    } catch (error) {
      this.logService?.error(`Error writing file: ${filePath}`, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Append content to a file
   * @param filePath Path to the file
   * @param content Content to append
   * @returns Result indicating success or failure
   */
  public async appendToFile(
    filePath: string,
    content: string
  ): Promise<Result<void, Error>> {
    try {
      this.logService?.debug(`Appending to file: ${filePath}`);

      // Security check
      if (!this.validatePath(filePath)) {
        return failure(new Error(`Invalid file path: ${filePath}`));
      }

      // Ensure the directory exists
      const dirResult = await this.ensureDirectoryExists(
        path.dirname(filePath)
      );
      if (dirResult.isFailure()) {
        return failure(dirResult.error);
      }

      await fs.promises.appendFile(filePath, content);

      // Invalidate cache if caching is enabled
      if (this.cacheEnabled) {
        this.fileCache.delete(filePath);
      }

      return success(undefined);
    } catch (error) {
      this.logService?.error(`Error appending to file: ${filePath}`, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Check if a file exists
   * @param filePath Path to the file
   * @returns Result indicating if file exists
   */
  public async fileExists(filePath: string): Promise<Result<boolean, Error>> {
    try {
      this.logService?.debug(`Checking if file exists: ${filePath}`);

      // Security check
      if (!this.validatePath(filePath)) {
        return failure(new Error(`Invalid file path: ${filePath}`));
      }

      try {
        const stats = await fs.promises.stat(filePath);
        return success(stats.isFile());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return success(false);
        }
        throw e;
      }
    } catch (error) {
      this.logService?.error(
        `Error checking if file exists: ${filePath}`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Check if a directory exists
   * @param dirPath Path to the directory
   * @returns Result indicating if directory exists
   */
  public async directoryExists(
    dirPath: string
  ): Promise<Result<boolean, Error>> {
    try {
      this.logService?.debug(`Checking if directory exists: ${dirPath}`);

      // Security check
      if (!this.validatePath(dirPath)) {
        return failure(new Error(`Invalid directory path: ${dirPath}`));
      }

      try {
        const stats = await fs.promises.stat(dirPath);
        return success(stats.isDirectory());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return success(false);
        }
        throw e;
      }
    } catch (error) {
      this.logService?.error(
        `Error checking if directory exists: ${dirPath}`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Ensure a directory exists, creating it if necessary
   * @param dirPath Path to the directory
   * @returns Result indicating success or failure
   */
  public async ensureDirectoryExists(
    dirPath: string
  ): Promise<Result<void, Error>> {
    try {
      this.logService?.debug(`Ensuring directory exists: ${dirPath}`);

      // Security check
      if (!this.validatePath(dirPath)) {
        return failure(new Error(`Invalid directory path: ${dirPath}`));
      }

      await fs.promises.mkdir(dirPath, { recursive: true });
      return success(undefined);
    } catch (error) {
      this.logService?.error(
        `Error ensuring directory exists: ${dirPath}`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Delete a file
   * @param filePath Path to the file
   * @returns Result indicating success or failure
   */
  public async deleteFile(filePath: string): Promise<Result<void, Error>> {
    try {
      this.logService?.debug(`Deleting file: ${filePath}`);

      // Security check
      if (!this.validatePath(filePath)) {
        return failure(new Error(`Invalid file path: ${filePath}`));
      }

      await fs.promises.unlink(filePath);

      // Invalidate cache if caching is enabled
      if (this.cacheEnabled) {
        this.fileCache.delete(filePath);
      }

      return success(undefined);
    } catch (error) {
      this.logService?.error(`Error deleting file: ${filePath}`, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Delete a directory and its contents
   * @param dirPath Path to the directory
   * @param recursive Whether to recursively delete contents
   * @returns Result indicating success or failure
   */
  public async deleteDirectory(
    dirPath: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<Result<void, Error>> {
    try {
      this.logService?.debug(`Deleting directory: ${dirPath}`, options);

      // Security check
      if (!this.validatePath(dirPath)) {
        return failure(new Error(`Invalid directory path: ${dirPath}`));
      }

      await fs.promises.rm(dirPath, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });

      // Clear cache entries for this directory if caching is enabled
      if (this.cacheEnabled) {
        for (const [key] of this.fileCache) {
          if (key.startsWith(dirPath)) {
            this.fileCache.delete(key);
          }
        }
      }

      return success(undefined);
    } catch (error) {
      this.logService?.error(`Error deleting directory: ${dirPath}`, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * List directory contents
   * @param dirPath Path to the directory
   * @returns Result containing array of file names
   */
  public async listDirectory(
    dirPath: string
  ): Promise<Result<string[], Error>> {
    try {
      this.logService?.debug(`Listing directory: ${dirPath}`);

      // Security check
      if (!this.validatePath(dirPath)) {
        return failure(new Error(`Invalid directory path: ${dirPath}`));
      }

      const files = await fs.promises.readdir(dirPath);
      return success(files);
    } catch (error) {
      this.logService?.error(`Error listing directory: ${dirPath}`, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Create a temporary file with the given content
   * @param content File content
   * @param options Options for creating the temp file
   * @returns Result containing the path to the temporary file
   */
  public async createTempFile(
    content: string,
    options?: { prefix?: string; suffix?: string; mode?: number }
  ): Promise<Result<string, Error>> {
    try {
      const os = require("os");
      const prefix = options?.prefix || "commit-tracker-";
      const suffix = options?.suffix || ".tmp";
      const tmpdir = os.tmpdir();

      // Create a unique filename
      const fileName = `${prefix}${Date.now()}-${Math.round(
        Math.random() * 10000
      )}${suffix}`;
      const filePath = path.join(tmpdir, fileName);

      this.logService?.debug(`Creating temporary file: ${filePath}`);

      // Write the content
      await fs.promises.writeFile(filePath, content, {
        mode: options?.mode || 0o600, // Secure default permissions
      });

      return success(filePath);
    } catch (error) {
      this.logService?.error("Error creating temporary file", error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Create an executable script file with the given content
   * @param content Script content
   * @param options Options for creating the script file
   * @returns Result containing the path to the script file
   */
  public async createExecutableScript(
    content: string,
    options?: { prefix?: string; suffix?: string }
  ): Promise<Result<string, Error>> {
    try {
      const scriptResult = await this.createTempFile(content, {
        prefix: options?.prefix || "commit-tracker-script-",
        suffix: options?.suffix || ".sh",
        mode: 0o755, // rwx for owner, rx for group and others
      });

      if (scriptResult.isFailure()) {
        return failure(scriptResult.error);
      }

      const scriptPath = scriptResult.value;
      this.logService?.debug(`Created executable script: ${scriptPath}`);

      return success(scriptPath);
    } catch (error) {
      this.logService?.error("Error creating executable script", error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Check if a path exists (file or directory)
   * @param pathToCheck Path to check
   * @returns Result indicating if path exists
   */
  public async pathExists(
    pathToCheck: string
  ): Promise<Result<boolean, Error>> {
    try {
      this.logService?.debug(`Checking if path exists: ${pathToCheck}`);

      // Security check
      if (!this.validatePath(pathToCheck)) {
        return failure(new Error(`Invalid path: ${pathToCheck}`));
      }

      try {
        await fs.promises.access(pathToCheck);
        return success(true);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return success(false);
        }
        throw e;
      }
    } catch (error) {
      this.logService?.error(
        `Error checking if path exists: ${pathToCheck}`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get file stats
   * @param filePath Path to the file
   * @returns Result containing file stats
   */
  public async getFileStats(
    filePath: string
  ): Promise<
    Result<
      {
        size: number;
        isFile: boolean;
        isDirectory: boolean;
        modifiedTime: Date;
        createdTime: Date;
      },
      Error
    >
  > {
    try {
      this.logService?.debug(`Getting file stats: ${filePath}`);

      // Security check
      if (!this.validatePath(filePath)) {
        return failure(new Error(`Invalid file path: ${filePath}`));
      }

      const stats = await fs.promises.stat(filePath);
      return success({
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        modifiedTime: new Date(stats.mtime),
        createdTime: new Date(stats.birthtime),
      });
    } catch (error) {
      this.logService?.error(`Error getting file stats: ${filePath}`, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Watch a file or directory for changes
   * @param pathToWatch Path to watch
   * @param listener Function to call when changes occur
   * @returns Result containing an object with a dispose method
   */
  public watchPath(
    pathToWatch: string,
    listener: (event: "change" | "create" | "delete", filePath: string) => void
  ): Result<{ dispose: () => void }, Error> {
    try {
      this.logService?.debug(`Setting up watcher for: ${pathToWatch}`);

      // Security check
      if (!this.validatePath(pathToWatch)) {
        return failure(new Error(`Invalid path: ${pathToWatch}`));
      }

      // Set up file watcher
      const watcher = fs.watch(pathToWatch, (eventType, filename) => {
        this.logService?.debug(
          `Watch event: ${eventType} on ${filename || "unknown"}`
        );

        // Invalidate cache if caching is enabled
        if (this.cacheEnabled && filename) {
          const fullPath = path.join(pathToWatch, filename);
          this.fileCache.delete(fullPath);
        }

        // Map native fs events to our expected event types
        let mappedEvent: "change" | "create" | "delete" = "change";
        if (eventType === "rename") {
          // fs.watch can't directly tell us if it's a create or delete,
          // we're defaulting to "create" here but in a real implementation
          // you might want to check if the file exists
          mappedEvent = "create";
        }

        if (filename) {
          listener(mappedEvent, path.join(pathToWatch, filename));
        }
      });

      // Return an object with a dispose method
      return success({
        dispose: () => {
          this.logService?.debug(`Stopping watcher for: ${pathToWatch}`);
          watcher.close();
        },
      });
    } catch (error) {
      this.logService?.error(
        `Error setting up watcher for: ${pathToWatch}`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Validate that a path is safe (no path traversal)
   * @param pathToValidate Path to validate
   * @returns True if path is valid and safe
   */
  public validatePath(pathToValidate: string): boolean {
    // Check for null or undefined
    if (!pathToValidate) {
      return false;
    }

    // Normalize the path to resolve any . or .. segments
    const normalizedPath = path.normalize(pathToValidate);

    // Check for path traversal attempts
    if (normalizedPath.includes("..")) {
      this.logService?.warn(
        `Path validation failed, possible traversal attempt: ${pathToValidate}`
      );
      return false;
    }

    return true;
  }

  /**
   * Clear the file cache
   */
  public clearCache(): void {
    if (this.cacheEnabled) {
      this.logService?.debug(
        `Clearing file cache, ${this.fileCache.size} entries removed`
      );
      this.fileCache.clear();
    }
  }

  /**
   * Create a normalized path from segments
   * @param segments Path segments to join
   * @returns Normalized path
   */
  public normalizePath(...segments: string[]): string {
    return path.normalize(path.join(...segments));
  }

  /**
   * Clean up resources used by the service
   */
  public dispose(): void {
    this.clearCache();
    this.logService?.debug("FileSystemService disposed");
  }

  /**
   * Check if a path exists (alias for pathExists)
   * @param pathToCheck Path to check
   * @returns Result indicating if path exists
   */
  public async exists(pathToCheck: string): Promise<Result<boolean, Error>> {
    return this.pathExists(pathToCheck);
  }

  /**
   * Ensure a directory exists (alias for ensureDirectoryExists)
   * @param dirPath Path to the directory
   * @returns Result indicating success or failure
   */
  public async ensureDirectory(dirPath: string): Promise<Result<void, Error>> {
    return this.ensureDirectoryExists(dirPath);
  }

  /**
   * List files in a directory
   * @param dirPath Path to the directory
   * @returns Result containing array of file paths
   */
  public async listFiles(dirPath: string): Promise<Result<string[], Error>> {
    try {
      this.logService?.debug(`Listing files in directory: ${dirPath}`);

      // Security check
      if (!this.validatePath(dirPath)) {
        return failure(new Error(`Invalid directory path: ${dirPath}`));
      }

      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(dirPath, entry.name));

      return success(files);
    } catch (error) {
      this.logService?.error(
        `Error listing files in directory: ${dirPath}`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Copy a file from source to destination
   * @param sourcePath Source file path
   * @param destinationPath Destination file path
   * @returns Result indicating success or failure
   */
  public async copyFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<Result<void, Error>> {
    try {
      this.logService?.debug(
        `Copying file from: ${sourcePath} to: ${destinationPath}`
      );

      // Security check
      if (
        !this.validatePath(sourcePath) ||
        !this.validatePath(destinationPath)
      ) {
        return failure(
          new Error(`Invalid file path: ${sourcePath} or ${destinationPath}`)
        );
      }

      // Ensure destination directory exists
      const dirResult = await this.ensureDirectoryExists(
        path.dirname(destinationPath)
      );
      if (dirResult.isFailure()) {
        return failure(dirResult.error);
      }

      await fs.promises.copyFile(sourcePath, destinationPath);

      // Invalidate cache if caching is enabled
      if (this.cacheEnabled) {
        this.fileCache.delete(destinationPath);
      }

      return success(undefined);
    } catch (error) {
      this.logService?.error(
        `Error copying file: ${sourcePath} to ${destinationPath}`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Move a file from source to destination
   * @param sourcePath Source file path
   * @param destinationPath Destination file path
   * @returns Result indicating success or failure
   */
  public async moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<Result<void, Error>> {
    try {
      this.logService?.debug(
        `Moving file from: ${sourcePath} to: ${destinationPath}`
      );

      // Security check
      if (
        !this.validatePath(sourcePath) ||
        !this.validatePath(destinationPath)
      ) {
        return failure(
          new Error(`Invalid file path: ${sourcePath} or ${destinationPath}`)
        );
      }

      // Ensure destination directory exists
      const dirResult = await this.ensureDirectoryExists(
        path.dirname(destinationPath)
      );
      if (dirResult.isFailure()) {
        return failure(dirResult.error);
      }

      await fs.promises.rename(sourcePath, destinationPath);

      // Invalidate cache if caching is enabled
      if (this.cacheEnabled) {
        this.fileCache.delete(sourcePath);
        this.fileCache.delete(destinationPath);
      }

      return success(undefined);
    } catch (error) {
      this.logService?.error(
        `Error moving file: ${sourcePath} to ${destinationPath}`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
