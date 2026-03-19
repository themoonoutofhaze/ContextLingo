// src/utils/logger.js

/**
 * Indicates whether the application is running in development mode.
 * @type {boolean}
 */
const isDev = false;

export const Logger = {
    /**
     * Logs general info if in dev mode.
     * @param {...any} args The data to log.
     */
    info: (...args) => {
        if (isDev) console.log('[ISD-INFO]', ...args);
    },
    /**
     * Logs warnings if in dev mode.
     * @param {...any} args The data to log.
     */
    warn: (...args) => {
        if (isDev) console.warn('[ISD-WARN]', ...args);
    },
    /**
     * Always logs errors.
     * @param {...any} args The data to log.
     */
    error: (...args) => {
        console.error('[ISD-ERROR]', ...args);
    }
};
