/**
 * Collection of utility functions used across the extension
 */

/**
 * Formats a date in a human-readable format
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString();
}

/**
 * Checks if a value is defined (not null or undefined)
 */
export function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}
