/**
 * Generic Result type that represents either success or failure
 */
export type Result<T, E extends Error> = Success<T> | Failure<E>;

/**
 * Success type containing the successful value
 */
export class Success<T> {
  constructor(private readonly _value: T) {}

  isSuccess(): this is Success<T> {
    return true;
  }

  isFailure(): this is never {
    return false;
  }

  get value(): T {
    return this._value;
  }
}

/**
 * Failure type containing the error
 */
export class Failure<E extends Error> {
  constructor(private readonly _error: E) {}

  isSuccess(): this is never {
    return false;
  }

  isFailure(): this is Failure<E> {
    return true;
  }

  get error(): E {
    return this._error;
  }
}

/**
 * Create a success result
 * @param value The successful value
 */
export function success<T>(value: T): Success<T> {
  return new Success(value);
}

/**
 * Create a failure result
 * @param error The error
 */
export function failure<E extends Error>(error: E): Failure<E> {
  return new Failure(error);
}
