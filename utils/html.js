/**
 * Escapes a value for safe interpolation into HTML text and quoted
 * attribute values. `null`/`undefined` become an empty string.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
