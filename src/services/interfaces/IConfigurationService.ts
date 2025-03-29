import * as vscode from "vscode";

/**
 * Interface for configuration change event
 */
export interface ConfigurationChangeEvent {
  key: string;
  oldValue: any;
  newValue: any;
}

/**
 * Manages extension configuration settings
 */
export interface IConfigurationService {
  /**
   * Event emitted when a configuration value changes
   */
  onDidChangeConfiguration: vscode.Event<ConfigurationChangeEvent>;

  /**
   * Get a configuration value
   * @param section Configuration setting key
   * @param defaultValue Default value if setting is not found
   */
  get<T>(section: string, defaultValue?: T): T;

  /**
   * Update a configuration value
   * @param section Configuration setting key
   * @param value New value to set
   * @param target Configuration scope to update
   */
  update(
    section: string,
    value: any,
    target?: vscode.ConfigurationTarget
  ): Promise<void>;

  /**
   * Check if a particular configuration has been changed
   * @param event VS Code configuration change event
   * @param section Configuration setting to check
   */
  affectsConfiguration(
    event: vscode.ConfigurationChangeEvent,
    section: string
  ): boolean;

  /**
   * Validate required configuration settings
   * @param requiredSettings Array of required setting keys
   * @returns True if all required settings are valid, false otherwise
   */
  validateRequiredSettings(requiredSettings: string[]): boolean;

  /**
   * Check if the extension is properly configured
   * @returns True if the extension is configured, false otherwise
   */
  isConfigured(): boolean;

  /**
   * Get the tracking repository path
   * @returns Path to the tracking repository or undefined if not set
   */
  getTrackerRepoPath(): string | undefined;

  /**
   * Get the tracking log file name
   * @returns Name of the tracking log file or undefined if not set
   */
  getTrackerLogFile(): string | undefined;

  /**
   * Get excluded branches
   * @returns Array of branch names to exclude from tracking
   */
  getExcludedBranches(): string[];
}
