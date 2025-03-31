/**
 * Handle for a temporary file with cleanup functionality
 */
export interface TempFileHandle {
  /**
   * Path to the temporary file
   */
  path: string;

  /**
   * Content of the temporary file
   */
  content: string;

  /**
   * Cleans up the temporary file by deleting it
   */
  cleanup(): Promise<void>;

  /**
   * Refreshes the content of the temporary file
   * @param newContent New content for the file
   */
  refresh(newContent: string): Promise<void>;
}

/**
 * Handle for a temporary directory with cleanup functionality
 */
export interface TempDirectoryHandle {
  /**
   * Path to the temporary directory
   */
  path: string;

  /**
   * Cleans up the temporary directory by deleting it and all its contents
   */
  cleanup(): Promise<void>;

  /**
   * Creates a file in the temporary directory
   * @param fileName Name of the file to create
   * @param content Content for the file
   * @returns Path to the created file
   */
  createFile(fileName: string, content: string): Promise<string>;

  /**
   * Lists files in the temporary directory
   * @returns Array of file paths in the directory
   */
  listFiles(): Promise<string[]>;
}
