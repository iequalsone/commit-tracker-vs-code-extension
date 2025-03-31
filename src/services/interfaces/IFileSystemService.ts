import { Result } from "../../utils/results";
import * as vscode from "vscode";
import { TempDirectoryHandle, TempFileHandle } from "./ITempFileHandles";

/**
 * File watching event type definitions
 */
export type FileWatcherEvent = "change" | "create" | "delete";

/**
 * File watcher options
 */
export interface FileWatcherOptions {
  /** Whether to watch recursively (for directories) */
  recursive?: boolean;

  /** Watch only specific extensions (e.g. ['.log', '.json']) */
  extensions?: string[];

  /** Exclude patterns (glob patterns) */
  exclude?: string[];
  excludePatterns?: RegExp[];

  /** Throttle events (in ms) to prevent excessive notifications */
  throttleMs?: number;
}

/**
 * File watcher interface
 */
export interface FileWatcher {
  /** Path being watched */
  readonly path: string;

  /** Disposes of the watcher */
  dispose(): void;
}

/**
 * Interface defining file system operations for the extension
 * Provides an abstraction over Node.js fs operations with added security, error handling, and caching
 */
export interface IFileSystemService extends vscode.Disposable {
  /**
   * Read a file as text
   * @param path Path to the file
   * @param options Optional encoding and cache options
   * @returns Result containing the file content or an error
   */
  readFile(
    path: string,
    options?: {
      encoding?: BufferEncoding;
      useCache?: boolean;
    }
  ): Promise<Result<string, Error>>;

  /**
   * Write content to a file, creating the file if it doesn't exist
   * @param path Path to the file
   * @param content Content to write
   * @param options Optional write options (append, mode, atomic)
   * @returns Result indicating success or failure
   */
  writeFile(
    path: string,
    content: string,
    options?: {
      append?: boolean;
      mode?: number;
      atomic?: boolean;
    }
  ): Promise<Result<void, Error>>;

  /**
   * Append content to a file
   * @param path Path to the file
   * @param content Content to append
   * @param options Optional mode
   * @returns Result indicating success or failure
   */
  appendToFile(
    path: string,
    content: string,
    options?: {
      mode?: number;
    }
  ): Promise<Result<void, Error>>;

  /**
   * Check if a file or directory exists
   * @param path Path to check
   * @returns Result containing boolean existence status
   */
  exists(path: string): Promise<Result<boolean, Error>>;

  /**
   * Create a directory and any parent directories if they don't exist
   * @param dirPath Path to the directory
   * @param options Optional mode for directory creation
   * @returns Result indicating success or failure
   */
  ensureDirectory(
    dirPath: string,
    options?: {
      mode?: number;
    }
  ): Promise<Result<void, Error>>;

  /**
   * Delete a file
   * @param path Path to the file
   * @param options Optional force option
   * @returns Result indicating success or failure
   */
  deleteFile(
    path: string,
    options?: {
      force?: boolean;
    }
  ): Promise<Result<void, Error>>;

  /**
   * Delete a directory and its contents
   * @param dirPath Path to the directory
   * @param options Optional recursive and force options
   * @returns Result indicating success or failure
   */
  deleteDirectory(
    dirPath: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
    }
  ): Promise<Result<void, Error>>;

  /**
   * List files in a directory
   * @param dirPath Path to the directory
   * @param options Optional pattern to filter files
   * @returns Result containing array of file names
   */
  listFiles(
    dirPath: string,
    options?: {
      pattern?: string | RegExp;
    }
  ): Promise<Result<string[], Error>>;

  /**
   * Create a temporary file with the given content
   * @param content Content to write to the temporary file
   * @param options Optional prefix, suffix, and directory
   * @returns Result containing the path to the temporary file
   */
  createTempFile(
    content: string,
    options?: {
      prefix?: string;
      suffix?: string;
      directory?: string;
      mode?: number;
    }
  ): Promise<Result<string, Error>>;

  /**
   * Copy a file from one location to another
   * @param sourcePath Source file path
   * @param targetPath Target file path
   * @param options Optional overwrite flag
   * @returns Result indicating success or failure
   */
  copyFile(
    sourcePath: string,
    targetPath: string,
    options?: {
      overwrite?: boolean;
    }
  ): Promise<Result<void, Error>>;

  /**
   * Move a file from one location to another
   * @param sourcePath Source file path
   * @param targetPath Target file path
   * @param options Optional overwrite flag
   * @returns Result indicating success or failure
   */
  moveFile(
    sourcePath: string,
    targetPath: string,
    options?: {
      overwrite?: boolean;
    }
  ): Promise<Result<void, Error>>;

  /**
   * Watch a file or directory for changes
   * @param path Path to watch
   * @param listener Function to call when changes occur
   * @returns Result containing a disposable to stop watching
   */
  watchPath(
    path: string,
    listener: (event: "create" | "change" | "delete", path: string) => void
  ): Result<{ dispose: () => void }, Error>;

  /**
   * Get information about a file
   * @param path Path to the file
   * @returns Result containing file statistics
   */
  getFileStats(path: string): Promise<
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
  >;

  /**
   * Safely validate a file path to prevent path traversal attacks
   * @param path Path to validate
   * @returns true if the path is safe, false otherwise
   */
  validatePath(path: string): boolean;

  /**
   * Normalize a path for the current operating system
   * @param path Path to normalize
   * @returns Normalized path
   */
  normalizePath(path: string): string;

  /**
   * Clear the file read cache
   * @param path Optional specific path to clear from cache
   */
  clearCache(path?: string): void;

  createExecutableScript(
    content: string,
    options?: { prefix?: string; suffix?: string }
  ): Promise<Result<string, Error>>;

  /**
   * Watch a single file for changes
   * @param filePath Path to the file to watch
   * @param listener Function called when file changes
   * @returns FileWatcher that can be disposed
   */
  watchFile(
    filePath: string,
    listener: (event: FileWatcherEvent) => void
  ): Result<FileWatcher, Error>;

  /**
   * Watch a directory for changes
   * @param dirPath Path to the directory
   * @param listener Function called when files change
   * @param options Additional watcher options
   * @returns FileWatcher that can be disposed
   */
  watchDirectory(
    dirPath: string,
    listener: (event: FileWatcherEvent, filePath: string) => void,
    options?: FileWatcherOptions
  ): Result<FileWatcher, Error>;

  /**
   * Watch multiple paths (files or directories)
   * @param paths Array of paths to watch
   * @param listener Function called when any file changes
   * @param options Additional watcher options
   * @returns FileWatcher that can be disposed
   */
  watchPaths(
    paths: string[],
    listener: (event: FileWatcherEvent, filePath: string) => void,
    options?: FileWatcherOptions
  ): Result<FileWatcher, Error>;

  /**
   * Creates a temporary file with automatic cleanup
   * @param content File content
   * @param options Options for creating the temp file
   * @returns Result containing the temp file handle with path and cleanup method
   */
  createTempFileWithCleanup(
    content: string,
    options?: {
      prefix?: string;
      suffix?: string;
      mode?: number;
      deleteOnExit?: boolean;
    }
  ): Promise<Result<TempFileHandle, Error>>;

  /**
   * Creates a temporary directory with automatic cleanup
   * @param options Options for creating the temp directory
   * @returns Result containing the temp directory handle with path and cleanup method
   */
  createTempDirectoryWithCleanup(options?: {
    prefix?: string;
    deleteOnExit?: boolean;
  }): Promise<Result<TempDirectoryHandle, Error>>;

  /**
   * Gets the directory name of a path
   * @param filePath The file path
   * @returns The directory containing the file
   */
  getDirname(filePath: string): string;

  /**
   * Gets the base name of a path
   * @param filePath The file path
   * @returns The file name
   */
  getBasename(filePath: string): string;

  /**
   * Resolves a path to an absolute path
   * @param filePath The file path to resolve
   * @returns The absolute path
   */
  resolvePath(filePath: string): string;

  /**
   * Gets the relative path from one path to another
   * @param from The source path
   * @param to The target path
   * @returns The relative path
   */
  relativePath(from: string, to: string): string;

  /**
   * Checks if a path is absolute
   * @param filePath The path to check
   * @returns True if the path is absolute
   */
  isAbsolutePath(filePath: string): boolean;

  /**
   * Gets the extension of a file
   * @param filePath The file path
   * @returns The file extension
   */
  getExtension(filePath: string): string;

  /**
   * List files recursively in a directory
   * @param dirPath Path to the directory
   * @param options Options for recursive listing
   * @returns Result containing array of file paths
   */
  listFilesRecursively(
    dirPath: string,
    options?: {
      filter?: RegExp;
      maxDepth?: number;
      includeDirectories?: boolean;
    }
  ): Promise<Result<string[], Error>>;

  /**
   * Copy a directory recursively
   * @param sourcePath Source directory path
   * @param destinationPath Destination directory path
   * @param options Options for recursive copy
   * @returns Result indicating success or failure
   */
  copyDirectoryRecursively(
    sourcePath: string,
    destinationPath: string,
    options?: {
      overwrite?: boolean;
      filter?: RegExp;
      excludeGitDir?: boolean;
    }
  ): Promise<Result<void, Error>>;

  /**
   * Find files matching a pattern recursively
   * @param dirPath Directory to search
   * @param pattern Regex pattern to match against file names
   * @param options Search options
   * @returns Result containing array of matching file paths
   */
  findFiles(
    dirPath: string,
    pattern: RegExp,
    options?: {
      maxDepth?: number;
      maxResults?: number;
    }
  ): Promise<Result<string[], Error>>;
}
