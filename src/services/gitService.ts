import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { exec, execSync } from "child_process";
import { ITerminalProvider, ITerminal } from "./interfaces/ITerminalProvider";
import { ILogService } from "./interfaces/ILogService";
import { IWorkspaceProvider } from "./interfaces/IWorkspaceProvider";
import { IFileSystemService } from "./interfaces/IFileSystemService";
import { promisify } from "util";
import { failure, Result, success } from "../utils/results";

// Cache interface for storing git operation results
interface GitCache {
  [key: string]: {
    result: any;
    timestamp: number;
  };
}

/**
 * Service that handles all Git operations
 */
export class GitService {
  // Cache storage with a default 5-minute TTL
  private cache: GitCache = {};
  private readonly DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  private readonly logService?: ILogService;
  private readonly terminalProvider?: ITerminalProvider;
  private readonly workspaceProvider?: IWorkspaceProvider;
  private readonly fileSystemService: IFileSystemService;

  private readonly execAsync = promisify(exec);

  private _getWorkspaceRoot: (() => string | null) | null = null;

  /**
   * Create a new GitService instance with all dependencies injectable
   * @param options Optional dependencies for the service
   */
  constructor(options: {
    logService?: ILogService;
    terminalProvider?: ITerminalProvider;
    workspaceProvider?: IWorkspaceProvider;
    fileSystemService: IFileSystemService;
  }) {
    this.logService = options?.logService;
    this.terminalProvider = options?.terminalProvider;
    this.workspaceProvider = options?.workspaceProvider;
    this.fileSystemService = options.fileSystemService;
  }

  /**
   * Run a script in a terminal if terminal provider is available
   * @param scriptPath Path to script to run
   * @param terminalName Name for the terminal
   * @param workingDirectory Optional working directory
   * @returns True if terminal was created, false if not possible
   */
  public runScriptInTerminal(
    scriptPath: string,
    terminalName: string = "Git Operation",
    workingDirectory?: string
  ): boolean {
    if (!this.terminalProvider) {
      if (this.logService) {
        this.logService.warn(
          "Terminal provider not available, can't run script"
        );
      }
      return false;
    }

    try {
      const terminal = this.terminalProvider.createTerminal({
        name: terminalName,
        cwd: workingDirectory,
        hideFromUser: false,
      });

      terminal.show();
      terminal.sendText(`bash "${scriptPath}" && exit || exit`);

      if (this.logService) {
        this.logService.info(`Running script in terminal: ${scriptPath}`);
      }
      return true;
    } catch (error) {
      if (this.logService) {
        this.logService.error("Failed to run script in terminal", error);
      }
      return false;
    }
  }

  /**
   * Sets a workspace provider for the git service
   * @param provider Function that returns the current workspace path
   */
  public setWorkspaceProvider(provider: () => string | null): void {
    this._getWorkspaceRoot = provider;
    if (this.logService) {
      this.logService.info("Workspace provider set for GitService");
    }
  }

  /**
   * Gets the current branch name
   * @param workspaceRoot Optional workspace root path
   * @returns The current branch name or null if not in a git repository
   */
  public async getCurrentBranch(
    workspaceRoot?: string
  ): Promise<Result<string, Error>> {
    try {
      const root = workspaceRoot || this.getWorkspaceRoot();

      if (!root) {
        return failure(new Error("No workspace root available"));
      }

      this.logService?.debug(`Getting current branch for: ${root}`);

      // Try to get from cache first
      const cacheKey = `branch:${root}`;
      const cachedBranch = this.getFromCache(cacheKey);

      if (cachedBranch) {
        return success(cachedBranch);
      }

      const result = await this.executeGitCommand(
        root,
        "rev-parse --abbrev-ref HEAD"
      );

      // Cache the result
      this.setInCache(cacheKey, result);

      return success(result);
    } catch (error) {
      this.logService?.error(`Error getting current branch: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Checks if there are any unpushed commits
   * @param workspaceRoot Optional workspace root path
   * @returns True if there are unpushed commits
   */
  public async hasUnpushedCommits(
    workspaceRoot?: string
  ): Promise<Result<boolean, Error>> {
    try {
      const root = workspaceRoot || this.getWorkspaceRoot();

      if (!root) {
        return failure(new Error("No workspace root available"));
      }

      this.logService?.debug(`Checking for unpushed commits in: ${root}`);

      // Try to get from cache first
      const cacheKey = `unpushed:${root}`;
      const cached = this.getFromCache(cacheKey);

      if (cached !== null) {
        return success(cached);
      }

      // Check for unpushed commits
      try {
        const output = await this.executeGitCommand(
          root,
          "log @{u}..HEAD --oneline"
        );

        const hasUnpushed = output.trim().length > 0;

        // Cache the result
        this.setInCache(cacheKey, hasUnpushed);

        return success(hasUnpushed);
      } catch (error) {
        // If this fails, it might be because there's no upstream branch
        // In that case, try another method
        try {
          const statusOutput = await this.executeGitCommand(root, "status -sb");

          const hasUnpushed = statusOutput.includes("ahead");

          // Cache the result
          this.setInCache(cacheKey, hasUnpushed);

          return success(hasUnpushed);
        } catch (innerError) {
          return failure(
            innerError instanceof Error
              ? innerError
              : new Error(String(innerError))
          );
        }
      }
    } catch (error) {
      this.logService?.error(`Error checking for unpushed commits: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Gets the commit message for a specific commit
   * @param repoPath Path to the repository
   * @param commitHash Commit hash to get the message for
   * @returns Result containing the commit message or an error
   */
  public async getCommitMessage(
    repoPath: string,
    commitHash: string
  ): Promise<Result<string, Error>> {
    try {
      if (!commitHash) {
        return failure(new Error("Commit hash is required"));
      }

      // Generate cache key - commit messages never change for a given hash
      const cacheKey = `commit:message:${repoPath}:${commitHash}`;

      // Try to get from cache with long TTL
      const cachedValue = this.getFromCache(cacheKey, 24 * 60 * 60 * 1000); // 24 hours TTL
      if (cachedValue !== null) {
        return success(cachedValue);
      }

      // Get the commit message using the git show command
      const message = execSync(`git show -s --format=%B ${commitHash}`, {
        cwd: repoPath,
      })
        .toString()
        .trim();

      // Store in cache
      this.setInCache(cacheKey, message);

      return success(message);
    } catch (error) {
      this.logService?.error(`Error getting commit message: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Gets the author details for a specific commit
   * @param repoPath Path to the repository
   * @param commitHash Commit hash to get the author for
   * @returns Result containing the author details or an error
   */
  public async getCommitAuthorDetails(
    repoPath: string,
    commitHash: string
  ): Promise<Result<string, Error>> {
    try {
      if (!commitHash) {
        return failure(new Error("Commit hash is required"));
      }

      // Generate cache key - author never changes for a given hash
      const cacheKey = `commit:author:${repoPath}:${commitHash}`;

      // Try to get from cache with long TTL
      const cachedValue = this.getFromCache(cacheKey, 24 * 60 * 60 * 1000); // 24 hours TTL
      if (cachedValue !== null) {
        return success(cachedValue);
      }

      // Get the author using the git show command
      const author = execSync(
        `git show -s --format="%an <%ae>" ${commitHash}`,
        {
          cwd: repoPath,
        }
      )
        .toString()
        .trim();

      // Store in cache
      this.setInCache(cacheKey, author);

      return success(author);
    } catch (error) {
      this.logService?.error(`Error getting commit author details: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Gets the repository name from the remote URL
   * @param repoPath Path to the repository
   * @returns Result containing the repository name or an error
   */
  public async getRepoNameFromRemote(
    repoPath: string
  ): Promise<Result<string, Error>> {
    try {
      // Generate cache key
      const cacheKey = `repo:name:${repoPath}`;

      // Try to get from cache with longer TTL
      const cachedValue = this.getFromCache(cacheKey, 30 * 60 * 1000); // 30 minutes TTL
      if (cachedValue !== null) {
        return success(cachedValue);
      }

      // Get the remote URL
      let remoteUrl = "";
      try {
        remoteUrl = execSync("git remote get-url origin", {
          cwd: repoPath,
        })
          .toString()
          .trim();
      } catch (error) {
        // Silently handle the case where there's no remote configured
        return success(path.basename(repoPath));
      }

      // If no remote origin is found, use the directory name
      if (!remoteUrl) {
        return success(path.basename(repoPath));
      }

      // Remove .git suffix if present
      if (remoteUrl.endsWith(".git")) {
        remoteUrl = remoteUrl.slice(0, -4);
      }

      // Extract the repository name from the URL
      const repoName = path.basename(remoteUrl);

      // Store in cache
      this.setInCache(cacheKey, repoName);

      return success(repoName);
    } catch (error) {
      // Even in case of error, we fall back to using the directory name
      this.logService?.warn(
        `Error getting repo name from remote, using directory name: ${error}`
      );
      return success(path.basename(repoPath));
    }
  }

  /**
   * Pulls changes from the tracking repository
   * @param repoPath Path to the log file directory
   * @returns A promise that resolves when the pull is complete
   */
  public async pullChanges(repoPath: string): Promise<Result<void, Error>> {
    try {
      this.logService?.info(
        `Pulling changes from tracking repository at: ${repoPath}`
      );

      // Check if this is a git repository
      const isRepoResult = await this.isGitRepository(repoPath);

      if (!isRepoResult) {
        return failure(new Error(`${repoPath} is not a valid Git repository`));
      }

      // First, check if there's actually an origin remote
      try {
        await this.executeGitCommand(repoPath, "remote get-url origin");
      } catch (error) {
        this.logService?.warn("No remote origin found, skipping pull");
        return success(undefined);
      }

      // Check for tracking branch without failing if there isn't one
      try {
        await this.executeGitCommand(repoPath, "pull");
        this.logService?.info(
          "Successfully pulled changes from tracking repository"
        );
      } catch (error) {
        this.logService?.warn(`Pull failed but continuing: ${error}`);
      }

      return success(undefined);
    } catch (error) {
      this.logService?.error(`Failed to pull changes: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Creates a script to push changes in a VS Code terminal
   * @param repoPath Path to the repository
   * @param filePath Path to the file that was changed
   * @returns The path to the created script
   */
  public async createPushScript(
    repoPath: string,
    filePath: string
  ): Promise<Result<string, Error>> {
    try {
      this.logService?.info(
        `Creating push script for: ${filePath} in ${repoPath}`
      );

      // Create push script with default options
      return this.createAdvancedPushScript(repoPath, filePath, {
        commitMessage: `Update commit log - ${new Date().toISOString()}`,
        showOutput: true,
        autoClose: true,
        timeout: 3,
      });
    } catch (error) {
      this.logService?.error(`Error creating push script: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Gets the path of the current workspace root
   * @returns The workspace path or null if no workspace is open
   */
  private getWorkspaceRoot(): string | null {
    if (this.workspaceProvider) {
      return this.workspaceProvider.getWorkspaceRoot();
    }

    if (this.logService) {
      this.logService.warn("Workspace provider not available");
    }
    return null;
  }

  /**
   * Store a value in the cache
   * @param key Cache key
   * @param value Value to store
   * @param ttl Optional TTL in ms (defaults to DEFAULT_CACHE_TTL)
   */
  private setInCache(key: string, value: any, ttl?: number): void {
    this.cache[key] = {
      result: value,
      timestamp: Date.now() + (ttl || this.DEFAULT_CACHE_TTL),
    };
  }

  /**
   * Get a value from the cache
   * @param key Cache key
   * @param customTtl Optional custom TTL to apply
   * @returns The cached value or null if not found or expired
   */
  private getFromCache(key: string, customTtl?: number): any {
    const cached = this.cache[key];
    if (!cached) {
      return null;
    }

    const now = Date.now();
    if (customTtl) {
      // Apply custom TTL based on current time, not the original timestamp
      if (now > cached.timestamp - this.DEFAULT_CACHE_TTL + customTtl) {
        delete this.cache[key];
        return null;
      }
    } else {
      // Use the timestamp stored in the cache
      if (now > cached.timestamp) {
        delete this.cache[key];
        return null;
      }
    }

    return cached.result;
  }

  /**
   * Invalidate cache for a specific repository or globally
   * @param repoPath Optional repository path to invalidate cache for
   */
  public invalidateCache(repoPath?: string): void {
    if (repoPath) {
      // Invalidate only cache entries for the specified repository
      Object.keys(this.cache).forEach((key) => {
        if (key.includes(repoPath)) {
          delete this.cache[key];
        }
      });
    } else {
      // Invalidate all cache
      this.cache = {};
    }
  }

  /**
   * Executes a git command in the specified repository path
   * @param repoPath Path to the repository
   * @param command Git command to execute
   * @param options Optional execution options
   * @returns Promise resolving to the output of the command
   */
  public async executeGitCommand(
    repoPath: string,
    command: string,
    options?: { timeout?: number }
  ): Promise<string> {
    // Set appropriate timeout based on command type
    let timeout = options?.timeout || 10000; // Default 10 seconds

    // Use longer timeout for push/pull operations
    if (command.includes("push") || command.includes("pull")) {
      timeout = 60000; // 60 seconds for network operations
    }

    try {
      if (this.logService) {
        this.logService.info(
          `Executing git command in ${repoPath}: ${command} (timeout: ${timeout}ms)`
        );
      }

      // Check that the path exists
      if (!this.fileSystemService.exists(repoPath)) {
        throw new Error(`Repository path does not exist: ${repoPath}`);
      }

      // Set up custom environment variables to help with Git credential handling
      const env = { ...process.env };

      // Add GIT_TERMINAL_PROMPT=0 to prevent Git from trying to prompt for credentials
      // which will cause the command to hang in VS Code
      env.GIT_TERMINAL_PROMPT = "0";

      // Execute the command with the specified timeout and custom environment
      const { stdout, stderr } = await this.execAsync(
        `git -C "${repoPath}" ${command}`,
        {
          timeout,
          env,
        }
      );

      if (stderr && !stderr.includes("Warning")) {
        if (this.logService) {
          this.logService.info(`Git command produced stderr: ${stderr}`);
        }
      }

      return stdout.trim();
    } catch (error) {
      if (error instanceof Error) {
        // Add more detailed logging for timeouts
        if (error.message.includes("timed out")) {
          if (this.logService) {
            this.logService.error(
              `Git command timed out after ${timeout}ms: ${command} in ${repoPath}`
            );
          }
        }

        if (this.logService) {
          this.logService.error(
            `Git command failed in ${repoPath} with command: ${command}`
          );
          this.logService.error(`Error message: ${error.message}`);
        }
      }
      throw error;
    }
  }

  /**
   * Gets the list of branches for a repository
   * @param repoPath Path to the repository
   * @returns Promise resolving to array of branch names
   */
  public async getBranches(repoPath: string): Promise<string[]> {
    try {
      // Generate cache key
      const cacheKey = `branches:${repoPath}`;

      // Try to get from cache
      const cachedValue = this.getFromCache(cacheKey);
      if (cachedValue !== null) {
        return cachedValue;
      }

      const branchData = execSync('git branch --format="%(refname:short)"', {
        cwd: repoPath,
      })
        .toString()
        .trim();

      const branches = branchData
        .split("\n")
        .filter((branch) => branch.length > 0);

      // Store in cache
      this.setInCache(cacheKey, branches);

      return branches;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Gets information about unpushed commits
   * @param repoPath Path to the repository
   * @returns Promise resolving to an object with unpushed commit information
   */
  public async getUnpushedCommitInfo(repoPath: string): Promise<{
    count: number;
    commitHashes: string[];
    needsPush: boolean;
  }> {
    try {
      const path = repoPath;
      if (!path) {
        return { count: 0, commitHashes: [], needsPush: false };
      }

      // Check if this is a git repository
      if (!fs.existsSync(path + "/.git")) {
        return { count: 0, commitHashes: [], needsPush: false };
      }

      // Get current branch
      const branch = await this.getCurrentBranch(path);
      if (!branch) {
        return { count: 0, commitHashes: [], needsPush: false };
      }

      // Generate cache key - shorter TTL for unpushed commits
      const cacheKey = `unpushed-info:${path}:${branch}`;

      // Try to get from cache with shorter TTL
      const cachedValue = this.getFromCache(cacheKey, 30 * 1000); // 30 seconds TTL
      if (cachedValue !== null) {
        return cachedValue;
      }

      // Check for unpushed commits
      const result = execSync(`git cherry -v origin/${branch}`, {
        cwd: path,
      }).toString();

      const lines = result
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      const commitHashes = lines
        .map((line) => {
          // Extract just the commit hash (second column)
          const parts = line.trim().split(" ");
          return parts.length > 1 ? parts[1] : "";
        })
        .filter((hash) => hash.length > 0);

      const unpushedInfo = {
        count: commitHashes.length,
        commitHashes,
        needsPush: commitHashes.length > 0,
      };

      // Store in cache
      this.setInCache(cacheKey, unpushedInfo);

      return unpushedInfo;
    } catch (error) {
      // This can fail if the branch doesn't exist on remote or other git issues
      return { count: 0, commitHashes: [], needsPush: true };
    }
  }

  /**
   * Gets the detailed change statistics for a repository
   * @param repoPath Path to the repository
   * @returns Promise resolving to object with stats about changes
   */
  public async getRepositoryStats(repoPath: string): Promise<{
    uncommittedChanges: number;
    stagedChanges: number;
    untrackedFiles: number;
    lastCommitDate: Date | null;
  }> {
    try {
      // Generate cache key
      const cacheKey = `repo-stats:${repoPath}`;

      // Try to get from cache with short TTL
      const cachedValue = this.getFromCache(cacheKey, 15 * 1000); // 15 seconds TTL
      if (cachedValue !== null) {
        return cachedValue;
      }

      // Get status
      const statusOutput = execSync("git status --porcelain", {
        cwd: repoPath,
      }).toString();

      // Parse status output
      const lines = statusOutput
        .split("\n")
        .filter((line) => line.trim().length > 0);
      let uncommittedChanges = 0;
      let stagedChanges = 0;
      let untrackedFiles = 0;

      for (const line of lines) {
        const status = line.substring(0, 2);
        if (status.includes("?")) {
          untrackedFiles++;
        } else {
          if (status[0] !== " ") {
            stagedChanges++;
          }
          if (status[1] !== " ") {
            uncommittedChanges++;
          }
        }
      }

      // Get last commit date
      let lastCommitDate: Date | null = null;
      try {
        const dateOutput = execSync("git log -1 --format=%cd", {
          cwd: repoPath,
        })
          .toString()
          .trim();

        if (dateOutput) {
          lastCommitDate = new Date(dateOutput);
        }
      } catch (error) {
        // Repository might have no commits yet
        lastCommitDate = null;
      }

      const stats = {
        uncommittedChanges,
        stagedChanges,
        untrackedFiles,
        lastCommitDate,
      };

      // Store in cache
      this.setInCache(cacheKey, stats);

      return stats;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Creates a shell script to execute a Git command and returns the script path
   * @param repoPath Path to the repository
   * @param command Git command to execute
   * @param scriptName Optional name for the script (defaults to 'git-operation')
   * @returns Result containing the path to the created script or error
   */
  public async createGitScript(
    repoPath: string,
    command: string,
    scriptName: string = "git-operation"
  ): Promise<Result<string, Error>> {
    // Create a temporary shell script
    const scriptPath = path.join(os.tmpdir(), `${scriptName}-${Date.now()}.sh`);

    // Build script content with proper error handling
    const scriptContent = `#!/bin/bash
# Git operation script created by Commit Tracker
echo "=== Commit Tracker Git Operation ==="
echo "Repository: ${repoPath}"
echo "Command: ${command}"

# Change to the repository directory
cd "${repoPath}" || { echo "Failed to change to repository directory"; exit 1; }

# Execute the git command
echo "Executing: git ${command}"
git ${command}
RESULT=$?

if [ $RESULT -eq 0 ]; then
  echo "Command executed successfully"
else
  echo "Command failed with status $RESULT"
fi

echo "=== Git Operation Complete ==="
echo "Terminal will close in 3 seconds..."
sleep 3
`;

    const writeResult = await this.fileSystemService.writeFile(
      scriptPath,
      scriptContent,
      { mode: 0o755 }
    );

    if (writeResult.isFailure()) {
      this.logService?.error(
        `Failed to create Git script: ${writeResult.error}`
      );
      return failure(writeResult.error);
    }

    return success(scriptPath);
  }

  /**
   * Checks if a path is a Git repository
   * @param repoPath Path to check
   * @returns True if the path is a Git repository
   */
  public async isGitRepository(repoPath: string): Promise<boolean> {
    try {
      this.logService?.debug(`Checking if ${repoPath} is a Git repository`);

      const gitDirPath = path.join(repoPath, ".git");

      // Use fileSystemService to check if .git directory exists
      const existsResult = await this.fileSystemService.exists(gitDirPath);

      if (existsResult.isFailure()) {
        this.logService?.error(
          `Error checking if Git repository exists: ${existsResult.error}`
        );
        return false;
      }

      return existsResult.value;
    } catch (error) {
      this.logService?.error(
        `Error checking if path is a Git repository: ${error}`
      );
      return false;
    }
  }

  /**
   * Gets the remote URL for a repository
   * @param repoPath Path to the repository
   * @returns The remote URL or null if not found
   */
  public async getRemoteUrl(repoPath: string): Promise<Result<string, Error>> {
    try {
      this.logService?.debug(`Getting remote URL for repository: ${repoPath}`);

      // Check if it's a git repository first
      if (!(await this.isGitRepository(repoPath))) {
        return failure(new Error(`${repoPath} is not a Git repository`));
      }

      // Get the remote URL using git command
      const remoteOutput = await this.executeGitCommand(
        repoPath,
        "remote get-url origin"
      ).catch(() => "");

      // If we couldn't get the remote, return null
      if (!remoteOutput) {
        this.logService?.info(`No remote URL found for ${repoPath}`);
        return success("");
      }

      return success(remoteOutput.trim());
    } catch (error) {
      this.logService?.error(`Failed to get remote URL: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get the short status of a repository
   * @param repoPath Path to the repository
   * @returns Short status string
   */
  public async getShortStatus(
    repoPath: string
  ): Promise<Result<string, Error>> {
    try {
      this.logService?.debug(
        `Getting short status for repository: ${repoPath}`
      );

      // Use executeGitCommand for consistency
      const statusOutput = await this.executeGitCommand(
        repoPath,
        "status --short"
      );

      return success(statusOutput.trim());
    } catch (error) {
      this.logService?.error(`Failed to get repository short status: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Checks if a repository has changes
   * @param repoPath Path to the repository
   * @returns True if the repository has uncommitted changes
   */
  public async hasUncommittedChanges(
    repoPath: string
  ): Promise<Result<boolean, Error>> {
    try {
      this.logService?.debug(
        `Checking for uncommitted changes in: ${repoPath}`
      );

      // Get status and check if there's any output
      const statusResult = await this.getShortStatus(repoPath);

      if (statusResult.isFailure()) {
        return failure(statusResult.error);
      }

      // If there's any output, there are changes
      return success(statusResult.value.length > 0);
    } catch (error) {
      this.logService?.error(
        `Error checking for uncommitted changes: ${error}`
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Creates a push script with specific options
   * @param repoPath Path to the repository
   * @param filePath Path to the file being committed
   * @param options Additional options for the script
   * @returns Path to the created script
   */
  public async createAdvancedPushScript(
    repoPath: string,
    filePath: string,
    options: {
      commitMessage?: string;
      showOutput?: boolean;
      autoClose?: boolean;
      timeout?: number;
    } = {}
  ): Promise<Result<string, Error>> {
    // Default options
    const defaults = {
      commitMessage: `Update commit log - ${new Date().toISOString()}`,
      showOutput: true,
      autoClose: true,
      timeout: 5,
    };

    const settings = { ...defaults, ...options };

    // Build a more customizable script
    const scriptContent = `#!/bin/bash
# Commit Tracker Push Script
echo "=== Commit Tracker Automatic Push ==="
echo "Repository: ${repoPath}"
echo "File: ${filePath}"

# Change to the repository directory
cd "${repoPath}" || { echo "Failed to change to repository directory"; exit 1; }

# Stage the file
echo "Adding file: ${filePath}"
git add "${filePath}"

# Commit changes if needed
if git status --porcelain | grep -q .; then
  echo "Changes detected, committing..."
  git commit -m "${settings.commitMessage}"
  if [ $? -eq 0 ]; then
    echo "Commit successful"
  else
    echo "Commit failed"
    exit 1
  fi
else
  echo "No changes to commit"
  sleep 2
  ${settings.autoClose ? "exit 0" : ""}
fi

# Check if remote exists
if git remote | grep -q origin; then
  echo "Remote 'origin' exists"
  
  # Get current branch
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  echo "Current branch: $CURRENT_BRANCH"
  
  # Push changes
  echo "Pushing changes to origin/$CURRENT_BRANCH..."
  git push
  
  if [ $? -eq 0 ]; then
    echo "Push successful!"
  else
    echo "Push failed. You may need to push manually."
  fi
else
  echo "No remote 'origin' configured, skipping push"
fi

echo "=== Commit Tracker Push Complete ==="
${
  settings.autoClose
    ? 'echo "Terminal will close in ${settings.timeout} seconds..."; sleep ${settings.timeout}'
    : 'echo "Terminal will remain open"'
}
`;

    // Use FileSystemService to create the script file
    const scriptPath = path.join(os.tmpdir(), `git-push-${Date.now()}.sh`);

    const writeResult = await this.fileSystemService.writeFile(
      scriptPath,
      scriptContent,
      { mode: 0o755 } // Make script executable
    );

    if (writeResult.isFailure()) {
      this.logService?.error(
        `Failed to create push script: ${writeResult.error}`
      );
      return failure(writeResult.error);
    }

    this.logService?.info(`Created push script at: ${scriptPath}`);
    return success(scriptPath);
  }
}
