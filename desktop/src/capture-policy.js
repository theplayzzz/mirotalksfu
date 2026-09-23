'use strict';

function sourceKind(sourceId) {
    if (typeof sourceId !== 'string') return null;
    if (sourceId.startsWith('window:')) return 'window';
    if (sourceId.startsWith('screen:')) return 'screen';
    return null;
}

function isTrustedUrl(value, trustedOrigin) {
    try {
        return new URL(value).origin === trustedOrigin;
    } catch {
        return false;
    }
}

function canStartProcessAudio(authorizedPid, requestedPid) {
    return Number.isSafeInteger(requestedPid) && requestedPid > 0 && authorizedPid === requestedPid;
}

module.exports = { sourceKind, isTrustedUrl, canStartProcessAudio };
