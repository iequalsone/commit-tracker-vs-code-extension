import * as vscode from "vscode";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

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

  /**
   * Gets the current branch name
   * @param workspaceRoot Optional workspace root path
   * @returns The current branch name or null if not in a git repository
   */
  public async getCurrentBranch(
    workspaceRoot?: string
  ): Promise<string | null> {
    try {
      const path = workspaceRoot || this.getWorkspaceRoot();
      if (!path) {
        return null;
      }

      // Generate cache key
      const cacheKey = `branch:${path}`;

      // Try to get from cache
      const cachedValue = this.getFromCache(cacheKey);
      if (cachedValue !== null) {
        return cachedValue;
      }

      const branchName = execSync("git symbolic-ref --short HEAD", {
        cwd: path,
      })
        .toString()
        .trim();

      // Store in cache
      this.setInCache(cacheKey, branchName);

      return branchName;
    } catch (error) {
      // Not in a git repository or git command failed
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

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    return scriptPath;
  }

  /**
   * Gets the path of the current workspace root
   * @returns The workspace path or null if no workspace is open
   */
  private getWorkspaceRoot(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    return workspaceFolders[0].uri.fsPath;
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
      // Generate a cache key for this command
      const cacheKey = `cmd:${repoPath}:${command}`;

      // Only cache read operations (get, show, status, etc.)
      // Don't cache write operations (push, pull, commit, etc.)
      const isReadOperation =
        !command.includes("push") &&
        !command.includes("pull") &&
        !command.includes("commit") &&
        !command.includes("add") &&
        !command.includes("checkout") &&
        !command.includes("merge");

      // Try to get from cache for read operations
      if (isReadOperation) {
        const cachedValue = this.getFromCache(cacheKey);
        if (cachedValue !== null) {
          return cachedValue;
        }
      }

      // Check that the path exists
      if (!fs.existsSync(repoPath)) {
        throw new Error(`Repository path does not exist: ${repoPath}`);
      }

      // Set up custom environment variables to help with Git credential handling
      const env = { ...process.env };

      // Add GIT_TERMINAL_PROMPT=0 to prevent Git from trying to prompt for credentials
      // which will cause the command to hang in VS Code
      env.GIT_TERMINAL_PROMPT = "0";

      // Execute the command with the specified timeout and custom environment
      const { stdout, stderr } = await new Promise<{
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const childProcess = execSync(`git -C "${repoPath}" ${command}`, {
          timeout,
          env,
          encoding: "utf8",
        });

        resolve({ stdout: childProcess.toString(), stderr: "" });
      });

      // Cache the result for read operations
      if (isReadOperation) {
        this.setInCache(cacheKey, stdout.trim());
      } else {
        // For write operations, invalidate any cache for this repo
        this.invalidateCache(repoPath);
      }

      return stdout.trim();
    } catch (error) {
      if (error instanceof Error) {
        // Add more detailed logging for timeouts
        if (error.message.includes("timed out")) {
          throw new Error(
            `Git command timed out after ${timeout}ms: ${command} in ${repoPath}`
          );
        }
        throw error;
      }
      throw new Error(`Unknown error executing git command: ${command}`);
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
}
