/**
 * Interface for file system operations
 */
export interface IFileSystemService {
  writeFile(path: string, content: string, options?: { mode?: number }): void;
  exists(path: string): boolean;
}
