import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GitHubService, GitHubRepo } from "../services/githubService";
import { logInfo, logError } from "./logger";

/**
 * Handles the onboarding setup wizard
 */
export class SetupWizard {
  private githubService: GitHubService;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.githubService = new GitHubService();
    this.context = context;
  }

  /**
   * Runs the setup wizard to configure the tracker repository
   */
  async run(): Promise<boolean> {
    try {
      logInfo("Starting setup wizard");

      // Check if setup has already been completed
      const setupComplete =
        this.context.globalState.get<boolean>("setupComplete");
      if (setupComplete) {
        logInfo("Setup already completed, skipping");

        // Ask user if they want to reconfigure
        const reconfigure = await vscode.window.showInformationMessage(
          "Commit Tracker is already configured. Do you want to reconfigure it?",
          "Yes",
          "No"
        );

        if (reconfigure !== "Yes") {
          return true;
        }

        logInfo("User chose to reconfigure");
      }

      // Show welcome message
      const welcomeResponse = await vscode.window.showInformationMessage(
        "Welcome to Commit Tracker! Would you like to set up your commit tracking repository?",
        "Yes, set up now",
        "No, I'll do it later"
      );

      if (welcomeResponse !== "Yes, set up now") {
        logInfo("User chose to postpone setup");
        return false;
      }

      // Authenticate with GitHub
      logInfo("Starting GitHub authentication");
      try {
        await this.githubService.authenticate();
        logInfo("GitHub authentication successful");
      } catch (error) {
        logError(`Authentication failed: ${error}`);
        vscode.window.showErrorMessage(
          `GitHub authentication failed: ${error}`
        );
        return false;
      }

      // Ask if the user wants to use an existing repo or create a new one
      logInfo("Prompting user to select repository setup method");
      const repoChoice = await vscode.window.showQuickPick(
        ["Use an existing repository", "Create a new repository"],
        {
          placeHolder: "How would you like to set up your tracking repository?",
        }
      );

      if (!repoChoice) {
        logInfo("User cancelled repository selection");
        return false; // User cancelled
      }

      let selectedRepo: GitHubRepo | undefined;

      if (repoChoice === "Create a new repository") {
        // Create new repo flow
        logInfo("User chose to create a new repository");
        selectedRepo = await this.createNewRepository();
        if (!selectedRepo) {
          logInfo("Repository creation cancelled or failed");
          return false; // User cancelled or creation failed
        }
      } else {
        // Select existing repo flow
        logInfo("User chose to use an existing repository");
        selectedRepo = await this.selectExistingRepository();
        if (!selectedRepo) {
          logInfo("Repository selection cancelled or failed");
          return false; // User cancelled or selection failed
        }
      }

      logInfo(`Selected repository: ${selectedRepo.full_name}`);

      // Clone the repository
      logInfo("Starting repository clone process");
      const localPath = await this.cloneRepository(selectedRepo);
      if (!localPath) {
        logInfo("Repository clone failed or was cancelled");
        vscode.window.showErrorMessage(
          "Failed to clone repository. Setup cancelled."
        );
        return false; // Cloning failed
      }

      logInfo(`Repository cloned successfully to: ${localPath}`);

      // Update configuration
      logInfo("Updating extension configuration");
      try {
        await this.updateConfiguration(localPath);
        logInfo("Configuration updated successfully");
      } catch (error) {
        logError(`Failed to update configuration: ${error}`);
        vscode.window.showErrorMessage(
          `Failed to update configuration: ${error}`
        );
        return false;
      }

      // Apply configuration to the current session
      // This is a workaround to ensure the configuration is available for verification
      const savedPath = this.context.globalState.get<string>(
        "configuredLogFilePath"
      );
      const savedFile =
        this.context.globalState.get<string>("configuredLogFile");
      if (savedPath) {
        logInfo(
          `Applying saved configuration from global state: path=${savedPath}, file=${savedFile}`
        );
        // Force update the current workspace session configuration (in-memory only)
        const config = vscode.workspace.getConfiguration("commitTracker");
        // Use the extension API to force the change in the current session
        if ("update" in config) {
          config.update(
            "logFilePath",
            savedPath,
            vscode.ConfigurationTarget.Global
          );
          config.update(
            "logFile",
            savedFile || "commits.log",
            vscode.ConfigurationTarget.Global
          );
        }
      }

      // Verify the setup
      logInfo("Verifying setup");
      const setupVerified = await this.verifySetup(localPath);
      if (!setupVerified) {
        logError("Setup verification failed");
        vscode.window.showErrorMessage(
          "Setup could not be verified. Some manual configuration may be required."
        );

        // Force manual configuration as a last resort
        const manualConfig = await vscode.window.showErrorMessage(
          "Setup verification failed. Would you like to manually verify the configuration?",
          "Yes",
          "No"
        );

        if (manualConfig === "Yes") {
          // Show the configuration details
          vscode.window.showInformationMessage(
            `Please verify these settings in your VS Code settings:\n` +
              `commitTracker.logFilePath: ${localPath}\n` +
              `commitTracker.logFile: commits.log`
          );

          // Open the VS Code settings UI focused on our extension
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "commitTracker"
          );
        }
      }

      // Mark setup as complete
      logInfo("Finalizing setup");
      await this.context.globalState.update("setupComplete", true);
      await this.context.globalState.update(
        "trackerRepoUrl",
        selectedRepo.html_url
      );

      vscode.window.showInformationMessage(
        `Commit Tracker setup complete! Your commits will be tracked in ${selectedRepo.full_name}.`
      );
      logInfo("Setup wizard completed successfully");

      return true;
    } catch (error) {
      logError(`Setup wizard failed with unexpected error: ${error}`);
      vscode.window.showErrorMessage(
        `Setup failed with unexpected error: ${error}`
      );
      return false;
    }
  }

  /**
   * Helps user create a new repository
   */
  private async createNewRepository(): Promise<GitHubRepo | undefined> {
    // Ask for repository name
    const repoName = await vscode.window.showInputBox({
      prompt: "Enter a name for your new tracking repository",
      placeHolder: "commit-tracker",
      validateInput: (value) => {
        return /^[a-zA-Z0-9_.-]+$/.test(value)
          ? null
          : "Repository name can only contain letters, numbers, hyphens, underscores and periods";
      },
    });

    if (!repoName) {
      logInfo("Repository creation cancelled");
      return undefined;
    }

    // Ask if the repo should be private (default) or public
    const visibility = await vscode.window.showQuickPick(
      ["Private", "Public"],
      {
        placeHolder: "Repository visibility",
        canPickMany: false,
      }
    );

    if (!visibility) {
      logInfo("Repository creation cancelled");
      return undefined;
    }

    const isPrivate = visibility === "Private";

    // Create the repository
    try {
      logInfo(`Creating new repository: ${repoName}, Private: ${isPrivate}`);
      return await this.githubService.createRepository(repoName, isPrivate);
    } catch (error) {
      logError(`Failed to create repository: ${error}`);
      vscode.window.showErrorMessage(`Failed to create repository: ${error}`);
      return undefined;
    }
  }

  /**
   * Helps user select an existing repository
   */
  private async selectExistingRepository(): Promise<GitHubRepo | undefined> {
    try {
      // Get user's repositories
      const repos = await this.githubService.getRepositories();

      if (repos.length === 0) {
        const createNewRepo = await vscode.window.showInformationMessage(
          "You don't have any GitHub repositories. Would you like to create one?",
          "Yes",
          "No"
        );

        if (createNewRepo === "Yes") {
          return await this.createNewRepository();
        } else {
          vscode.window.showErrorMessage("No repositories available");
          return undefined;
        }
      }

      // Let user pick a repository
      const selectedRepoItem = await vscode.window.showQuickPick(
        repos.map((repo) => ({
          label: repo.full_name,
          description: repo.private ? "Private" : "Public",
          detail: repo.html_url,
          repo: repo,
        })),
        { placeHolder: "Select a repository for commit tracking" }
      );

      if (!selectedRepoItem) {
        logInfo("Repository selection cancelled");
        return undefined;
      }

      return selectedRepoItem.repo;
    } catch (error) {
      logError(`Failed to select repository: ${error}`);
      vscode.window.showErrorMessage(`Failed to select repository: ${error}`);
      return undefined;
    }
  }

  /**
   * Clones the selected repository to a local folder using VS Code's git extension
   */
  private async cloneRepository(repo: GitHubRepo): Promise<string | undefined> {
    try {
      // Create a directory for commit tracking repos in user's home directory
      const baseDir = path.join(os.homedir(), ".commit-tracker");
      logInfo(`Creating base directory at: ${baseDir}`);

      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
        logInfo(`Base directory created successfully`);
      } else {
        logInfo(`Base directory already exists`);
      }

      const repoDir = path.join(baseDir, repo.name);
      logInfo(`Target repository directory: ${repoDir}`);

      // Check if directory exists and is not empty
      if (fs.existsSync(repoDir)) {
        logInfo(`Repository directory already exists`);
        const files = fs.readdirSync(repoDir);

        if (files.length > 0) {
          logInfo(
            `Directory is not empty, contains ${files.length} files/folders`
          );
          const overwrite = await vscode.window.showWarningMessage(
            `Directory ${repoDir} already exists and is not empty. Overwrite?`,
            "Yes",
            "No"
          );

          if (overwrite !== "Yes") {
            logInfo("User chose not to overwrite existing directory");
            return undefined;
          }

          // Remove existing directory
          logInfo(`Removing existing directory: ${repoDir}`);
          try {
            fs.rmSync(repoDir, { recursive: true, force: true });
            logInfo(`Successfully removed existing directory`);
          } catch (rmError) {
            logError(`Failed to remove directory: ${rmError}`);
            vscode.window.showErrorMessage(
              `Failed to remove existing directory: ${rmError}`
            );
            return undefined;
          }
        } else {
          logInfo(`Directory exists but is empty`);
        }
      } else {
        logInfo(
          `Repository directory does not exist yet, will be created during clone`
        );
      }

      // Instead of using execSync, we'll use the VS Code terminal
      // This approach will benefit from VS Code's credential management
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Setting up repository ${repo.full_name}...`,
          cancellable: false,
        },
        async (progress) => {
          try {
            // First approach: Try using VS Code's git extension
            progress.report({ message: "Cloning repository..." });
            logInfo(
              `Attempting to clone using VS Code's git extension: ${repo.clone_url}`
            );

            try {
              // Create the directory if it doesn't exist
              if (!fs.existsSync(baseDir)) {
                fs.mkdirSync(baseDir, { recursive: true });
              }

              // Get the git extension
              const gitExtension =
                vscode.extensions.getExtension("vscode.git")?.exports;
              if (gitExtension) {
                const git = gitExtension.getAPI(1);

                logInfo(
                  `Using VS Code git extension to clone ${repo.clone_url}`
                );
                await git.clone(repo.clone_url, baseDir, {
                  directory: repo.name,
                });
                logInfo(
                  `Repository cloned successfully using VS Code git extension`
                );
              } else {
                throw new Error("VS Code git extension not available");
              }
            } catch (gitExtError) {
              logError(
                `Failed to clone using VS Code git extension: ${gitExtError}`
              );

              // Fallback to terminal approach
              logInfo(`Falling back to manual clone approach`);

              // Create a terminal and run the clone command
              const terminal = vscode.window.createTerminal(
                "Commit Tracker Setup"
              );
              terminal.show();

              // Navigate to the base directory and clone, then exit automatically
              terminal.sendText(`cd "${baseDir}" && \\`);
              terminal.sendText(
                `git clone ${repo.clone_url} "${repo.name}" && \\`
              );
              terminal.sendText(
                `echo "Clone completed successfully. Terminal will close in 3 seconds..." && \\`
              );
              terminal.sendText(`sleep 3 && exit || \\`);
              terminal.sendText(
                `echo "Clone failed. Terminal will close in 10 seconds..." && \\`
              );
              terminal.sendText(`sleep 10 && exit`);

              // Wait for the terminal to close and check if repo was cloned successfully
              return new Promise<string | undefined>((resolve) => {
                const disposable = vscode.window.onDidCloseTerminal(
                  (closedTerminal) => {
                    if (closedTerminal === terminal) {
                      disposable.dispose();

                      // Check if the clone was successful
                      if (fs.existsSync(path.join(repoDir, ".git"))) {
                        logInfo(
                          `Repository cloned successfully using terminal`
                        );
                        resolve(repoDir);
                      } else {
                        // If the clone failed, check if the directory exists but is incomplete
                        if (fs.existsSync(repoDir)) {
                          try {
                            // Remove failed clone attempt
                            fs.rmSync(repoDir, {
                              recursive: true,
                              force: true,
                            });
                            logInfo(`Removed failed clone directory`);
                          } catch (error) {
                            logError(
                              `Failed to remove failed clone directory: ${error}`
                            );
                          }
                        }

                        logError(`Clone operation failed`);
                        vscode.window.showErrorMessage(
                          "Repository clone failed"
                        );
                        resolve(undefined);
                      }
                    }
                  }
                );

                // Add a timeout in case terminal doesn't close properly
                setTimeout(() => {
                  disposable.dispose();

                  // Check if clone succeeded despite timeout
                  if (fs.existsSync(path.join(repoDir, ".git"))) {
                    logInfo(
                      `Repository cloned successfully despite terminal timeout`
                    );
                    resolve(repoDir);
                  } else {
                    logError(`Clone operation timed out`);
                    vscode.window.showErrorMessage(
                      "Repository clone operation timed out"
                    );

                    // Try to close the terminal if it's still open
                    try {
                      terminal.dispose();
                    } catch (error) {
                      // Ignore errors when closing terminal
                    }

                    resolve(undefined);
                  }
                }, 60000); // 60 second timeout
              });
            }

            // If we get here, the VS Code git extension approach worked
            progress.report({ message: "Creating commit log file..." });

            // Create the log file
            const logFilePath = path.join(repoDir, "commits.log");
            logInfo(`Creating log file at: ${logFilePath}`);

            fs.writeFileSync(
              logFilePath,
              "# Commit Tracker Log File\n\nThis file tracks commits made across your repositories.\n\n## Commits\n\n",
              { encoding: "utf8" }
            );
            logInfo(`Log file created successfully`);

            // Use VS Code's git API to commit and push
            try {
              progress.report({
                message: "Committing and pushing log file...",
              });

              const gitExtension =
                vscode.extensions.getExtension("vscode.git")?.exports;
              if (gitExtension) {
                const git = gitExtension.getAPI(1);

                // Find our repository in VS Code's git repositories
                const repository = git.repositories.find(
                  (r: any) => r.rootUri.fsPath === repoDir
                );

                if (repository) {
                  logInfo(`Found repository in VS Code git extension`);

                  // Add the file
                  await repository.add([logFilePath]);
                  logInfo(`Added log file to git`);

                  // Commit
                  await repository.commit("Initialize commit tracker log file");
                  logInfo(`Committed log file`);

                  // Push
                  try {
                    await repository.push();
                    logInfo(`Pushed changes to remote`);
                  } catch (pushError) {
                    logError(`Failed to push changes: ${pushError}`);
                    vscode.window.showWarningMessage(
                      "Failed to push initial commit, but setup will continue. You can push changes later."
                    );
                  }
                } else {
                  logInfo(
                    `Repository not found in VS Code git extension, falling back to manual approach`
                  );
                  // Fall back to manual git commands
                  this.commitAndPushManually(repoDir, logFilePath);
                }
              } else {
                logInfo(
                  `VS Code git extension not available, falling back to manual approach`
                );
                // Fall back to manual git commands
                this.commitAndPushManually(repoDir, logFilePath);
              }
            } catch (gitError) {
              logError(`Error using VS Code git API: ${gitError}`);
              // Fall back to manual git commands
              this.commitAndPushManually(repoDir, logFilePath);
            }

            logInfo(`Repository setup completed: ${repoDir}`);
            return repoDir;
          } catch (error) {
            logError(`Repository setup failed: ${error}`);
            vscode.window.showErrorMessage(
              `Failed to set up repository: ${error}`
            );
            return undefined;
          }
        }
      );
    } catch (error) {
      logError(`Failed to clone repository: ${error}`);
      vscode.window.showErrorMessage(`Failed to clone repository: ${error}`);
      return undefined;
    }
  }

  /**
   * Helper method to commit and push changes manually using git commands
   */
  private async commitAndPushManually(
    repoDir: string,
    logFilePath: string
  ): Promise<void> {
    try {
      logInfo(`Attempting to commit and push manually`);

      // Create a terminal to perform git operations
      const terminal = vscode.window.createTerminal("Commit Tracker Git");
      terminal.show();

      vscode.window.showInformationMessage(
        "Committing and pushing changes... Terminal will close automatically when complete."
      );

      // Create a script that runs all commands and exits automatically
      terminal.sendText(`cd "${repoDir}" && \\`);
      terminal.sendText(`git config --local user.name "Commit Tracker" && \\`);
      terminal.sendText(
        `git config --local user.email "commit-tracker@example.com" && \\`
      );
      terminal.sendText(`git add "${path.basename(logFilePath)}" && \\`);
      terminal.sendText(
        `git commit -m "Initialize commit tracker log file" && \\`
      );
      terminal.sendText(`git push && \\`);
      terminal.sendText(
        `echo "Changes committed and pushed successfully. Terminal will close in 3 seconds..." && \\`
      );
      terminal.sendText(`sleep 3 && exit || \\`);
      terminal.sendText(
        `echo "Failed to commit or push changes. Terminal will close in 10 seconds..." && \\`
      );
      terminal.sendText(`sleep 10 && exit`);

      // Set a timeout to close the terminal if it doesn't close automatically
      setTimeout(() => {
        try {
          terminal.dispose();
        } catch (error) {
          // Ignore errors when closing terminal
        }
      }, 60000); // 60 second timeout
    } catch (error) {
      logError(`Manual commit and push failed: ${error}`);
      vscode.window.showWarningMessage(
        "Failed to commit and push changes. You can do this manually later."
      );
    }
  }

  /**
   * Updates the extension configuration with the new repository path
   */
  private async updateConfiguration(repoPath: string): Promise<void> {
    try {
      logInfo(`Updating configuration with repository path: ${repoPath}`);

      // Make sure repoPath exists
      if (!fs.existsSync(repoPath)) {
        throw new Error(`Repository path does not exist: ${repoPath}`);
      }

      // Generate absolute path
      const absoluteRepoPath = path.resolve(repoPath);
      logInfo(`Using absolute repository path: ${absoluteRepoPath}`);

      // Store in extension state first - this is our backup
      this.context.globalState.update(
        "configuredLogFilePath",
        absoluteRepoPath
      );
      this.context.globalState.update("configuredLogFile", "commits.log");
      logInfo(`Saved configuration to extension state as backup`);

      // Direct approach - modify settings.json directly
      try {
        // Get the VS Code settings
        const configTarget = vscode.ConfigurationTarget.Global;

        // Update settings one by one
        const config = vscode.workspace.getConfiguration("commitTracker");

        // Update logFilePath
        await config.update("logFilePath", absoluteRepoPath, configTarget);
        logInfo(`Updated commitTracker.logFilePath to ${absoluteRepoPath}`);

        // Update logFile
        await config.update("logFile", "commits.log", configTarget);
        logInfo(`Updated commitTracker.logFile to "commits.log"`);

        // Verify
        const verifyConfig = vscode.workspace.getConfiguration("commitTracker");
        const verifyPath = verifyConfig.get<string>("logFilePath");

        logInfo(`Verification - current config value: ${verifyPath}`);

        // Simple notification
        vscode.window.showInformationMessage(
          `Commit Tracker configured to use repository at: ${absoluteRepoPath}`
        );
        return;
      } catch (configError) {
        logError(`Error updating configuration: ${configError}`);

        // Show error to user
        vscode.window
          .showErrorMessage(
            `Error updating configuration automatically. Would you like to update manually?`,
            "Yes",
            "No"
          )
          .then((response) => {
            if (response === "Yes") {
              // Guide the user through manual configuration
              vscode.window.showInformationMessage(
                `Please add these settings to your VS Code settings:
            "commitTracker.logFilePath": "${absoluteRepoPath}",
            "commitTracker.logFile": "commits.log"`
              );

              // Open settings
              vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "commitTracker"
              );
            }
          });
      }
    } catch (error) {
      logError(`Failed to update configuration: ${error}`);
      throw error;
    }
  }

  /**
   * Verifies that the setup was completed successfully
   */
  private async verifySetup(repoPath: string): Promise<boolean> {
    try {
      logInfo(`Verifying setup at: ${repoPath}`);

      // 1. Check that the directory exists
      if (!fs.existsSync(repoPath)) {
        logError(`Repository directory does not exist: ${repoPath}`);
        return false;
      }

      // 2. Check that it's a git repository
      if (!fs.existsSync(path.join(repoPath, ".git"))) {
        logError(`Directory is not a git repository: ${repoPath}`);
        return false;
      }

      // 3. Check that the log file exists
      const logFilePath = path.join(repoPath, "commits.log");
      if (!fs.existsSync(logFilePath)) {
        logError(`Log file does not exist: ${logFilePath}`);
        return false;
      }

      // 4. Check that configuration has been updated
      const config = vscode.workspace.getConfiguration("commitTracker");
      const configuredPath = config.get<string>("logFilePath");
      const configuredFile = config.get<string>("logFile");

      if (!configuredPath) {
        logError(`logFilePath configuration is not set`);
        return false;
      }

      if (path.resolve(configuredPath) !== path.resolve(repoPath)) {
        logError(`logFilePath configuration does not match repo path:
        Expected: ${path.resolve(repoPath)}
        Actual: ${path.resolve(configuredPath)}`);
        return false;
      }

      if (configuredFile !== "commits.log") {
        logError(`logFile configuration is incorrect:
        Expected: commits.log
        Actual: ${configuredFile}`);
        return false;
      }

      logInfo(`Setup verification completed successfully`);
      return true;
    } catch (error) {
      logError(`Setup verification failed: ${error}`);
      return false;
    }
  }

  /**
   * Resets the setup so it can be run again
   */
  async resetSetup(): Promise<void> {
    await this.context.globalState.update("setupComplete", false);
    await this.context.globalState.update("trackerRepoUrl", undefined);
    logInfo("Setup has been reset");
  }
}
