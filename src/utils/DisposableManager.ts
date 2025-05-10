import * as vscode from "vscode";

export class DisposableManager {
  private static instance: DisposableManager;
  private disposables: vscode.Disposable[] = [];

  private constructor() {}

  static getInstance(): DisposableManager {
    if (!DisposableManager.instance) {
      DisposableManager.instance = new DisposableManager();
    }
    return DisposableManager.instance;
  }

  register(disposable: vscode.Disposable): void {
    this.disposables.push(disposable);
  }

  dispose(): void {
    this.disposables.forEach((d) => {
      try {
        d.dispose();
      } catch (err) {
        console.error("Error disposing resource:", err);
      }
    });
    this.disposables = [];
  }
}
