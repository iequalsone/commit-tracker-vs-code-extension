import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { logInfo, logError } from "../utils/logger";

const execAsync = promisify(exec);

/**
 * Executes a git command in the specified repository path
 * @param repoPath Path to the repository
 * @param command Git command to execute
 * @param options Optional execution options
 * @returns The output of the command
 */
export async function executeGitCommand(
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
    logInfo(
      `Executing git command in ${repoPath}: ${command} (timeout: ${timeout}ms)`
    );

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
    const { stdout, stderr } = await execAsync(
      `git -C "${repoPath}" ${command}`,
      {
        timeout,
        env,
      }
    );

    if (stderr && !stderr.includes("Warning")) {
      logInfo(`Git command produced stderr: ${stderr}`);
    }

    return stdout.trim();
  } catch (error) {
    if (error instanceof Error) {
      // Add more detailed logging for timeouts
      if (error.message.includes("timed out")) {
        logError(
          `Git command timed out after ${timeout}ms: ${command} in ${repoPath}`
        );
      }

      logError(`Git command failed in ${repoPath} with command: ${command}`);
      logError(`Error message: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Gets the commit message for a specific commit
 * @param repoPath Path to the repository
 * @param commitHash Commit hash to get the message for
 * @returns The commit message
 */
export async function getCommitMessage(
  repoPath: string,
  commitHash: string
): Promise<string> {
  try {
    logInfo(`Getting commit message for: ${commitHash} in ${repoPath}`);

    if (!commitHash) {
      throw new Error("Commit hash is required");
    }

    // Get the commit message using the git show command
    const message = await executeGitCommand(
      repoPath,
      `show -s --format=%B ${commitHash}`
    );

    logInfo(
      `Retrieved commit message: ${message.substring(0, 50)}${
        message.length > 50 ? "..." : ""
      }`
    );
    return message;
  } catch (error) {
    logError(`Failed to get commit message: ${error}`);
    throw error;
  }
}

/**
 * Gets the author details for a specific commit
 * @param repoPath Path to the repository
 * @param commitHash Commit hash to get the author for
 * @returns The author details in "Name <email>" format
 */
export async function getCommitAuthorDetails(
  repoPath: string,
  commitHash: string
): Promise<string> {
  try {
    logInfo(`Getting author for: ${commitHash} in ${repoPath}`);

    if (!commitHash) {
      throw new Error("Commit hash is required");
    }

    // Get the author using the git show command
    const author = await executeGitCommand(
      repoPath,
      `show -s --format="%an <%ae>" ${commitHash}`
    );

    logInfo(`Retrieved commit author: ${author}`);
    return author;
  } catch (error) {
    logError(`Failed to get commit author: ${error}`);
    throw error;
  }
}

/**
 * Gets the repository name from the remote URL
 * @param repoPath Path to the repository
 * @returns The repository name
 */
export async function getRepoNameFromRemote(repoPath: string): Promise<string> {
  try {
    logInfo(`Getting repository name from remote for: ${repoPath}`);

    // Get the remote URL
    let remoteUrl = "";
    try {
      remoteUrl = await executeGitCommand(
        repoPath,
        "config --get remote.origin.url"
      );
    } catch (error) {
      // Silently handle the case where there's no remote configured
      logInfo("No remote origin found, using directory name");
      return path.basename(repoPath);
    }

    // If no remote origin is found, use the directory name
    if (!remoteUrl) {
      logInfo("No remote origin URL found, using directory name");
      return path.basename(repoPath);
    }

    // Remove .git suffix if present
    if (remoteUrl.endsWith(".git")) {
      remoteUrl = remoteUrl.slice(0, -4);
    }

    // Extract the repository name from the URL
    const repoName = path.basename(remoteUrl);
    logInfo(`Retrieved repository name: ${repoName}`);
    return repoName;
  } catch (error) {
    logError(`Failed to get repository name: ${error}`);
    // Fall back to using the directory name
    return path.basename(repoPath);
  }
}

/**
 * Pulls changes from the tracking repository
 * @param logFilePath Path to the log file directory
 * @returns A promise that resolves when the pull is complete
 */
export async function pullChanges(logFilePath: string): Promise<void> {
  try {
    logInfo(`Pulling changes from tracking repository at: ${logFilePath}`);

    // Check if this is a git repository
    if (!fs.existsSync(path.join(logFilePath, ".git"))) {
      logInfo(`${logFilePath} is not a git repository, skipping pull`);
      return;
    }

    // First, check if there's actually an origin remote
    try {
      const remotes = await executeGitCommand(logFilePath, "remote");
      if (!remotes.includes("origin")) {
        logInfo("No origin remote configured, skipping pull");
        return;
      }
    } catch (error) {
      logInfo(`Error checking remotes: ${error}, continuing without pull`);
      return;
    }

    // Check for tracking branch without failing if there isn't one
    try {
      const currentBranch = await executeGitCommand(
        logFilePath,
        "rev-parse --abbrev-ref HEAD"
      );
      const trackingBranch = await executeGitCommand(
        logFilePath,
        `rev-parse --abbrev-ref ${currentBranch}@{upstream}`
      );

      if (!trackingBranch) {
        logInfo(`No upstream branch set for ${currentBranch}, skipping pull`);
        return;
      }

      logInfo(
        `Found tracking branch: ${trackingBranch} for current branch: ${currentBranch}`
      );
      await executeGitCommand(logFilePath, "pull --rebase");
      logInfo("Successfully pulled changes from tracking repository");
    } catch (error) {
      // This could happen if there's no upstream branch set
      logInfo(`Error during pull: ${error}, continuing without pull`);
    }
  } catch (error) {
    // Log error but don't throw - allow the extension to continue
    logError(`Failed to pull changes: ${error}`);
  }
}

/**
 * Pushes changes to the tracking repository
 * @param logFilePath Path to the log file directory
 * @param filePath Path to the file that was changed
 * @returns A promise that resolves when the push is complete
 */
export async function pushChanges(
  logFilePath: string,
  filePath: string
): Promise<void> {
  try {
    logInfo(`Pushing changes to tracking repository at: ${logFilePath}`);

    // Check if this is a git repository
    if (!fs.existsSync(path.join(logFilePath, ".git"))) {
      logInfo(`${logFilePath} is not a git repository, skipping push`);
      return;
    }

    // Stage the file
    try {
      await executeGitCommand(logFilePath, `add "${filePath}"`);
      logInfo(`Added file: ${filePath}`);
    } catch (error) {
      logError(`Failed to add file: ${error}`);
      return;
    }

    // Check if there are changes to commit
    const status = await executeGitCommand(logFilePath, "status --porcelain");
    if (!status) {
      logInfo("No changes to commit");
      return;
    }

    // Commit the changes
    const timestamp = new Date().toISOString();
    await executeGitCommand(
      logFilePath,
      `commit -m "Update commit log - ${timestamp}"`
    );
    logInfo("Committed changes successfully");

    // Check if there's a remote origin
    try {
      const remotes = await executeGitCommand(logFilePath, "remote");
      if (!remotes.includes("origin")) {
        logInfo("No origin remote configured, skipping push");
        return;
      }

      // Get current branch
      const currentBranch = await executeGitCommand(
        logFilePath,
        "rev-parse --abbrev-ref HEAD"
      );

      // Try direct push first
      try {
        await executeGitCommand(logFilePath, "push");
        logInfo("Successfully pushed changes to tracking repository");
        return;
      } catch (error) {
        logInfo(`Standard push failed, trying with -u: ${error}`);

        try {
          // Try push with upstream tracking
          await executeGitCommand(
            logFilePath,
            `push -u origin ${currentBranch}`
          );
          logInfo("Successfully pushed changes with -u option");
        } catch (pushError) {
          // If all else fails, try force push as a last resort
          logInfo(
            `Push with -u failed: ${pushError}, trying with force option`
          );

          try {
            await executeGitCommand(logFilePath, `push --force-with-lease`);
            logInfo("Successfully force pushed changes to tracking repository");
          } catch (forceError) {
            logError(`Force push failed: ${forceError}`);
            logInfo("Changes committed locally only");
          }
        }
      }
    } catch (error) {
      logInfo(`Error getting remote information: ${error}`);
      logInfo("Changes committed locally only");
      }
  } catch (error) {
    logError(`Overall error in push operation: ${error}`);
    // This error is logged but not rethrown
  }
}

/**
 * Pushes changes to the tracking repository using spawn (which can handle interactive prompts better)
 * @param logFilePath Path to the log file directory
 * @param filePath Path to the file that was changed
 * @returns A promise that resolves when the push is complete
 */
export async function pushChangesWithSpawn(
  logFilePath: string,
  filePath: string
): Promise<void> {
  const { spawn } = require("child_process");

  try {
    logInfo(
      `Pushing changes to tracking repository at: ${logFilePath} (using spawn)`
    );

    // Check if this is a git repository
    if (!fs.existsSync(path.join(logFilePath, ".git"))) {
      logInfo(`${logFilePath} is not a git repository, skipping push`);
      return;
    }

    // Stage the file
    await new Promise<void>((resolve, reject) => {
      logInfo(`Adding file: ${filePath}`);

      const addProcess = spawn("git", ["-C", logFilePath, "add", filePath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      addProcess.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      addProcess.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      addProcess.on("close", (code: number) => {
        if (code === 0) {
          logInfo("File added successfully");
          resolve();
        } else {
          logError(`Failed to add file: ${stderr}`);
          reject(new Error(`git add failed with code ${code}: ${stderr}`));
        }
      });
    });

    // Commit the changes
    await new Promise<void>((resolve, reject) => {
      const timestamp = new Date().toISOString();
      logInfo("Committing changes");

      const commitProcess = spawn(
        "git",
        ["-C", logFilePath, "commit", "-m", `Update commit log - ${timestamp}`],
        {
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";

      commitProcess.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      commitProcess.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      commitProcess.on("close", (code: number) => {
        if (code === 0) {
          logInfo("Changes committed successfully");
          resolve();
        } else {
          // Check if there were no changes to commit
          if (
            stderr.includes("nothing to commit") ||
            stderr.includes("no changes added to commit")
          ) {
            logInfo("No changes to commit");
            resolve();
            return;
          }

          logError(`Failed to commit changes: ${stderr}`);
          reject(new Error(`git commit failed with code ${code}: ${stderr}`));
        }
      });
    });

    // Push the changes
    await new Promise<void>((resolve, reject) => {
      logInfo("Pushing changes");

      const pushProcess = spawn("git", ["-C", logFilePath, "push"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      pushProcess.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        logInfo(`Push output: ${data.toString().trim()}`);
      });

      pushProcess.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
        logInfo(`Push stderr: ${data.toString().trim()}`);
      });

      pushProcess.on("close", (code: number) => {
        if (code === 0) {
          logInfo("Changes pushed successfully");
          resolve();
        } else {
          // Try one more time with -u option
          logInfo(`Standard push failed, trying with -u option`);

          const pushWithUProcess = spawn(
            "git",
            [
              "-C",
              logFilePath,
              "push",
              "-u",
              "origin",
              "main", // assuming main branch, you might want to make this configurable
            ],
            {
              stdio: ["ignore", "pipe", "pipe"],
            }
          );

          let uStdout = "";
          let uStderr = "";

          pushWithUProcess.stdout.on("data", (data: Buffer) => {
            uStdout += data.toString();
            logInfo(`Push -u output: ${data.toString().trim()}`);
          });

          pushWithUProcess.stderr.on("data", (data: Buffer) => {
            uStderr += data.toString();
            logInfo(`Push -u stderr: ${data.toString().trim()}`);
          });

          pushWithUProcess.on("close", (uCode: number) => {
            if (uCode === 0) {
              logInfo("Changes pushed successfully with -u option");
              resolve();
            } else {
              logError(`Failed to push changes: ${uStderr}`);
              reject(
                new Error(`git push failed with code ${uCode}: ${uStderr}`)
              );
            }
          });
        }
      });
    });
  });
}

export async function pushChanges(repoPath: string, trackingFilePath: string): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.SourceControl,
    title: 'Pushing changes...',
    cancellable: false
  }, async (ProgressLocation, token) => {
    const git: SimpleGit = simpleGit(repoPath);
    const remotes = await git.getRemotes(true);
    const hasOrigin = remotes.some(remote => remote.name === 'origin');

    if (!hasOrigin) {
      throw new Error('No origin remote configured for the repository.');
    }

    await git.add(trackingFilePath);
    await git.commit('Update commit log');
    await git.push('origin', 'main');
  });
}

export async function pullChanges(repoPath: string): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.SourceControl,
    title: 'Pulling latest changes...',
    cancellable: false
  }, async () => {
    const git: SimpleGit = simpleGit(repoPath);
    await git.pull('origin', 'main');
  });
}