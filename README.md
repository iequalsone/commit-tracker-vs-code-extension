# Commit Tracker for Visual Studio Code

**Commit Tracker** is a Visual Studio Code extension that simplifies Git commit tracking by logging commit details to a configurable file and pushing changes to a remote repository.

## Features

- **Automated Commit Logging**: Tracks commit details including:
  - Commit hash
  - Commit message
  - Timestamp
  - Branch name
  - Repository path
- **Configurable Log Storage**: Customize where and how commit details are saved
- **Branch Filtering**: Skip logging for specified branches
- **Remote Synchronization**: Automatically push log updates to your repository
- **Performance Optimized**: Efficient tracking with debounced monitoring

## Current Status

- ✅ **Basic commit tracking and logging are implemented.**
- ✅ **Push to remote functionality implemented.**
- ✅ **Improved error handling and retry logic implemented.**
- 🛠️ **Scalability for large monorepos and multi-repo setups under development.**

## Installation

### From VS Code Marketplace (Coming Soon)

- Open VS Code
- Go to Extensions (Ctrl+Shift+X)
- Search for "Commit Tracker"
- Click Install

### Manual Installation

1. Download the latest `.vsix` file from the [releases page](../../releases)
2. Run `code --install-extension commit-tracker-*.vsix`

## Configuration

```json
{
  "commitTracker.logFilePath": "/path/to/logs",
  "commitTracker.logFile": "commit-history.log",
  "commitTracker.excludedBranches": ["main", "develop"],
  "commitTracker.pushToRemote": true
}
```

### Configuration Options

- **logFilePath**: Directory where log files will be stored
- **logFile**: Name of the log file (supports .log, .txt, .json)
- **excludedBranches**: Array of branch names to ignore
- **pushToRemote**: Enable/disable automatic pushing of log files

## Usage

1. After installation, the extension activates automatically
2. Make commits in your repository as usual
3. Commits will be logged to your specified log file
4. View the log file to see your commit history

## How to Test

1. Clone this repository
2. Install dependencies
3. Launch the Extension Development Host:

   - Press `F5` to start the Extension Development Host.

4. Configure the settings in VS Code:
   - `commitTracker.logFilePath`: Directory for log files.
   - `commitTracker.logFile`: File name for logs.
   - `commitTracker.excludedBranches`: Branches to exclude from logging.

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to your fork
5. Submit a Pull Request

### Development Setup

```bash
git clone https://github.com/yourusername/commit-tracker-vs-code-extension
cd commit-tracker-vs-code-extension
npm install
```

## Requirements

- **Visual Studio Code** (v1.60.0 or later).
- **Git** installed and configured.
- **Git extension** enabled in VS Code.

---

## Known Issues

- Limited error handling for file system operations.
- Logging functionality may fail silently for invalid configurations.
- Push changes feature is partially implemented and may not work as expected.

---

## Roadmap

- Add customizable log formats (e.g., JSON, CSV).
- Implement robust retry logic for file and Git operations.
- Enhance multi-repo support.
- Provide a more user-friendly configuration interface.
- Add automated tests and CI/CD pipeline.

---

## Troubleshooting

If you encounter issues:

1. Ensure Git is properly configured in VS Code
2. Verify write permissions for the log file location
3. Check that your Git credentials are properly set up
4. Confirm the configured branches exist in your repository

---

## Feedback

This is a work-in-progress project, and feedback, suggestions, or bug reports are greatly appreciated!  
Feel free to open an issue or contribute via pull requests.

---

## Support

If you encounter any issues or have questions:

- Open an [issue](../../issues)
- Join our [Discord community](discord-link-coming-soon)

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for more details.

---

**Stay tuned for updates! 🚀**
