# Commit Tracker for Visual Studio Code  
🚧 **Work in Progress** 🚧  

**Commit Tracker** is a Visual Studio Code extension designed to simplify Git commit tracking by logging commit details to a configurable file and optionally pushing changes to a remote repository. This extension is currently under development and may not be fully functional.  

## Features (Planned & In-Progress)  
- **Log File Path Configuration**: Set the directory and file where commit details will be saved.  
- **Automatic Commit Logging**: Track commit details, including:  
  - Commit hash  
  - Commit message  
  - Timestamp  
  - Branch name  
  - Repository path  
- **Excluded Branches**: Allow users to skip logging for specified branches.  
- **Push Changes to Remote**: Automatically push the updated log file to the repository (coming soon).  
- **Debounced Monitoring**: Efficient tracking to prevent performance degradation in large repositories.  

## Current Status  
- ✅ **Basic commit tracking and logging are implemented.**  
- 🔧 **Push to remote functionality is under review.**  
- 🚧 **Improved error handling and retry logic in progress.**  
- 🛠️ **Scalability for large monorepos and multi-repo setups under development.**  

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

## Feedback  
This is a work-in-progress project, and feedback, suggestions, or bug reports are greatly appreciated!  
Feel free to open an issue or contribute via pull requests.  

---

## License  
This project is licensed under the MIT License. See [LICENSE](./LICENSE) for more details.  

---

**Stay tuned for updates! 🚀**  
