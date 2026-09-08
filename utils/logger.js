const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3, trace: 4 });

let level = 'info';
let contentLogging = false;

const CONTENT_KEYS = /^(text|content|query|preview|documents?|injection)$/i;
const IDENTIFIER_KEYS = /(?:^|_)(?:id|hash|collectionId|promptTag)$/i;

function redact(value, key = '', seen = new WeakSet()) {
    if (typeof value === 'string') {
        if (!contentLogging && CONTENT_KEYS.test(key)) return `[redacted:${value.length} chars]`;
        if (IDENTIFIER_KEYS.test(key) && value.length > 10) return `${value.slice(0, 6)}…${value.slice(-3)}`;
        return value;
    }
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => redact(item, key, seen));
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey, seen)]));
}

function emit(logLevel, message, details) {
    if (LEVELS[logLevel] > LEVELS[level]) return;
    const method = logLevel === 'trace' ? 'debug' : logLevel;
    const prefix = `[VectHare] ${message}`;
    if (details === undefined) console[method](prefix);
    else console[method](prefix, redact(details));
}

export const logger = Object.freeze({
    error: (message, details) => emit('error', message, details),
    warn: (message, details) => emit('warn', message, details),
    info: (message, details) => emit('info', message, details),
    debug: (message, details) => emit('debug', message, details),
    trace: (message, details) => emit('trace', message, details),
});

export function configureLogger(options = {}) {
    if (options.level in LEVELS) level = options.level;
    if (typeof options.content === 'boolean') contentLogging = options.content;
}

export function getLoggerConfig() {
    return { level, content: contentLogging };
}

