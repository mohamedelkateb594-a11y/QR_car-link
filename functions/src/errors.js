'use strict';
/** Domain error. `code` is a stable machine-readable string the clients can switch on. */
class ServiceError extends Error {
  constructor(code, details) {
    super(code);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}
module.exports = { ServiceError };
