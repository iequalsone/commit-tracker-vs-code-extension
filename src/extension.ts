import * as vscode from "vscode";
import { ExtensionManager } from "./core/extensionManager";

// The extension manager instance
let extensionManager: ExtensionManager;

/**
 * Activates the extension
 * @param context The extension context
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Create and initialize the extension manager
  extensionManager = new ExtensionManager(context);
  await extensionManager.activate();
}

/**
 * Deactivates the extension and cleans up resources
 */
export function deactivate(): void {
  if (extensionManager) {
    extensionManager.dispose();
  }
}
