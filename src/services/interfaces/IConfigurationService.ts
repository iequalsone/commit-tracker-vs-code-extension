import * as vscode from "vscode";
import { Result } from "../../utils/results";

/**
 * Configuration change event data
 */
export interface ConfigurationChangeEvent {
  /**
   * The configuration key that changed
   */
  key: string;

  /**
   * The old value before the change
   */
  oldValue: any;

  /**
   * The new value after the change
   */
  newValue: any;

  /**
   * Whether this was a global or workspace-specific change
   */
  scope: "global" | "workspace";
}

/**
 * Service for managing extension configuration
 */
export interface IConfigurationService {
  /**
   * Event emitted when configuration changes
   */
  readonly onDidChangeConfiguration: vscode.Event<ConfigurationChangeEvent>;

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
   * Check if a configuration setting has been changed
   * @param event VS Code configuration change event
   * @param section Configuration setting to check
   */
  affectsConfiguration(
    event: vscode.ConfigurationChangeEvent,
    section: string
  ): boolean;

  /**
   * Check if the extension is properly configured
   * @returns True if the extension is configured, false otherwise
   */
  isConfigured(): boolean;

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

  /**
   * Get a typed configuration object with multiple settings
   * @param sections Configuration sections to retrieve
   * @returns Object containing the requested configuration values
   */
  getConfigObject<T extends Record<string, any>>(sections: string[]): T;

  /**
   * Check if the extension is enabled
   * @returns True if enabled, false otherwise
   */
  isEnabled(): boolean;

  /**
   * Set the enabled state of the extension
   * @param enabled True to enable, false to disable
   */
  setEnabled(enabled: boolean): Promise<void>;

  /**
   * Check if notifications are enabled
   * @returns True if notifications are enabled, false otherwise
   */
  showNotifications(): boolean;

  /**
   * Get the update frequency in minutes
   * @returns Update frequency in minutes
   */
  getUpdateFrequency(): number;

  /**
   * Set the update frequency in minutes
   * @param minutes Update frequency in minutes
   */
  setUpdateFrequency(minutes: number): Promise<void>;

  /**
   * Set the tracking repository path and log file
   * @param repoPath Path to the tracking repository
   * @param logFile Name of the log file
   */
  setTrackerRepo(
    repoPath: string,
    logFile: string
  ): Promise<Result<void, Error>>;

  /**
   * Set excluded branches
   * @param branches Array of branch names to exclude
   */
  setExcludedBranches(branches: string[]): Promise<void>;

  /**
   * Reset all configuration to default values
   * @returns Promise that resolves when reset is complete
   */
  resetToDefaults(): Promise<void>;

  /**
   * Get all configuration settings
   * @returns Object containing all configuration values
   */
  getAllSettings(): Record<string, any>;

  /**
   * Validate a specific configuration setting using a custom validator
   * @param key Configuration key to validate
   * @param validator Function to validate the value
   * @returns True if valid, false otherwise
   */
  validateSetting<T>(key: string, validator: (value: T) => boolean): boolean;

  /**
   * Validate required configuration settings
   * @param requiredSettings Array of required setting keys
   * @returns True if all required settings are valid, false otherwise
   */
  validateRequiredSettings(requiredSettings: string[]): boolean;

  /**
   * Validate that a path exists and is accessible
   * @param pathKey Configuration key for the path setting
   * @returns True if path is valid and accessible, false otherwise
   */
  validatePath(pathKey: string): boolean;

  /**
   * Validate numeric range
   * @param key Configuration key for the numeric setting
   * @param min Minimum allowed value (inclusive)
   * @param max Maximum allowed value (inclusive)
   * @returns True if value is within range, false otherwise
   */
  validateNumericRange(key: string, min: number, max: number): boolean;

  /**
   * Validate array values against allowed options
   * @param key Configuration key for the array setting
   * @param allowedValues Array of allowed values
   * @returns True if all values in the array are allowed, false otherwise
   */
  validateArrayValues<T>(key: string, allowedValues: T[]): boolean;

  /**
   * Validate git repository configuration
   * @param repoPathKey Configuration key for the repository path
   * @returns True if path is a valid git repository, false otherwise
   */
  validateGitRepository(repoPathKey: string): boolean;

  /**
   * Register a listener for changes to a specific configuration key
   * @param key The configuration key to watch
   * @param callback Function to call when the key changes
   * @returns Disposable that can be used to remove the listener
   */
  onDidChangeConfigurationValue<T>(
    key: string,
    callback: (newValue: T, oldValue: T) => void
  ): vscode.Disposable;
}
