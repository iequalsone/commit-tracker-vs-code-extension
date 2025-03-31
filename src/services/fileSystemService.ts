import * as fs from "fs";
import * as path from "path";
import * as glob from "glob";
import { Result, success, failure } from "../utils/results";
import { debounce } from "../utils/debounce";
import { ILogService } from "./interfaces/ILogService";
import {
  IFileSystemService,
  FileWatcher,
  FileWatcherEvent,
  FileWatcherOptions,
} from "./interfaces/IFileSystemService";
import { TempFileManager } from "./tempFileManager";
import {
  TempFileHandle,
  TempDirectoryHandle,
} from "./interfaces/ITempFileHandles";
import { PathUtils } from "./pathUtils";
import { IPathUtils } from "./interfaces/IPathUtils";

/**
 * Implementation of FileWatcher interface
 */
class FileWatcherImpl implements FileWatcher {
  readonly path: string;
  private fsWatcher: fs.FSWatcher | null;
  private watchers: fs.FSWatcher[] = [];
  private logService?: ILogService;

  constructor(path: string, fsWatcher: fs.FSWatcher, logService?: ILogService) {
    this.path = path;
    this.fsWatcher = fsWatcher;
    this.logService = logService;

    if (fsWatcher) {
      this.watchers.push(fsWatcher);
    }
  }

  /**
   * Adds another watcher to this FileWatcher
   * @param watcher Additional FSWatcher to manage
   */
  addWatcher(watcher: fs.FSWatcher): void {
    this.watchers.push(watcher);
  }

  /**
   * Disposes of all watchers
   */
  dispose(): void {
    this.logService?.debug(`Disposing file watcher for: ${this.path}`);

    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }

    // Clean up all additional watchers
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch (error) {
        this.logService?.error(`Error closing watcher: ${error}`);
      }
    }

    this.watchers = [];
  }
}

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
  private activeWatchers: Map<string, FileWatcherImpl> = new Map();
  private tempFileManager: TempFileManager;
  private readonly pathUtils: IPathUtils;

  /**
   * Creates a new FileSystemService
   * @param options Configuration options for the service
   */
  constructor(options?: {
    logService?: ILogService;
    cacheEnabled?: boolean;
    cacheExpiryMs?: number;
    pathUtils?: IPathUtils;
  }) {
    this.logService = options?.logService;
    this.cacheEnabled = options?.cacheEnabled ?? false;
    this.cacheExpiryMs = options?.cacheExpiryMs ?? 5000; // 5 seconds default cache expiry
    this.fileCache = new Map();

    this.logService?.debug("FileSystemService initialized", {
      cacheEnabled: this.cacheEnabled,
      cacheExpiryMs: this.cacheExpiryMs,
    });

    this.tempFileManager = new TempFileManager(options?.logService);

    // Initialize path utils with provided instance or create a new one
    this.pathUtils =
      options?.pathUtils || new PathUtils({ logService: this.logService });
  }

  // Helper method to join paths using pathUtils
  private joinPaths(...segments: string[]): string {
    return this.pathUtils.join(...segments);
  }

  /**
   * Read a file from the file system
   * @param filePath Path to the file
   * @returns Result containing the file content or an error
   */
  public async readFile(filePath: string): Promise<Result<string, Error>> {
    try {
      const normalizedPath = this.pathUtils.normalize(filePath);

      if (!this.validatePath(normalizedPath)) {
        return failure(new Error(`Invalid path: ${filePath}`));
      }

      // Check cache first if enabled
      if (this.cacheEnabled) {
        const cachedContent = this.getCachedContent(normalizedPath);
        if (cachedContent !== null) {
          return success(cachedContent);
        }
      }

      const content = await fs.promises.readFile(normalizedPath, "utf8");

      // Cache the content if caching is enabled
      if (this.cacheEnabled) {
        this.cacheContent(normalizedPath, content);
      }

      return success(content);
    } catch (error) {
      if (this.logService) {
        this.logService.error(`Failed to read file: ${filePath}`, error);
      }
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
      const normalizedPath = this.pathUtils.normalize(filePath);

      if (!this.validatePath(normalizedPath)) {
        return failure(new Error(`Invalid path: ${filePath}`));
      }

      // Ensure the directory exists
      const dirPath = this.pathUtils.dirname(normalizedPath);
      const dirResult = await this.ensureDirectoryExists(dirPath);
      if (dirResult.isFailure()) {
        return dirResult;
      }

      // Handle atomic write if requested
      if (options?.atomic) {
        const tempFile = await this.createTempFile(content);
        if (tempFile.isFailure()) {
          return failure(tempFile.error);
        }

        await fs.promises.rename(tempFile.value, normalizedPath);
      } else {
        // Regular write
        await fs.promises.writeFile(normalizedPath, content, {
          encoding: (options?.encoding as BufferEncoding) || "utf8",
          mode: options?.mode,
          flag: options?.flag,
        });
      }

      // Update cache if enabled
      if (this.cacheEnabled) {
        this.cacheContent(normalizedPath, content);
      }

      return success(undefined);
    } catch (error) {
      if (this.logService) {
        this.logService.error(`Failed to write file: ${filePath}`, error);
      }
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
      const normalizedPath = this.pathUtils.normalize(dirPath);

      if (!this.validatePath(normalizedPath)) {
        return failure(new Error(`Invalid path: ${dirPath}`));
      }

      await fs.promises.mkdir(normalizedPath, { recursive: true });
      return success(undefined);
    } catch (error) {
      if (this.logService) {
        this.logService.error(
          `Failed to ensure directory exists: ${dirPath}`,
          error
        );
      }
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
      const filePath = this.joinPaths(tmpdir, fileName);

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
    options?: {
      prefix?: string;
      suffix?: string;
      directory?: string;
      mode?: number;
    }
  ): Promise<Result<string, Error>> {
    try {
      const os = require("os");
      const prefix = options?.prefix || "commit-tracker-script-";
      const suffix = options?.suffix || ".sh";
      const mode = options?.mode || 0o755; // rwx for owner, rx for group and others
      const tmpdir = options?.directory || os.tmpdir();

      // Create a unique filename
      const fileName = `${prefix}${Date.now()}-${Math.round(
        Math.random() * 10000
      )}${suffix}`;
      const scriptPath = this.joinPaths(tmpdir, fileName);

      this.logService?.debug(`Creating executable script: ${scriptPath}`);

      // Write the content
      await fs.promises.writeFile(scriptPath, content, { mode });

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
  public async getFileStats(filePath: string): Promise<
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
          const fullPath = this.joinPaths(pathToWatch, filename);
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
          listener(mappedEvent, this.joinPaths(pathToWatch, filename));
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
    return this.pathUtils.isPathSafe(pathToValidate);
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
    return this.pathUtils.normalize(this.joinPaths(...segments));
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
        .map((entry) => this.joinPaths(dirPath, entry.name));

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

  /**
   * Watch a single file for changes
   * @param filePath Path to the file to watch
   * @param listener Function called when file changes
   * @returns FileWatcher that can be disposed
   */
  public watchFile(
    filePath: string,
    listener: (event: FileWatcherEvent) => void
  ): Result<FileWatcher, Error> {
    try {
      this.logService?.debug(`Setting up file watcher for: ${filePath}`);

      // Security check
      if (!this.validatePath(filePath)) {
        return failure(new Error(`Invalid path: ${filePath}`));
      }

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return failure(new Error(`File does not exist: ${filePath}`));
      }

      // Set up the file watcher
      const watcher = fs.watch(filePath, (eventType) => {
        // Map the raw event type to our enum
        let event: FileWatcherEvent = "change";
        if (eventType === "rename") {
          // Check if the file still exists to determine if it was created or deleted
          if (fs.existsSync(filePath)) {
            event = "create";
          } else {
            event = "delete";
          }
        }

        // Notify listener
        listener(event);
      });

      const fileWatcher = new FileWatcherImpl(
        filePath,
        watcher,
        this.logService
      );
      this.activeWatchers.set(filePath, fileWatcher);

      return success(fileWatcher);
    } catch (error) {
      this.logService?.error(`Error setting up file watcher: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Watch a directory for changes
   * @param dirPath Path to the directory
   * @param listener Function called when files change
   * @param options Additional watcher options
   * @returns FileWatcher that can be disposed
   */
  public watchDirectory(
    dirPath: string,
    listener: (event: FileWatcherEvent, filePath: string) => void,
    options?: FileWatcherOptions
  ): Result<FileWatcher, Error> {
    try {
      this.logService?.debug(`Setting up directory watcher for: ${dirPath}`);

      // Security check
      if (!this.validatePath(dirPath)) {
        return failure(new Error(`Invalid path: ${dirPath}`));
      }

      // Check if directory exists
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        return failure(new Error(`Directory does not exist: ${dirPath}`));
      }

      // Set default options
      const watchOptions: Required<FileWatcherOptions> = {
        recursive: options?.recursive ?? false,
        extensions: options?.extensions ?? [],
        exclude: options?.exclude ?? [],
        throttleMs: options?.throttleMs ?? 100,
      };

      // Create throttled listener if throttling is enabled
      const processEvent =
        watchOptions.throttleMs > 0
          ? debounce((event: FileWatcherEvent, filename: string) => {
              const fullPath = this.joinPaths(dirPath, filename);

              // Check extension filter if specified
              if (watchOptions.extensions.length > 0) {
                const ext = path.extname(filename).toLowerCase();
                if (!watchOptions.extensions.includes(ext)) {
                  return;
                }
              }

              // Check exclusion patterns
              if (watchOptions.exclude.length > 0) {
                for (const pattern of watchOptions.exclude) {
                  if (glob.sync(pattern).includes(filename)) {
                    return;
                  }
                }
              }

              listener(event, fullPath);
            }, watchOptions.throttleMs)
          : (event: FileWatcherEvent, filename: string) => {
              const fullPath = this.joinPaths(dirPath, filename);
              listener(event, fullPath);
            };

      // Set up the directory watcher
      const watcher = fs.watch(
        dirPath,
        { recursive: watchOptions.recursive },
        (eventType, filename) => {
          if (!filename) {
            return;
          }

          // Map the raw event type to our enum
          let event: FileWatcherEvent = "change";
          if (eventType === "rename") {
            const fullPath = this.joinPaths(dirPath, filename);
            if (fs.existsSync(fullPath)) {
              event = "create";
            } else {
              event = "delete";
            }
          }

          processEvent(event, filename);
        }
      );

      const dirWatcher = new FileWatcherImpl(dirPath, watcher, this.logService);
      this.activeWatchers.set(dirPath, dirWatcher);

      return success(dirWatcher);
    } catch (error) {
      this.logService?.error(`Error setting up directory watcher: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Watch multiple paths (files or directories)
   * @param paths Array of paths to watch
   * @param listener Function called when any file changes
   * @param options Additional watcher options
   * @returns FileWatcher that can be disposed
   */
  public watchPaths(
    paths: string[],
    listener: (event: FileWatcherEvent, filePath: string) => void,
    options?: FileWatcherOptions
  ): Result<FileWatcher, Error> {
    try {
      if (paths.length === 0) {
        return failure(new Error("No paths provided for watching"));
      }

      this.logService?.debug(`Setting up watchers for ${paths.length} paths`);

      // Setup watcher for the first path
      const firstPath = paths[0];
      let mainWatcher: FileWatcherImpl | null = null;

      const stats = fs.statSync(firstPath);
      if (stats.isDirectory()) {
        const result = this.watchDirectory(firstPath, listener, options);

        if (result.isFailure()) {
          return result;
        }

        mainWatcher = this.activeWatchers.get(firstPath) as FileWatcherImpl;
      } else {
        const result = this.watchFile(firstPath, (event) =>
          listener(event, firstPath)
        );

        if (result.isFailure()) {
          return result;
        }

        mainWatcher = this.activeWatchers.get(firstPath) as FileWatcherImpl;
      }

      // Add watchers for additional paths
      for (let i = 1; i < paths.length; i++) {
        const currentPath = paths[i];

        try {
          const stats = fs.statSync(currentPath);
          let watcher: fs.FSWatcher;

          if (stats.isDirectory()) {
            watcher = fs.watch(
              currentPath,
              { recursive: options?.recursive ?? false },
              (eventType, filename) => {
                if (!filename) {
                  return;
                }

                let event: FileWatcherEvent = "change";
                if (eventType === "rename") {
                  const fullPath = this.joinPaths(currentPath, filename);
                  if (fs.existsSync(fullPath)) {
                    event = "create";
                  } else {
                    event = "delete";
                  }
                }

                listener(event, this.joinPaths(currentPath, filename));
              }
            );
          } else {
            watcher = fs.watch(currentPath, (eventType) => {
              let event: FileWatcherEvent = "change";
              if (eventType === "rename") {
                if (fs.existsSync(currentPath)) {
                  event = "create";
                } else {
                  event = "delete";
                }
              }

              listener(event, currentPath);
            });
          }

          mainWatcher.addWatcher(watcher);
        } catch (error) {
          this.logService?.error(
            `Error watching path ${currentPath}: ${error}`
          );
          // Continue with other paths even if one fails
        }
      }

      return success(mainWatcher);
    } catch (error) {
      this.logService?.error(`Error setting up path watchers: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Creates a temporary file with automatic cleanup
   * @param content File content
   * @param options Options for creating the temp file
   * @returns Result containing the temp file handle with path and cleanup method
   */
  public async createTempFileWithCleanup(
    content: string,
    options?: {
      prefix?: string;
      suffix?: string;
      mode?: number;
      deleteOnExit?: boolean;
    }
  ): Promise<Result<TempFileHandle, Error>> {
    try {
      const tempFilePath = this.tempFileManager.generateTempFilePath({
        prefix: options?.prefix,
        suffix: options?.suffix,
      });

      // Write the file
      const writeResult = await this.writeFile(tempFilePath, content, {
        mode: options?.mode,
        atomic: true, // Use atomic write for safety
      });

      if (writeResult.isFailure()) {
        return failure(writeResult.error);
      }

      // Track for auto-cleanup if requested (default to true)
      const deleteOnExit = options?.deleteOnExit !== false;
      if (deleteOnExit) {
        this.tempFileManager.trackFile(tempFilePath);
      }

      // Create handle with the file path and cleanup function
      const handle: TempFileHandle = {
        path: tempFilePath,
        content,
        cleanup: async () => {
          this.logService?.debug(`Cleaning up temp file: ${tempFilePath}`);
          this.tempFileManager.untrackFile(tempFilePath);
          const deleteResult = await this.deleteFile(tempFilePath);
          if (deleteResult.isFailure()) {
            this.logService?.error(
              `Failed to clean up temp file: ${tempFilePath}`,
              deleteResult.error
            );
          }
        },
        refresh: async (newContent: string) => {
          const refreshResult = await this.writeFile(tempFilePath, newContent, {
            mode: options?.mode,
            atomic: true,
          });

          if (refreshResult.isFailure()) {
            throw refreshResult.error;
          }
        },
      };

      this.logService?.debug(
        `Created temporary file with auto-cleanup: ${tempFilePath}`
      );
      return success(handle);
    } catch (error) {
      this.logService?.error(
        `Error creating temporary file with cleanup`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Creates a temporary directory with automatic cleanup
   * @param options Options for creating the temp directory
   * @returns Result containing the temp directory handle with path and cleanup method
   */
  public async createTempDirectoryWithCleanup(options?: {
    prefix?: string;
    deleteOnExit?: boolean;
  }): Promise<Result<TempDirectoryHandle, Error>> {
    try {
      const tempDirPath = this.tempFileManager.generateTempDirectoryPath({
        prefix: options?.prefix,
      });

      // Create the directory
      const createDirResult = await this.ensureDirectory(tempDirPath);
      if (createDirResult.isFailure()) {
        return failure(createDirResult.error);
      }

      // Track for auto-cleanup if requested (default to true)
      const deleteOnExit = options?.deleteOnExit !== false;
      if (deleteOnExit) {
        this.tempFileManager.trackDirectory(tempDirPath);
      }

      // Create handle with the directory path and cleanup function
      const handle: TempDirectoryHandle = {
        path: tempDirPath,
        cleanup: async () => {
          this.logService?.debug(`Cleaning up temp directory: ${tempDirPath}`);
          this.tempFileManager.untrackDirectory(tempDirPath);
          const deleteResult = await this.deleteDirectory(tempDirPath, {
            recursive: true,
            force: true,
          });
          if (deleteResult.isFailure()) {
            this.logService?.error(
              `Failed to clean up temp directory: ${tempDirPath}`,
              deleteResult.error
            );
          }
        },
        createFile: async (
          fileName: string,
          content: string
        ): Promise<string> => {
          const filePath = this.joinPaths(tempDirPath, fileName);
          const writeResult = await this.writeFile(filePath, content, {
            atomic: true,
          });
          if (writeResult.isFailure()) {
            throw writeResult.error;
          }
          return filePath;
        },
        listFiles: async (): Promise<string[]> => {
          const listResult = await this.listFiles(tempDirPath);
          if (listResult.isFailure()) {
            throw listResult.error;
          }
          return listResult.value;
        },
      };

      this.logService?.debug(
        `Created temporary directory with auto-cleanup: ${tempDirPath}`
      );
      return success(handle);
    } catch (error) {
      this.logService?.error(
        `Error creating temporary directory with cleanup`,
        error
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Create a temporary operation script with automatic cleanup
   * @param content Script content
   * @param options Options for creating the script
   * @returns Result containing the script handle
   */
  public async createTempScriptWithCleanup(
    content: string,
    options?: {
      prefix?: string;
      suffix?: string;
      mode?: number;
      deleteOnExit?: boolean;
    }
  ): Promise<Result<TempFileHandle, Error>> {
    // Default to .sh extension on Unix/Mac, .cmd on Windows
    const isWindows = process.platform === "win32";
    const defaultSuffix = isWindows ? ".cmd" : ".sh";
    const suffix = options?.suffix || defaultSuffix;

    // Default executable mode for scripts (rwxr-xr-x)
    const defaultMode = 0o755;
    const mode = options?.mode || defaultMode;

    // Create with executable permissions
    return this.createTempFileWithCleanup(content, {
      prefix: options?.prefix || "commit-tracker-script-",
      suffix,
      mode,
      deleteOnExit: options?.deleteOnExit,
    });
  }

  /**
   * Clean up all tracked temporary files and directories
   */
  public async cleanupAllTempFiles(): Promise<Result<void, Error>> {
    try {
      await this.tempFileManager.cleanupAll();
      return success(undefined);
    } catch (error) {
      this.logService?.error("Failed to clean up temporary files", error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get cached content for a file if available and not expired
   * @param filePath Path to the file
   * @returns Cached content or null if not cached or expired
   */
  private getCachedContent(filePath: string): string | null {
    if (!this.cacheEnabled) {
      return null;
    }

    const cached = this.fileCache.get(filePath);
    if (!cached) {
      return null;
    }

    // Check if cache entry has expired
    const now = Date.now();
    if (now - cached.timestamp > this.cacheExpiryMs) {
      this.fileCache.delete(filePath);
      return null;
    }

    return cached.content;
  }

  /**
   * Cache content for a file
   * @param filePath Path to the file
   * @param content File content to cache
   */
  private cacheContent(filePath: string, content: string): void {
    if (!this.cacheEnabled) {
      return;
    }

    this.fileCache.set(filePath, {
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * Gets the directory name of a path using pathUtils
   * @param filePath The file path
   * @returns The directory containing the file
   */
  public getDirname(filePath: string): string {
    return this.pathUtils.dirname(filePath);
  }

  /**
   * Gets the base name of a path using pathUtils
   * @param filePath The file path
   * @returns The file name
   */
  public getBasename(filePath: string): string {
    return this.pathUtils.basename(filePath);
  }

  /**
   * Resolves a path to an absolute path using pathUtils
   * @param filePath The file path to resolve
   * @returns The absolute path
   */
  public resolvePath(filePath: string): string {
    return this.pathUtils.resolve(process.cwd(), filePath);
  }

  /**
   * Gets the relative path from one path to another using pathUtils
   * @param from The source path
   * @param to The target path
   * @returns The relative path
   */
  public relativePath(from: string, to: string): string {
    return this.pathUtils.relative(from, to);
  }

  /**
   * Checks if a path is absolute using pathUtils
   * @param filePath The path to check
   * @returns True if the path is absolute
   */
  public isAbsolutePath(filePath: string): boolean {
    return this.pathUtils.isAbsolute(filePath);
  }

  /**
   * Gets the extension of a file using pathUtils
   * @param filePath The file path
   * @returns The file extension
   */
  public getExtension(filePath: string): string {
    return this.pathUtils.extname(filePath);
  }

  /**
   * Clean up resources used by the service
   */
  public dispose(): void {
    // Cleanup all file watchers
    for (const [path, watcher] of this.activeWatchers.entries()) {
      this.logService?.debug(`Disposing file watcher for: ${path}`);
      watcher.dispose();
    }
    this.activeWatchers.clear();

    // Clean up all temporary files
    this.tempFileManager.cleanupAll().catch((error) => {
      this.logService?.error(
        "Error cleaning up temporary files during disposal",
        error
      );
    });
  }
}
