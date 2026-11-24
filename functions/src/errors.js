'use strict';
/** Domain error. `code` is a stable machine string; index.js maps it to an HttpsError code. */
class ServiceError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = 'ServiceError';
    this.code = code;
    Object.assign(this, extra);
  }
}
module.exports = { ServiceError };
