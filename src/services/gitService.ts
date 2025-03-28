import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { exec, execSync } from "child_process";
import { ITerminalProvider, ITerminal } from "./interfaces/ITerminalProvider";
import { ILogService } from "./interfaces/ILogService";
import { IWorkspaceProvider } from "./interfaces/IWorkspaceProvider";
import { IFileSystemService } from "./interfaces/IFileSystemService";
import { promisify } from "util";

// Cache interface for storing git operation results
interface GitCache {
  [key: string]: {
    result: any;
    timestamp: number;
  };
}

/**
 * Default implementation of IFileSystemService using Node.js fs module
 */
class DefaultFileSystemService implements IFileSystemService {
  private fs = require("fs");

  writeFile(path: string, content: string, options?: { mode?: number }): void {
    this.fs.writeFileSync(path, content, options);
  }

  exists(path: string): boolean {
    return this.fs.existsSync(path);
  }
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
  constructor(options?: {
    logService?: ILogService;
    terminalProvider?: ITerminalProvider;
    workspaceProvider?: IWorkspaceProvider;
    fileSystemService?: IFileSystemService;
  }) {
    this.logService = options?.logService;
    this.terminalProvider = options?.terminalProvider;
    this.workspaceProvider = options?.workspaceProvider;
    this.fileSystemService =
      options?.fileSystemService || new DefaultFileSystemService();
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
        this.logService.error("Terminal provider not available");
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
  ): Promise<string | null> {
    try {
      const root = workspaceRoot || this.getWorkspaceRoot();
      if (!root) {
        if (this.logService) {
          this.logService.warn(
            "No workspace root available for git operations"
          );
        }
        return null;
      }

      // Use cache if available
      const cacheKey = `branch:${root}`;
      const cachedBranch = this.getFromCache(cacheKey, 5000); // Short TTL for branch
      if (cachedBranch) {
        return cachedBranch;
      }

      const branch = await this.executeGitCommand(
        root,
        "rev-parse --abbrev-ref HEAD"
      );

      // Cache the result
      this.setInCache(cacheKey, branch, 5000);
      return branch;
    } catch (error) {
      if (this.logService) {
        this.logService.error("Failed to get current branch", error);
      }
      return null;
    }
  }

  /**
   * Checks if there are any unpushed commits
   * @param workspaceRoot Optional workspace root path
   * @returns True if there are unpushed commits
   */
  public async hasUnpushedCommits(workspaceRoot?: string): Promise<boolean> {
    try {
      const path = workspaceRoot || this.getWorkspaceRoot();
      if (!path) {
        return false;
      }

      // Get current branch
      const branch = await this.getCurrentBranch(path);
      if (!branch) {
        return false;
      }

      // Generate cache key - shorter TTL for unpushed commits
      const cacheKey = `unpushed:${path}:${branch}`;

      // Try to get from cache with shorter TTL
      const cachedValue = this.getFromCache(cacheKey, 30 * 1000); // 30 seconds TTL
      if (cachedValue !== null) {
        return cachedValue;
      }

      // Check for unpushed commits
      const result = execSync(`git cherry -v origin/${branch}`, {
        cwd: path,
      }).toString();

      const hasUnpushed = result.trim().length > 0;

      // Store in cache
      this.setInCache(cacheKey, hasUnpushed);

      return hasUnpushed;
    } catch (error) {
      // This can fail if the branch doesn't exist on remote or other git issues
      // In case of an error, we assume there are unpushed commits
      return true;
    }
  }

  /**
   * Gets the commit message for a specific commit
   * @param repoPath Path to the repository
   * @param commitHash Commit hash to get the message for
   * @returns The commit message
   */
  public async getCommitMessage(
    repoPath: string,
    commitHash: string
  ): Promise<string> {
    try {
      if (!commitHash) {
        throw new Error("Commit hash is required");
      }

      // Generate cache key - commit messages never change for a given hash
      const cacheKey = `commit:message:${repoPath}:${commitHash}`;

      // Try to get from cache with long TTL
      const cachedValue = this.getFromCache(cacheKey, 24 * 60 * 60 * 1000); // 24 hours TTL
      if (cachedValue !== null) {
        return cachedValue;
      }

      // Get the commit message using the git show command
      const message = execSync(`git show -s --format=%B ${commitHash}`, {
        cwd: repoPath,
      })
        .toString()
        .trim();

      // Store in cache
      this.setInCache(cacheKey, message);

      return message;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Gets the author details for a specific commit
   * @param repoPath Path to the repository
   * @param commitHash Commit hash to get the author for
   * @returns The author details in "Name <email>" format
   */
  public async getCommitAuthorDetails(
    repoPath: string,
    commitHash: string
  ): Promise<string> {
    try {
      if (!commitHash) {
        throw new Error("Commit hash is required");
      }

      // Generate cache key - author never changes for a given hash
      const cacheKey = `commit:author:${repoPath}:${commitHash}`;

      // Try to get from cache with long TTL
      const cachedValue = this.getFromCache(cacheKey, 24 * 60 * 60 * 1000); // 24 hours TTL
      if (cachedValue !== null) {
        return cachedValue;
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

      return author;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Gets the repository name from the remote URL
   * @param repoPath Path to the repository
   * @returns The repository name
   */
  public async getRepoNameFromRemote(repoPath: string): Promise<string> {
    try {
      // Generate cache key
      const cacheKey = `repo:name:${repoPath}`;

      // Try to get from cache with longer TTL
      const cachedValue = this.getFromCache(cacheKey, 30 * 60 * 1000); // 30 minutes TTL
      if (cachedValue !== null) {
        return cachedValue;
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
        return path.basename(repoPath);
      }

      // If no remote origin is found, use the directory name
      if (!remoteUrl) {
        return path.basename(repoPath);
      }

      // Remove .git suffix if present
      if (remoteUrl.endsWith(".git")) {
        remoteUrl = remoteUrl.slice(0, -4);
      }

      // Extract the repository name from the URL
      const repoName = path.basename(remoteUrl);

      // Store in cache
      this.setInCache(cacheKey, repoName);

      return repoName;
    } catch (error) {
      // Fall back to using the directory name
      return path.basename(repoPath);
    }
  }

  /**
   * Pulls changes from the tracking repository
   * @param repoPath Path to the log file directory
   * @returns A promise that resolves when the pull is complete
   */
  public async pullChanges(repoPath: string): Promise<void> {
    try {
      // Check if this is a git repository
      if (!fs.existsSync(path.join(repoPath, ".git"))) {
        return;
      }

      // First, check if there's actually an origin remote
      try {
        const remotes = execSync("git remote", {
          cwd: repoPath,
        })
          .toString()
          .trim();

        if (!remotes.includes("origin")) {
          return;
        }
      } catch (error) {
        return;
      }

      // Check for tracking branch without failing if there isn't one
      try {
        const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: repoPath,
        })
          .toString()
          .trim();

        const trackingBranch = execSync(
          `git for-each-ref --format='%(upstream:short)' $(git symbolic-ref -q HEAD)`,
          { cwd: repoPath }
        )
          .toString()
          .trim();

        if (!trackingBranch) {
          return;
        }

        // Do the pull
        execSync("git pull --rebase", {
          cwd: repoPath,
          timeout: 30000, // 30 seconds timeout
        });

        // Invalidate cache for this repo
        this.invalidateCache(repoPath);
      } catch (error) {
        // This could happen if there's no upstream branch set
      }
    } catch (error) {
      // Log error but don't throw - allow the extension to continue
      throw error;
    }
  }

  /**
   * Creates a script to push changes in a VS Code terminal
   * @param repoPath Path to the repository
   * @param filePath Path to the file that was changed
   * @returns The path to the created script
   */
  public createPushScript(repoPath: string, filePath: string): string {
    // Create a temporary shell script with detailed logging
    const scriptPath = path.join(os.tmpdir(), `git-push-${Date.now()}.sh`);

    // Write a more streamlined script for terminal use that will self-close
    const scriptContent = `#!/bin/bash
# Commit-tracker push script
echo "=== Commit Tracker Automatic Push ==="
echo "Repository: ${repoPath}"

# Change to the repository directory
cd "${repoPath}"

# Stage the file
echo "Adding file: ${filePath}"
git add "${filePath}"

# Commit changes if needed
if git status --porcelain | grep -q .; then
  echo "Changes detected, committing..."
  git commit -m "Update commit log - $(date -Iseconds)"
  echo "Commit successful"
else
  echo "No changes to commit"
  sleep 2 # Give user time to see the message
  exit 0
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
  
  # Check if push succeeded
  if [ $? -eq 0 ]; then
    echo "Push successful!"
  else
    echo "Push failed, trying with upstream tracking..."
    git push -u origin $CURRENT_BRANCH
    
    if [ $? -eq 0 ]; then
      echo "Push with upstream tracking successful!"
    else
      exit 1
    fi
  fi
else
  echo "No remote 'origin' configured, skipping push"
fi

echo "=== Commit Tracker Push Complete ==="
echo "Terminal will close in 3 seconds..."
sleep 3
`;

    this.fileSystemService.writeFile(scriptPath, scriptContent, {
      mode: 0o755,
    });
    return scriptPath;
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

  // Add after the existing methods in GitService class

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
   * @returns Path to the created script
   */
  public createGitScript(
    repoPath: string,
    command: string,
    scriptName: string = "git-operation"
  ): string {
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

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    return scriptPath;
  }

  /**
   * Checks if a path is a Git repository
   * @param repoPath Path to check
   * @returns True if the path is a Git repository
   */
  public isGitRepository(repoPath: string): boolean {
    try {
      if (!fs.existsSync(repoPath)) {
        return false;
      }

      return fs.existsSync(path.join(repoPath, ".git"));
    } catch (error) {
      if (this.logService) {
        this.logService.error(
          `Error checking if path is a Git repository: ${error}`
        );
      }
      return false;
    }
  }

  /**
   * Gets the remote URL for a repository
   * @param repoPath Path to the repository
   * @returns The remote URL or null if not found
   */
  public getRemoteUrl(repoPath: string): string | null {
    try {
      // Generate cache key
      const cacheKey = `remote:url:${repoPath}`;

      // Try to get from cache with longer TTL
      const cachedValue = this.getFromCache(cacheKey, 30 * 60 * 1000); // 30 minutes TTL
      if (cachedValue !== null) {
        return cachedValue;
      }

      const remoteUrl = execSync("git remote get-url origin", {
        cwd: repoPath,
      })
        .toString()
        .trim();

      // Store in cache
      this.setInCache(cacheKey, remoteUrl);

      return remoteUrl;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get the short status of a repository
   * @param repoPath Path to the repository
   * @returns Short status string
   */
  public getShortStatus(repoPath: string): string {
    try {
      // Generate cache key
      const cacheKey = `status:short:${repoPath}`;

      // Try to get from cache with very short TTL (status changes frequently)
      const cachedValue = this.getFromCache(cacheKey, 5 * 1000); // 5 seconds TTL
      if (cachedValue !== null) {
        return cachedValue;
      }

      const status = execSync("git status --porcelain", {
        cwd: repoPath,
      })
        .toString()
        .trim();

      // Store in cache
      this.setInCache(cacheKey, status);

      return status;
    } catch (error) {
      if (this.logService) {
        this.logService.error(`Error getting short status: ${error}`);
      }
      return "";
    }
  }

  /**
   * Checks if a repository has changes
   * @param repoPath Path to the repository
   * @returns True if the repository has uncommitted changes
   */
  public hasUncommittedChanges(repoPath: string): boolean {
    try {
      const status = this.getShortStatus(repoPath);
      return status.length > 0;
    } catch (error) {
      if (this.logService) {
        this.logService.error(
          `Error checking for uncommitted changes: ${error}`
        );
      }
      return false;
    }
  }

  /**
   * Creates a push script with specific options
   * @param repoPath Path to the repository
   * @param filePath Path to the file being committed
   * @param options Additional options for the script
   * @returns Path to the created script
   */
  public createAdvancedPushScript(
    repoPath: string,
    filePath: string,
    options: {
      commitMessage?: string;
      showOutput?: boolean;
      autoClose?: boolean;
      timeout?: number;
    } = {}
  ): string {
    // Default options
    const defaults = {
      commitMessage: `Update commit log - ${new Date().toISOString()}`,
      showOutput: true,
      autoClose: true,
      timeout: 5,
    };

    const settings = { ...defaults, ...options };

    // Create a temporary shell script
    const scriptPath = path.join(os.tmpdir(), `git-push-${Date.now()}.sh`);

    // Build a more customizable script
    const scriptContent = `#!/bin/bash
  # Commit-tracker push script
  ${settings.showOutput ? 'echo "=== Commit Tracker Automatic Push ==="' : ""}
  ${settings.showOutput ? `echo "Repository: ${repoPath}"` : ""}
  
  # Change to the repository directory
  cd "${repoPath}" || { ${
      settings.showOutput
        ? 'echo "Failed to change to repository directory"'
        : ""
    }; exit 1; }
  
  # Stage the file
  ${settings.showOutput ? `echo "Adding file: ${filePath}"` : ""}
  git add "${filePath}"
  
  # Commit changes if needed
  if git status --porcelain | grep -q .; then
    ${settings.showOutput ? 'echo "Changes detected, committing..."' : ""}
    git commit -m "${settings.commitMessage}"
    ${settings.showOutput ? 'echo "Commit successful"' : ""}
  else
    ${settings.showOutput ? 'echo "No changes to commit"' : ""}
    ${settings.autoClose ? `sleep 2` : ""}
    exit 0
  fi
  
  # Check if remote exists
  if git remote | grep -q origin; then
    ${settings.showOutput ? "echo \"Remote 'origin' exists\"" : ""}
    
    # Get current branch
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    ${settings.showOutput ? 'echo "Current branch: $CURRENT_BRANCH"' : ""}
    
    # Push changes
    ${
      settings.showOutput
        ? 'echo "Pushing changes to origin/$CURRENT_BRANCH..."'
        : ""
    }
    git push
    
    # Check if push succeeded
    if [ $? -eq 0 ]; then
      ${settings.showOutput ? 'echo "Push successful!"' : ""}
    else
      ${
        settings.showOutput
          ? 'echo "Push failed, trying with upstream tracking..."'
          : ""
      }
      git push -u origin $CURRENT_BRANCH
      
      if [ $? -eq 0 ]; then
        ${
          settings.showOutput
            ? 'echo "Push with upstream tracking successful!"'
            : ""
        }
      else
        exit 1
      fi
    fi
  else
    ${
      settings.showOutput
        ? "echo \"No remote 'origin' configured, skipping push\""
        : ""
    }
  fi
  
  ${settings.showOutput ? 'echo "=== Commit Tracker Push Complete ==="' : ""}
  ${
    settings.autoClose
      ? `${
          settings.showOutput
            ? `echo "Terminal will close in ${settings.timeout} seconds..."`
            : ""
        }`
      : ""
  }
  ${settings.autoClose ? `sleep ${settings.timeout}` : ""}
  `;

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    return scriptPath;
  }
}
