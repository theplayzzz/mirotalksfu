'use strict';

/** An error that the HTTP API answers as { error, code } with the given status. */
class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.code = code;
    }
}

module.exports = { HttpError };
