/**
 * Shared matching for activation triggers and pattern conditions.
 *
 * Plain phrases use Unicode-aware word boundaries by default. Set
 * `plainMatchMode` to `substring` to retain the legacy contains behavior.
 */

const UNICODE_WORD_CHARACTER = '[\\p{L}\\p{N}\\p{M}_]';

/** Escape text so that it is always literal inside a regular expression. */
export function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse the existing /pattern/flags notation.
 * @returns {{ source: string, flags: string }|null}
 */
export function parseRegexPattern(pattern, caseSensitive = false) {
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
        return null;
    }

    const lastSlash = pattern.lastIndexOf('/');
    if (lastSlash <= 0) {
        return null;
    }

    return {
        source: pattern.slice(1, lastSlash),
        flags: pattern.slice(lastSlash + 1) || (caseSensitive ? '' : 'i'),
    };
}

/**
 * Match a plain keyword/phrase or an explicit /regex/flags expression.
 * Whitespace runs in plain phrases match any run of Unicode whitespace.
 *
 * @param {string} text Text to search
 * @param {string} pattern Plain text or /regex/flags
 * @param {{ caseSensitive?: boolean, plainMatchMode?: 'word'|'substring' }} options
 */
export function matchesTextPattern(text, pattern, options = {}) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
        return false;
    }

    const { caseSensitive = false, plainMatchMode = 'word' } = options;
    const explicitRegex = parseRegexPattern(pattern, caseSensitive);

    try {
        if (explicitRegex) {
            const regex = new RegExp(explicitRegex.source, explicitRegex.flags);
            return regex.test(String(text));
        }

        const normalizedPattern = pattern.normalize('NFC').trim();
        if (!normalizedPattern) {
            return false;
        }

        const normalizedText = String(text).normalize('NFC');
        const literalPhrase = normalizedPattern
            .split(/\s+/u)
            .map(escapeRegExp)
            .join('\\s+');

        const flags = caseSensitive ? 'u' : 'iu';
        if (plainMatchMode === 'substring') {
            return new RegExp(literalPhrase, flags).test(normalizedText);
        }

        const startsWithWord = /^[\p{L}\p{N}\p{M}_]/u.test(normalizedPattern);
        const endsWithWord = /[\p{L}\p{N}\p{M}_]$/u.test(normalizedPattern);
        const leftBoundary = startsWithWord ? `(?<!${UNICODE_WORD_CHARACTER})` : '';
        const rightBoundary = endsWithWord ? `(?!${UNICODE_WORD_CHARACTER})` : '';
        return new RegExp(`${leftBoundary}${literalPhrase}${rightBoundary}`, flags).test(normalizedText);
    } catch (error) {
        console.warn(`VectHare: Invalid pattern regex: ${pattern}`, error);
        return false;
    }
}
