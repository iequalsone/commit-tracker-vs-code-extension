/**
 * Interface for terminal operations - allows services to remain UI-independent
 */
export interface ITerminalProvider {
  createTerminal(options: {
    name: string;
    cwd?: string;
    shellPath?: string;
    shellArgs?: string[];
    hideFromUser?: boolean;
  }): ITerminal;
}

export interface ITerminal {
  show(preserveFocus?: boolean): void;
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}
