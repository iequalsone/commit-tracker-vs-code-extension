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

  const url = origin.refs.fetch;

  // Handle HTTPS URLs: https://github.com/owner/repo.git
  // Handle SSH URLs: git@github.com:owner/repo.git
  const match = url.match(/(?:\/|:)([^\/]+\/[^\/]+?)(?:\.git)?$/);

  if (!match) {
    throw new Error('Could not parse repository name from remote URL');
  }

  const [owner, repo] = match[1].split('/');
  return `${owner}/${repo}`;
}

export async function getCommitAuthorDetails(repoPath: string, commitId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git show -s --format="%an <%ae>" ${commitId}`, { cwd: repoPath }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function getCommitMessage(repoPath: string, commitId: string): Promise<string> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.SourceControl,
    title: 'Fetching commit message...',
    cancellable: false,

  }, async (progress, token) => {
    return new Promise((resolve, reject) => {
      const sanitizedRepoPath = shellEscape([repoPath]);
      const sanitizedCommitId = shellEscape([commitId]);
      exec(`git show -s --format=%B ${sanitizedCommitId}`, { cwd: sanitizedRepoPath }, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout.trim());
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