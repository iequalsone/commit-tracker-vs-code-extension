import * as vscode from "vscode";
import { SetupManager } from "../features/setup/setupManager";
import { StatusManager } from "../features/status/statusManager";
import { CommandManager } from "../features/commands/commandManager";
import { GitService } from "../services/gitService";
import { LogService } from "../services/logService";
import {
  RepositoryEvent,
  RepositoryManager,
} from "../features/repository/repositoryManager";
import {
  ErrorEvent,
  ErrorHandlingService,
  ErrorType,
} from "../services/errorHandlingService";

import { ITerminalProvider } from "../services/interfaces/ITerminalProvider";
import { IWorkspaceProvider } from "../services/interfaces/IWorkspaceProvider";
import { IFileSystemService } from "../services/interfaces/IFileSystemService";
import { ConfigurationService } from "../services/configurationService";
import { IConfigurationService } from "../services/interfaces/IConfigurationService";
import { FileSystemService } from "../services/fileSystemService";
import { DisposableManager } from "../utils/DisposableManager";

/**
 * Main manager class for the Commit Tracker extension.
 * Responsible for orchestrating all components and managing the extension lifecycle.
 */
export class ExtensionManager {
  private context: vscode.ExtensionContext;
  private disposableManager: DisposableManager;

  // Feature managers
  private setupManager: SetupManager;
  private statusManager: StatusManager;
  private commandManager: CommandManager;
  private repositoryManager: RepositoryManager;

  // Services
  private gitService: GitService;
  private logService: LogService;
  private errorHandlingService: ErrorHandlingService;
  private configurationService: IConfigurationService;
  private fileSystemService: IFileSystemService;

  /**
   * Creates a new instance of the ExtensionManager
   * @param context The VS Code extension context
   */
  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.disposableManager = DisposableManager.getInstance();

    // Initialize services first (no dependencies)
    this.logService = new LogService();
    this.configurationService = new ConfigurationService(
      "commitTracker",
      this.logService
    );

    this.fileSystemService = new FileSystemService({
      logService: this.logService,
      cacheEnabled: true,
    });

    this.gitService = new GitService({
      logService: this.logService,
      fileSystemService: this.fileSystemService,
    });
    this.errorHandlingService = new ErrorHandlingService(this.logService);

    // Initialize managers (may depend on services)

    // Initialize StatusManager first
    this.statusManager = new StatusManager(
      this.context,
      this.gitService,
      this.logService,
      undefined,
      this.configurationService
    );

    this.setupManager = new SetupManager(
      context,
      this.logService,
      this.configurationService,
      this.gitService,
      undefined,
      this.fileSystemService
    );

    this.repositoryManager = new RepositoryManager(
      context,
      this.statusManager,
      undefined,
      this.errorHandlingService,
      this.gitService,
      this.configurationService,
      this.logService,
      this.fileSystemService
    );

    this.commandManager = new CommandManager(
      context,
      this.gitService,
      this.logService,
      this.setupManager,
      this.statusManager,
      this.repositoryManager,
      this.fileSystemService
    );

    // Register disposables
    this.disposableManager.register(this.logService);
    this.disposableManager.register(this.statusManager);
    this.disposableManager.register(this.commandManager);
    this.disposableManager.register(this.errorHandlingService);
    this.disposableManager.register(this.fileSystemService);
  }

  /**
   * Activates the extension and initializes all components
   */
  public async activate(): Promise<void> {
    try {
      this.logService.info("Commit Tracker extension activating...");

      // Initialize components in the correct order
      await this.initializeExtension();

      this.logService.info("Commit Tracker extension activated successfully");
    } catch (error) {
      this.logService.error(
        "Failed to activate Commit Tracker extension",
        error
      );
      vscode.window.showErrorMessage(
        "Failed to activate Commit Tracker extension"
      );
    }
  }

  /**
   * Initializes the extension components in proper order
   */
  private async initializeExtension(): Promise<void> {
    // Initialize services first
    this.logService = new LogService();
    this.logService.info("Extension initialization started");

    // Initialize ConfigurationService
    this.configurationService = new ConfigurationService(
      "commitTracker",
      this.logService
    );

    // Subscribe to configuration changes
    this.configurationService.onDidChangeConfiguration((change) => {
      this.logService.info(`Configuration changed: ${change.key}`);

      // Special handling for specific settings
      if (change.key === "enabled") {
        // Handle enabled state change
        if (change.newValue && this.repositoryManager) {
          this.repositoryManager.initialize();
        } else if (!change.newValue && this.repositoryManager) {
          // If disabled, update status bar
          this.statusManager?.setStoppedStatus();
          this.logService.info("Commit tracking disabled");
        }
      } else if (
        change.key === "updateFrequencyMinutes" &&
        this.statusManager
      ) {
        // Update status refresh interval
        this.statusManager.startStatusUpdateInterval();
        this.logService.info(
          `Update frequency changed to ${change.newValue} minutes`
        );
      } else if (change.key === "logFilePath" || change.key === "logFile") {
        // Repository path or log file changed, need to reinitialize repository manager
        this.logService.info(`Log file configuration changed: ${change.key}`);
        if (
          this.repositoryManager &&
          this.configurationService?.isConfigured()
        ) {
          this.repositoryManager.initialize();
        }
      }
    });

    // Create workspace provider
    const workspaceProvider: IWorkspaceProvider = {
      getWorkspaceRoot: () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          return null;
        }
        return workspaceFolders[0].uri.fsPath;
      },
    };

    // Create terminal provider
    const terminalProvider: ITerminalProvider = {
      createTerminal: (options) => {
        const terminal = vscode.window.createTerminal(options);
        return {
          show: terminal.show.bind(terminal),
          sendText: terminal.sendText.bind(terminal),
          dispose: terminal.dispose.bind(terminal),
        };
      },
    };

    // Create file system service
    const fileSystemService = this.fileSystemService;

    // Initialize with all dependencies
    this.gitService = new GitService({
      logService: this.logService,
      terminalProvider,
      workspaceProvider,
      fileSystemService,
    });

    // Initialize ErrorHandlingService with LogService
    this.errorHandlingService = new ErrorHandlingService(this.logService);

    // Add a workspace provider
    this.gitService.setWorkspaceProvider(() => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
      }
      return workspaceFolders[0].uri.fsPath;
    });

    // Initialize StatusManager first
    this.statusManager = new StatusManager(
      this.context,
      this.gitService,
      this.logService
    );
    this.statusManager.initialize();

    // Initialize SetupManager with GitService
    this.setupManager = new SetupManager(
      this.context,
      this.logService,
      this.configurationService,
      this.gitService,
      undefined,
      fileSystemService
    );

    this.repositoryManager = new RepositoryManager(
      this.context,
      this.statusManager,
      undefined,
      this.errorHandlingService,
      this.gitService,
      this.configurationService,
      this.logService,
      fileSystemService
    );

    // Connect GitService to RepositoryManager
    this.repositoryManager.connectGitService(this.gitService);

    // Connect RepositoryManager to SetupManager
    this.setupManager.connectRepositoryManager(this.repositoryManager);

    // Command manager initialization needs repositoryManager
    this.commandManager = new CommandManager(
      this.context,
      this.gitService,
      this.logService,
      this.setupManager,
      this.statusManager,
      this.repositoryManager,
      fileSystemService
    );

    // Connect components via events
    this.connectComponentsViaEvents();

    // Set up bidirectional communication
    this.commandManager.setupRepositoryEventListeners();
    this.repositoryManager.connectCommandManager(this.commandManager);

    // When checking configuration validity, use configurationService
    const isConfigured = this.configurationService.isConfigured();

    // Only initialize the repository manager if configuration is valid
    if (isConfigured) {
      // Pass configurationService to repository manager
      const repoInitResult = await this.repositoryManager.initialize();

      if (repoInitResult.isFailure()) {
        this.statusManager.setErrorStatus(
          "Failed to initialize repository tracking"
        );
      }
    } else {
      this.statusManager.setSetupNeededStatus();
    }

    // Step 2: Register commands
    this.registerCommands();

    // Step 3: Initialize status
    this.initializeStatus();

    // Step 4: Set up event listeners
    this.registerEventListeners();

    this.disposableManager.register(
      this.configurationService.onDidChangeConfigurationValue<boolean>(
        "enabled",
        (newValue) => {
          if (newValue) {
            this.logService.info("Commit tracking enabled");
            if (this.repositoryManager) {
              this.repositoryManager.initialize();
            }
          } else {
            this.logService.info("Commit tracking disabled");
            if (this.statusManager) {
              this.statusManager.setStoppedStatus();
            }
          }
        }
      )
    );

    this.disposableManager.register(
      this.configurationService.onDidChangeConfigurationValue<boolean>(
        "enabled",
        (newValue) => {
          if (newValue) {
            this.logService.info("Commit tracking enabled");
            if (this.repositoryManager) {
              this.repositoryManager.initialize();
            }
          } else {
            this.logService.info("Commit tracking disabled");
            if (this.statusManager) {
              this.statusManager.setStoppedStatus();
            }
          }
        }
      )
    );

    this.disposableManager.register(
      this.configurationService.onDidChangeConfigurationValue<number>(
        "updateFrequencyMinutes",
        (newValue) => {
          this.logService.info(
            `Update frequency changed to ${newValue} minutes`
          );
          if (this.statusManager) {
            this.statusManager.startStatusUpdateInterval();
          }
        }
      )
    );

    this.disposableManager.register(
      this.configurationService.onDidChangeConfigurationValue<string>(
        "logFilePath",
        () => this.handleLogConfigChange()
      )
    );

    this.disposableManager.register(
      this.configurationService.onDidChangeConfigurationValue<string>(
        "logFile",
        () => this.handleLogConfigChange()
      )
    );

    this.disposableManager.register(
      this.configurationService.onDidChangeConfigurationValue<string[]>(
        "excludedBranches",
        (newValue) => {
          this.logService.info(
            `Excluded branches updated: ${newValue.join(", ")}`
          );
          if (this.repositoryManager) {
            this.repositoryManager.updateConfiguration(
              this.configurationService.get("logFilePath", ""),
              this.configurationService.get("logFile", ""),
              newValue
            );
          }
        }
      )
    );

    this.disposableManager.register(this.fileSystemService);
  }

  /**
   * Connect components via an event-based architecture
   */
  private connectComponentsViaEvents(): void {
    if (
      !this.repositoryManager ||
      !this.statusManager ||
      !this.commandManager
    ) {
      this.logService.error(
        "Cannot connect components: Some components are not initialized"
      );
      return;
    }

    // Connect StatusManager to RepositoryManager events
    this.statusManager.connectToRepositoryManager(this.repositoryManager);

    // Set up centralized error handling via the ErrorHandlingService
    this.errorHandlingService.on(ErrorEvent.ERROR_OCCURRED, (errorDetails) => {
      // Update status bar based on error type
      switch (errorDetails.type) {
        case ErrorType.CONFIGURATION:
          this.statusManager.setErrorStatus("Config Error");
          break;
        case ErrorType.GIT_OPERATION:
          this.statusManager.setErrorStatus("Git Error");
          break;
        case ErrorType.FILESYSTEM:
          this.statusManager.setErrorStatus("File Error");
          break;
        case ErrorType.REPOSITORY:
          this.statusManager.setErrorStatus("Repo Error");
          break;
        case ErrorType.NETWORK:
          this.statusManager.setErrorStatus("Network Error");
          break;
        default:
          this.statusManager.setErrorStatus("Error");
      }
    });

    this.errorHandlingService.on(ErrorEvent.ERROR_RESOLVED, () => {
      // Restore normal status when errors are resolved
      this.statusManager.setTrackingStatus();
    });

    // Handle suggestion selections
    this.errorHandlingService.on("suggestion-selected", (suggestion) => {
      switch (suggestion) {
        case "Open Settings":
          vscode.commands.executeCommand("commitTracker.openSettings");
          break;
        case "Run Setup Wizard":
          vscode.commands.executeCommand("commitTracker.setupTracker");
          break;
        case "Check Git Installation":
          vscode.window.showInformationMessage(
            "Checking your Git installation..."
          );
          // Additional action could be added here
          break;
        case "Open Terminal":
          vscode.commands.executeCommand("workbench.action.terminal.new");
          break;
        case "Refresh Status":
          vscode.commands.executeCommand("commitTracker.refresh");
          break;
      }
    });

    // Listen for configuration updates
    this.repositoryManager.on(RepositoryEvent.CONFIG_UPDATED, (config) => {
      this.logService.info(`Configuration updated: ${JSON.stringify(config)}`);
    });

    this.logService.info("Components connected via events");
  }

  /**
   * Runs the extension setup if needed
   */
  private async runSetup(): Promise<boolean> {
    // Check if configuration exists and is valid
    const isConfigValid = this.setupManager.validateConfiguration();

    if (!isConfigValid) {
      return await this.setupManager.runSetupWizard();
    }

    return true;
  }

  /**
   * Registers all extension commands
   */
  private registerCommands(): void {
    this.logService.info("Registering commands...");
    this.commandManager.registerCommands();
  }

  /**
   * Initializes the status bar
   */
  private initializeStatus(): void {
    this.logService.info("Initializing status bar...");
    this.statusManager.initialize();
  }

  /**
   * Registers event listeners for configuration changes, git events, etc.
   */
  private registerEventListeners(): void {
    // If using ConfigurationService directly, we don't need this listener anymore
    // But we'll keep it with a check for backward compatibility
    if (!this.configurationService) {
      // Register for configuration changes
      const configDisposable = vscode.workspace.onDidChangeConfiguration(
        (e) => {
          if (e.affectsConfiguration("commitTracker")) {
            this.logService.info(
              "Configuration changed, updating components..."
            );
            this.setupManager.validateConfiguration();
            this.statusManager.updateStatus();
          }
        }
      );

      // Add to disposables for cleanup
      this.disposableManager.register(configDisposable);
    }

    // Additional event listeners can be added here
  }

  /**
   * Handle changes to log file configuration
   */
  private handleLogConfigChange(): void {
    this.logService.info("Log file configuration changed");
    if (this.repositoryManager && this.configurationService.isConfigured()) {
      this.repositoryManager.initialize();
    }
  }

  /**
   * Disposes of all resources used by the extension
   */
  public dispose(): void {
    this.logService.info("Disposing Commit Tracker extension...");
    this.disposableManager.dispose();
  }
}
