Commit Tracker Extension Refactoring Plan
Overview
This plan outlines the steps to refactor the Commit Tracker extension using a feature-based module separation approach. The goal is to improve maintainability by organizing code into logical modules based on functionality.

Phase 1: Project Structure Setup
[x] Create /core directory for core extension functionality
[x] Create /features directory with subdirectories:
[x] /features/setup [] Setup wizard and configuration
[x] /features/status [] Status bar management
[x] /features/commands [] Command registration and handling
[x] Create /services directory (for shared services)
[x] Create /utils directory (if not already existing)
[x] Ensure all existing utility functions are properly organized

Phase 2: Core Extension Manager Implementation
[x] Create ExtensionManager class in /core directory
[x] Implement constructor that accepts extension context
[x] Add methods for activation and deactivation
[x] Add private methods for initialization steps
[x] Refactor the entry point (extension.ts) to use ExtensionManager
[x] Move global variables into appropriate managers
Phase 3: Feature Module Implementation
Setup Module
[x] Create SetupManager class in /features/setup
[x] Move first-time setup logic (can be found in ./extension.ts.bak)
[x] Implement setup wizard functionality
[x] Add configuration validation methods
Status Module
[x] Create StatusManager class in /features/status
[x] Move status bar creation and updates
[x] Add methods for different status states (tracking, error, etc.)
[x] Implement unpushed changes detection
Commands Module
[x] Create CommandManager class in /features/commands
[x] Centralize command registration
[x] Organize command handlers by feature
[x] Ensure proper dependency injection for commands
Repository Module
Review Current Implementation
[x] Examine existing RepositoryManager class structure
[x] Identify any UI dependencies that need to be removed
[x] Map out current responsibilities and interfaces

Design Clean Interfaces
Create clear public methods:
[x] initialize(): Set up monitoring
[x] processCommit(repo, commit): Process a specific commit
[x] getRepositoryStatus(repo): Get repository information
[x] addRepositoryListener(repo, callback): Register change listeners

Extract UI to appropriate managers:
[x] Move status bar updates to StatusManager
[x] Let CommandManager handle terminal creation
[x] Use events to notify other parts of the extension

Establish error handling patterns:
[x] Return Result<T> objects instead of throwing errors
[x] Use event emitters for error notifications
[x] Centralize error handling logic

Remove UI Dependencies
[x] Extract any UI-related code into appropriate managers (StatusManager, etc.)
[x] Replace direct UI updates with events or callbacks
[x] Ensure all repository operations are pure business logic

Enhance Functionality
[x] Add methods for additional repository information if needed
[x] Implement proper caching mechanisms for repository data
[x] Ensure all git operations are properly abstracted

Integration with Other Modules
[x] Define clean interfaces with StatusManager
[x] Establish proper communication with CommandManager
[x] Ensure SetupManager can correctly initialize repositories

Phase 4: Service Refinement
[x] Review and refine gitService
[x] Ensure it has no UI dependencies
[x] Make it fully injectable

Phase 4a: Create LogService
[x] Already partially implemented but needs to be enhanced and standardized
[x] Should handle all logging operations throughout the application
[x] ill replace direct calls to logInfo and logError

Phase 4b: Create ConfigurationService
[x] Centralize configuration management
[x] Handle reading/updating VS Code settings
[x] Provide validation methods
[x] Support listeners for configuration changes

Phase 4c: Create FileSystemService
Step 1: Define Interface
[x] Create /services/interfaces/IFileSystemService.ts
[x] Define core file operations:
[x] Reading files
[x] Writing files
[x] Appending to files
[x] Checking if files/directories exist
[x] Creating directories
[x] Deleting files/directories
[x] Listing directory contents
[x] Add documentation for each method
[x] Include proper error handling with Result pattern

Step 2: Create Implementation
[x] Create /services/fileSystemService.ts
[x] Implement wrapper methods for Node.js fs operations
[x] Add path validation security
[x] Add logging with dependency injection
[x] Implement optional file read caching
[x] Configure proper error handling for all operations
[x] Add atomic write operations where needed

Step 3: Identify Current Usage
[x] Audit direct fs usage in:
[x] setupWizard.ts
[x] setupManager.ts
[x] repositoryManager.ts
[x] gitService.ts
[x] commandManager.ts
[x] fileService.ts (for migration)
[x] Determine patterns and most common operations

Step 4: Migrate Existing FileService
[x] Move functionality from fileService.ts to new FileSystemService
[x] Add deprecated annotations to fileService.ts methods
[x] Maintain backward compatibility
[x] Create migration guide for other components

Step 5: Setup Dependency Injection
[x] Update ExtensionManager to create FileSystemService instance
[x] Add FileSystemService to constructor params of dependent services
[x] Configure default implementation for backward compatibility

Step 6: Refactor Components
[x] Update GitService to use IFileSystemService
[x] Refactor RepositoryManager to use the service
[x] Migrate SetupManager and SetupWizard usage
[x] Update any CommandManager file operations

Step 7: Add Enhanced Functionality
[x] Implement file watcher capabilities
[x] Add safe temporary file handling
[x] Create path normalization utilities
[] Add recursive directory operations
[] Implement file permission management

Step 8: Documentation
[] Add JSDoc comments to all methods
[] Create usage examples for common scenarios
[] Document security considerations
[] Update any README sections on file operations

Step 9: Final Validation
[] Verify all file operations work correctly
[] Validate security protections (path traversal, etc.)
[] Test error handling scenarios
[] Ensure proper cleanup in dispose method
[] Check performance with large files/directories

Phase 4d: Create NotificationService
[] Manage all user notifications
[] Support different notification types (info, warning, error)
[] Allow for notification throttling/grouping
[] Provide a consistent notification experience

Phase 4e: Create ErrorHandlingService
[] Enhanced error handling and reporting
[] Categorize errors by type
[] Provide appropriate recovery suggestions
[] Handle reporting/logging centrally

Phase 4f: Create TelemetryService (optional)
[] Track extension usage statistics
[] Record feature usage frequency
[] Report errors anonymously (with user consent)
[] Help identify common issues

Phase 5: Extension Entry Point Refactoring
[] Simplify extension.ts to just initialize the ExtensionManager
[] Move all activation logic into the ExtensionManager
[] Ensure proper disposal of resources on deactivation

Phase 6: Testing and Validation
[] Ensure all commands work as expected
[] Verify extension activation sequence
[] Test error handling in isolation
[] Verify that configuration changes are properly handled

Phase 7: Documentation and Final Touches
[] Update comments and documentation
[] Add JSDoc comments to all public methods and classes
[] Create class diagrams if helpful
[] Add any missing error handling
[] Review for any remaining tight coupling between modules

Implementation Order Recommendation

- Start with Core Extension Manager and entry point
- Implement Status Manager (most visual component)
- Implement Setup Manager
- Implement/refine Repository Manager
- Implement Command Manager
- Refine Services
- Final testing and documentation
