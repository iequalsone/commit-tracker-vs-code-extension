/**
 * Interface for providing workspace information
 */
export interface IWorkspaceProvider {
  getWorkspaceRoot(): string | null;
}
