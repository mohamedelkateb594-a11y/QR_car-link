'use strict';

/** Domain error. `code` is stable and safe to return to clients; never put internals in `message`. */
class AppError extends Error {
  constructor(code, details) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.details = details || undefined;
  }
}

module.exports = { AppError };
