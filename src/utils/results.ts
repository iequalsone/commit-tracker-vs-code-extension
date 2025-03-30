/**
 * A type that represents either success with a value or failure with an error
 */
export type Result<T, E> = Success<T> | Failure<E>;

/**
 * Represents a successful operation with a value
 */
export class Success<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }

  isSuccess(): this is Success<T> {
    return true;
  }

  isFailure(): false {
    return false;
  }

  /**
   * Maps the success value to a new value
   * @param fn Function to map the value
   */
  map<U>(fn: (value: T) => U): Result<U, never> {
    return success(fn(this.value));
  }

  /**
   * Maps the success value to a new Result
   * @param fn Function to map the value to a new Result
   */
  flatMap<U, E>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return fn(this.value);
  }

  /**
   * Executes a function with the success value
   * @param fn Function to execute with the value
   */
  match<U>(onSuccess: (value: T) => U, _onFailure: (error: never) => U): U {
    return onSuccess(this.value);
  }
}

/**
 * Represents a failed operation with an error
 */
export class Failure<E> {
  readonly error: E;

  constructor(error: E) {
    this.error = error;
  }

  isSuccess(): false {
    return false;
  }

  isFailure(): this is Failure<E> {
    return true;
  }

  /**
   * Maps the failure error to a new value (no-op for Failure)
   */
  map<U>(_fn: (value: never) => U): Result<never, E> {
    return this as unknown as Result<never, E>;
  }

  /**
   * Maps the failure error to a new Result (no-op for Failure)
   */
  flatMap<U, F>(_fn: (value: never) => Result<U, F>): Result<never, E> {
    return this as unknown as Result<never, E>;
  }

  /**
   * Maps the error to a new error
   * @param fn Function to map the error
   */
  mapError<F>(fn: (error: E) => F): Result<never, F> {
    return failure(fn(this.error));
  }

  /**
   * Executes a function with the failure error
   * @param fn Function to execute with the error
   */
  match<U>(_onSuccess: (value: never) => U, onFailure: (error: E) => U): U {
    return onFailure(this.error);
  }
}

/**
 * Creates a success result
 * @param value The success value
 */
export function success<T>(value: T): Result<T, never> {
  return new Success(value);
}

/**
 * Creates a failure result
 * @param error The error value
 */
export function failure<E>(error: E): Result<never, E> {
  return new Failure(error);
}
