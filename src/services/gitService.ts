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

    logInfo("Push operation completed successfully");
  } catch (error) {
    logError(`Overall error in push operation: ${error}`);
    throw error;
  }
}

/**
 * Pushes changes to the tracking repository by running a shell script in a VS Code terminal
 * @param logFilePath Path to the log file directory
 * @param filePath Path to the file that was changed
 * @returns A promise that resolves when the push operation has been started
 */
export async function pushChangesWithShellScript(
  logFilePath: string,
  filePath: string
): Promise<void> {
  try {
    logInfo(`Pushing changes to tracking repository using VS Code terminal`);

    // Create a temporary shell script with detailed logging
    const scriptPath = path.join(os.tmpdir(), `git-push-${Date.now()}.sh`);

    // Write a more streamlined script for terminal use that will self-close
    const scriptContent = `#!/bin/bash
# Commit-tracker push script
echo "=== Commit Tracker Automatic Push ==="
echo "Repository: ${logFilePath}"

# Change to the repository directory
cd "${logFilePath}"

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
      echo "All push attempts failed. Changes committed locally only."
      echo "Terminal will close in 5 seconds..."
      sleep 5
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

    logInfo(`Created temporary script at ${scriptPath}`);

    // Use the VS Code API to create a terminal and run the script
    const vscode = require("vscode");

    // Create a terminal that will be automatically closed
    const terminal = vscode.window.createTerminal({
      name: "Commit Tracker",
      hideFromUser: false, // Initially show to the user
    });

    terminal.show();

    // Run the script and add a command to close the terminal when done
    // The 'exit' at the end will close the terminal when the script completes
    terminal.sendText(`bash "${scriptPath}" && exit || exit`);

    // Schedule cleanup of the script file
    setTimeout(() => {
      try {
        fs.unlinkSync(scriptPath);
        logInfo(`Removed temporary script: ${scriptPath}`);
      } catch (e) {
        logInfo(`Failed to remove temporary script: ${e}`);
      }
    }, 10000);

    // Return immediately; we can't wait for the terminal to finish
    logInfo(`Push operation started in terminal (will auto-close)`);

    // Schedule a status update after a reasonable time
    setTimeout(() => {
      try {
        // Trigger status update to refresh unpushed status indicator
        const vscode = require("vscode");
        vscode.commands.executeCommand("commit-tracker.checkUnpushedStatus");
        logInfo(`Scheduled status update after push`);
      } catch (error) {
        logInfo(`Failed to schedule status update: ${error}`);
      }
    }, 10000); // Wait a bit longer to allow push to complete
  } catch (error) {
    logError(`Failed to push changes with shell script: ${error}`);
    // Don't rethrow - allow the extension to continue
  }
}

/**
 * Checks if there are unpushed commits in the tracking repository
 * @param logFilePath Path to the log file directory
 * @returns A promise that resolves to true if there are unpushed commits
 */
export async function hasUnpushedCommits(
  logFilePath: string
): Promise<boolean> {
  try {
    if (!fs.existsSync(path.join(logFilePath, ".git"))) {
      return false; // Not a git repository
    }

    // Check if remote exists
    const remotes = await executeGitCommand(logFilePath, "remote");
    if (!remotes.includes("origin")) {
      return false; // No origin remote
    }

    // Get current branch
    const currentBranch = await executeGitCommand(
      logFilePath,
      "rev-parse --abbrev-ref HEAD"
    );

    // Check if there's a tracking branch
    try {
      const trackingBranch = await executeGitCommand(
        logFilePath,
        `rev-parse --abbrev-ref ${currentBranch}@{upstream}`
      );

      if (!trackingBranch) {
        return false; // No tracking branch
      }

      // Check for unpushed commits
      const unpushedCount = await executeGitCommand(
        logFilePath,
        `rev-list --count ${trackingBranch}..${currentBranch}`
      );

      return parseInt(unpushedCount, 10) > 0;
    } catch (error) {
      return false; // No tracking branch or other error
    }
  } catch (error) {
    logError(`Error checking for unpushed commits: ${error}`);
    return false;
  }
}

/**
 * Pushes changes to the tracking repository using a hidden process
 * @param logFilePath Path to the log file directory
 * @param filePath Path to the file that was changed
 * @returns A promise that resolves when the push operation has started
 */
export async function pushChangesWithHiddenTerminal(
  logFilePath: string,
  filePath: string
): Promise<void> {
  try {
    logInfo(`Pushing changes to tracking repository using hidden process`);

    // Create a temporary shell script
    const scriptPath = path.join(os.tmpdir(), `git-push-${Date.now()}.sh`);
    const logFileName = path.join(
      os.tmpdir(),
      `git-push-log-${Date.now()}.txt`
    );

    // Write a more robust script with error handling and logging
    const scriptContent = `#!/bin/bash
# Commit-tracker hidden push script

# Log both to stdout and a file
exec > >(tee "${logFileName}") 2>&1

echo "=== Commit Tracker Background Push ==="
echo "Started at: $(date -Iseconds)"
echo "Repository: ${logFilePath}"
echo "File: ${filePath}"

# Change to the repository directory
cd "${logFilePath}" || { echo "Failed to change to repository directory"; exit 1; }

# Get current status before changes
echo "Git status before:"
git status

# Stage the file
echo "Adding file: ${filePath}"
git add "${filePath}"
if [ $? -ne 0 ]; then
  echo "Failed to add file"
  exit 1
fi

# Check if there are changes to commit
if git status --porcelain | grep -q .; then
  echo "Changes detected, committing..."
  git commit -m "Update commit log - $(date -Iseconds)"
  if [ $? -ne 0 ]; then
    echo "Failed to commit changes"
    exit 1
  fi
  echo "Commit successful"
else
  echo "No changes to commit"
  exit 0
fi

# Check if remote exists
if git remote | grep -q origin; then
  echo "Remote 'origin' exists"
  
  # Get current branch
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  echo "Current branch: $CURRENT_BRANCH"
  
  # Try to push with full authentication allowed and higher timeout
  echo "Pushing changes..."
  export GIT_TERMINAL_PROMPT=1
  export GIT_ASKPASS=
  
  # First try: normal push
  echo "Attempt 1: Standard push"
  git push
  PUSH_RESULT=$?
  
  if [ $PUSH_RESULT -ne 0 ]; then
    echo "Standard push failed with code $PUSH_RESULT"
    
    # Second try: push with upstream setting
    echo "Attempt 2: Push with upstream tracking"
    git push -u origin $CURRENT_BRANCH
    PUSH_RESULT=$?
    
    if [ $PUSH_RESULT -ne 0 ]; then
      echo "Push with upstream tracking failed with code $PUSH_RESULT"
      
      # Third try: force push
      echo "Attempt 3: Force push"
      git push --force-with-lease
      PUSH_RESULT=$?
      
      if [ $PUSH_RESULT -ne 0 ]; then
        echo "Force push failed with code $PUSH_RESULT"
        echo "All push attempts failed"
        echo "Repository status after failed pushes:"
        git status
        exit 1
      else
        echo "Force push successful"
      fi
    else
      echo "Push with upstream tracking successful"
    fi
  else
    echo "Standard push successful"
  fi
else
  echo "No remote 'origin' configured, skipping push"
fi

echo "Repository status after operations:"
git status

echo "=== Push operation completed at $(date -Iseconds) ==="
exit 0
`;

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    logInfo(`Created temporary script at ${scriptPath}`);

    // Execute the script in a process that can handle credentials properly
    return new Promise<void>((resolve) => {
      const { exec } = require("child_process");

      // Set a longer timeout for network operations
      const childProcess = exec(
        `bash "${scriptPath}"`,
        { timeout: 60000 },
        (error: any, stdout: string, stderr: string) => {
          // Log the output regardless of result
          if (fs.existsSync(logFileName)) {
            try {
              const logContent = fs.readFileSync(logFileName, "utf8");
              logInfo(`Push script output:\n${logContent}`);

              // Check the log for push success
              if (
                logContent.includes("push successful") ||
                logContent.includes("Push successful")
              ) {
                logInfo("Push operation completed successfully");

                // Schedule a status update
                setTimeout(() => {
                  try {
                    const vscode = require("vscode");
                    vscode.commands.executeCommand(
                      "commit-tracker.checkUnpushedStatus"
                    );
                  } catch (e) {
                    // Ignore errors updating status
                  }
                }, 2000);
              } else if (logContent.includes("All push attempts failed")) {
                logError(
                  "All push attempts failed, changes committed locally only"
                );
              }

              // Cleanup log file
              fs.unlinkSync(logFileName);
            } catch (readError) {
              logError(`Failed to read push log: ${readError}`);
            }
          }

          // Clean up the script file
          try {
            fs.unlinkSync(scriptPath);
            logInfo(`Removed temporary script: ${scriptPath}`);
          } catch (e) {
            logInfo(`Failed to remove temporary script: ${e}`);
          }

          if (error) {
            logError(`Push script exited with error: ${error}`);
            // Don't reject, we've already logged the commit successfully
          }

          // Always resolve, since we've already logged the commit
          resolve();
        }
      );

      // Capture real-time output if possible
      if (childProcess.stdout) {
        childProcess.stdout.on("data", (data: Buffer) => {
          logInfo(`Push output: ${data.toString().trim()}`);
        });
      }

      if (childProcess.stderr) {
        childProcess.stderr.on("data", (data: Buffer) => {
          logInfo(`Push stderr: ${data.toString().trim()}`);
        });
      }

      logInfo(`Push operation started in background`);
    });
  } catch (error) {
    logError(`Failed to push changes with hidden process: ${error}`);
    // Don't throw - we want to continue even if push setup fails
  }
}
