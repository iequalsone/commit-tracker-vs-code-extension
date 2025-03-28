import * as vscode from "vscode";
import { SetupManager } from "../features/setup/setupManager";
import { StatusManager } from "../features/status/statusManager";
import { CommandManager } from "../features/commands/commandManager";
import { GitService } from "../services/gitService";
import { LogService } from "../services/logService";
import { RepositoryManager } from "../features/repository/repositoryManager";

/**
 * Main manager class for the Commit Tracker extension.
 * Responsible for orchestrating all components and managing the extension lifecycle.
 */
export class ExtensionManager {
  private context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];

  // Feature managers
  private setupManager: SetupManager;
  private statusManager: StatusManager;
  private commandManager: CommandManager;
  private repositoryManager: RepositoryManager;

  // Services
  private gitService: GitService;
  private logService: LogService;

  /**
   * Creates a new instance of the ExtensionManager
   * @param context The VS Code extension context
   */
  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Initialize services first (no dependencies)
    this.logService = new LogService();
    this.gitService = new GitService();

    // Initialize managers (may depend on services)
    this.setupManager = new SetupManager(context, this.logService);
    this.statusManager = new StatusManager(
      context,
      this.gitService,
      this.logService
    );
    this.commandManager = new CommandManager(
      context,
      this.gitService,
      this.logService
    );
    this.repositoryManager = new RepositoryManager(context, this.statusManager);

    // Register disposables
    this.disposables.push(this.logService);
    this.disposables.push(this.statusManager);
    this.disposables.push(this.commandManager);
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
    this.gitService = new GitService();

    // Initialize StatusManager first
    this.statusManager = new StatusManager(
      this.context,
      this.gitService,
      this.logService
    );
    this.statusManager.initialize();

    // Initialize RepositoryManager with StatusManager
    this.repositoryManager = new RepositoryManager(
      this.context,
      this.statusManager
    );

    // Command manager initialization needs repositoryManager
    this.commandManager = new CommandManager(
      this.context,
      this.gitService,
      this.logService,
      this.setupManager,
      this.statusManager,
      this.repositoryManager
    );

    // Connect components via events
    this.connectComponentsViaEvents();

    // Initialize repository manager
    const repoInitResult = await this.repositoryManager.initialize();

    // Connect repositoryManager to commandManager (two-way reference)
    this.repositoryManager.connectCommandManager(this.commandManager);

    if (repoInitResult.isFailure()) {
      this.statusManager.setErrorStatus(
        "Failed to initialize repository tracking"
      );
    }

    // Step 1: Run setup/config validation
    const isConfigured = await this.runSetup();
    if (!isConfigured) {
      this.logService.info("Extension setup canceled or failed");
      return;
    }

    // Step 2: Register commands
    this.registerCommands();

    // Step 3: Initialize status
    this.initializeStatus();

    // Step 4: Set up event listeners
    this.registerEventListeners();
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

    // Listen for repository errors in the extension manager
    this.repositoryManager.on(RepositoryEvent.ERROR, (error, operation) => {
      this.logService.error(
        `Repository error during ${operation}: ${error.message}`
      );
    });

    // Listen for specific error types
    this.repositoryManager.on(RepositoryEvent.ERROR_CONFIGURATION, (error) => {
      this.logService.error(`Configuration error: ${error.message}`);
      this.statusManager.setErrorStatus("Config Error");
    });

    this.repositoryManager.on(RepositoryEvent.ERROR_GIT_OPERATION, (error) => {
      this.logService.error(`Git operation error: ${error.message}`);
      this.statusManager.setErrorStatus("Git Error");
    });

    this.repositoryManager.on(RepositoryEvent.ERROR_FILESYSTEM, (error) => {
      this.logService.error(`File system error: ${error.message}`);
      this.statusManager.setErrorStatus("File Error");
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
    // Register for configuration changes
    const configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("commitTracker")) {
        this.logService.info("Configuration changed, updating components...");
        this.setupManager.validateConfiguration();
        this.statusManager.updateStatus();
      }
    });

    // Add to disposables for cleanup
    this.disposables.push(configDisposable);

    // Additional event listeners can be added here
  }

  /**
   * Disposes of all resources used by the extension
   */
  public dispose(): void {
    this.logService.info("Disposing Commit Tracker extension...");

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
