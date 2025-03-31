import * as path from "path";
import * as os from "os";
import { IPathUtils } from "./interfaces/IPathUtils";
import { ILogService } from "./interfaces/ILogService";

/**
 * Utility class for secure path handling operations
 */
export class PathUtils implements IPathUtils {
  private readonly logService?: ILogService;
  private readonly platformSeparator: string;

  /**
   * Creates a new PathUtils instance
   * @param options Optional configuration options
   */
  constructor(options?: { logService?: ILogService }) {
    this.logService = options?.logService;
    this.platformSeparator = path.sep;

    if (this.logService) {
      this.logService.debug(
        `PathUtils initialized with platform separator: '${this.platformSeparator}'`
      );
    }
  }

  /**
   * Normalizes a path for consistent cross-platform handling
   * @param pathToNormalize The path to normalize
   * @returns Normalized path
   */
  public normalize(pathToNormalize: string): string {
    if (!pathToNormalize) {
      return "";
    }

    // Use Node's path normalize first
    let normalized = path.normalize(pathToNormalize);

    // Convert backslashes to forward slashes for consistency across platforms
    if (path.sep === "\\") {
      normalized = normalized.replace(/\\/g, "/");
    }

    // Remove duplicate slashes
    normalized = normalized.replace(/\/+/g, "/");

    // Remove trailing slash (except for root paths)
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  }

  /**
   * Joins and normalizes path segments
   * @param segments Path segments to join
   * @returns Joined and normalized path
   */
  public join(...segments: string[]): string {
    const joined = path.join(...segments);
    return this.normalize(joined);
  }

  /**
   * Validates a path for security concerns like path traversal
   * @param pathToValidate The path to validate
   * @returns True if path is safe, false otherwise
   */
  public isPathSafe(pathToValidate: string): boolean {
    if (!pathToValidate) {
      return false;
    }

    const normalized = this.normalize(pathToValidate);

    // Check for path traversal attempts
    if (normalized.includes("../") || normalized.includes("..\\")) {
      this.logService?.warn(
        `Path traversal attempt detected: ${pathToValidate}`
      );
      return false;
    }

    // Check for absolute paths that might access sensitive system locations
    if (
      path.isAbsolute(normalized) &&
      (normalized.startsWith("/etc/") ||
        normalized.startsWith("/var/") ||
        normalized.startsWith("/usr/") ||
        normalized.startsWith("C:\\Windows\\") ||
        normalized.startsWith("C:\\Program Files\\"))
    ) {
      this.logService?.warn(
        `Access to system directories attempted: ${pathToValidate}`
      );
      return false;
    }

    return true;
  }

  /**
   * Gets the relative path from one path to another
   * @param from Source path
   * @param to Destination path
   * @returns Relative path from source to destination
   */
  public relative(from: string, to: string): string {
    const relativePath = path.relative(from, to);
    return this.normalize(relativePath);
  }

  /**
   * Resolves a path to its absolute form
   * @param basePath Base path for resolution
   * @param relativePath Relative path to resolve
   * @returns Absolute resolved path
   */
  public resolve(basePath: string, relativePath: string): string {
    // Check if relativePath is already absolute
    if (path.isAbsolute(relativePath)) {
      return this.normalize(relativePath);
    }

    const resolved = path.resolve(basePath, relativePath);
    return this.normalize(resolved);
  }

  /**
   * Checks if a path is absolute
   * @param pathToCheck Path to check
   * @returns True if path is absolute
   */
  public isAbsolute(pathToCheck: string): boolean {
    return path.isAbsolute(pathToCheck);
  }

  /**
   * Gets the directory name from a path
   * @param pathToProcess Path to analyze
   * @returns Directory portion of the path
   */
  public dirname(pathToProcess: string): string {
    return this.normalize(path.dirname(pathToProcess));
  }

  /**
   * Gets the file name from a path
   * @param pathToProcess Path to analyze
   * @returns Filename portion of the path
   */
  public basename(pathToProcess: string): string {
    return path.basename(pathToProcess);
  }

  /**
   * Gets the file extension from a path
   * @param pathToProcess Path to analyze
   * @returns Extension portion of the path (including the dot)
   */
  public extname(pathToProcess: string): string {
    return path.extname(pathToProcess);
  }

  /**
   * Transforms a relative path to an absolute path
   * with support for special symbols (~, .)
   *
   * @param inputPath Path with potential symbols to expand
   * @returns Absolute path with symbols expanded
   */
  public expandPath(inputPath: string): string {
    if (!inputPath) {
      return "";
    }

    // Expand home directory (~)
    if (inputPath.startsWith("~")) {
      const homePath = os.homedir();
      inputPath = path.join(homePath, inputPath.substring(1));
    }

    // Make absolute
    if (!path.isAbsolute(inputPath)) {
      inputPath = path.resolve(inputPath);
    }

    return this.normalize(inputPath);
  }

  /**
   * Ensures a path ends with a trailing separator
   * @param pathToProcess Path to process
   * @returns Path with trailing separator
   */
  public ensureTrailingSlash(pathToProcess: string): string {
    if (!pathToProcess) {
      return "";
    }

    const normalized = this.normalize(pathToProcess);
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  }

  /**
   * Ensures a path does not end with a trailing separator
   * @param pathToProcess Path to process
   * @returns Path without trailing separator
   */
  public removeTrailingSlash(pathToProcess: string): string {
    if (!pathToProcess) {
      return "";
    }

    const normalized = this.normalize(pathToProcess);
    return normalized.endsWith("/") && normalized !== "/"
      ? normalized.slice(0, -1)
      : normalized;
  }

  /**
   * Gets the platform-specific path separator
   * @returns The path separator for the current platform
   */
  public getPathSeparator(): string {
    return this.platformSeparator;
  }

  /**
   * Gets the platform-independent normalized path separator (always '/')
   * @returns The normalized path separator
   */
  public getNormalizedSeparator(): string {
    return "/";
  }

  /**
   * Converts a path to use platform-specific separators
   * @param pathToConvert Path to convert
   * @returns Path with platform-specific separators
   */
  public toPlatformPath(pathToConvert: string): string {
    if (!pathToConvert) {
      return "";
    }

    if (path.sep === "\\") {
      return pathToConvert.replace(/\//g, "\\");
    }

    return pathToConvert;
  }
}
