/**
 * Interface for path normalization and validation utilities
 */
export interface IPathUtils {
  /**
   * Normalizes a path for consistent cross-platform handling
   * @param path The path to normalize
   * @returns Normalized path with consistent separators
   */
  normalize(path: string): string;

  /**
   * Joins path segments and normalizes the result
   * @param segments Path segments to join
   * @returns Normalized joined path
   */
  join(...segments: string[]): string;

  /**
   * Validates a path for security concerns like path traversal
   * @param path The path to validate
   * @returns True if path is safe, false otherwise
   */
  isPathSafe(path: string): boolean;

  /**
   * Gets the relative path from one path to another
   * @param from Source path
   * @param to Destination path
   * @returns Relative path from source to destination
   */
  relative(from: string, to: string): string;

  /**
   * Resolves a path to its absolute form
   * @param basePath Base path for resolution
   * @param relativePath Relative path to resolve
   * @returns Absolute resolved path
   */
  resolve(basePath: string, relativePath: string): string;

  /**
   * Checks if a path is absolute
   * @param path Path to check
   * @returns True if path is absolute
   */
  isAbsolute(path: string): boolean;

  /**
   * Gets the directory name from a path
   * @param path Path to analyze
   * @returns Directory portion of the path
   */
  dirname(path: string): string;

  /**
   * Gets the file name from a path
   * @param path Path to analyze
   * @returns Filename portion of the path
   */
  basename(path: string): string;

  /**
   * Gets the file extension from a path
   * @param path Path to analyze
   * @returns Extension portion of the path (including the dot)
   */
  extname(path: string): string;

  /**
   * Checks if a file has specific permissions
   * @param filePath Path to the file
   * @param mode Expected permission mode (octal number)
   * @returns Promise resolving to true if file has expected permissions
   */
  hasPermissions(filePath: string, mode: number): Promise<boolean>;

  /**
   * Sets permissions on a file
   * @param filePath Path to the file
   * @param mode Permission mode to set (octal number)
   * @returns Promise resolving when permissions are set
   */
  setPermissions(filePath: string, mode: number): Promise<void>;

  /**
   * Makes a file executable
   * @param filePath Path to the file
   * @returns Promise resolving when file is made executable
   */
  makeExecutable(filePath: string): Promise<void>;

  getExecutableExtension(): string;
}
