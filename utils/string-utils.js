/**
 * Text formatting helpers used to clean text before embedding.
 * Originally adapted from https://github.com/prolix-oc/ST-Helpers
 *
 * NOTE: embedding fingerprints record 'strip-markdown-html' cleaning; changing
 * these regexes changes the embedded text and invalidates stored vectors.
 * @module stringUtils
 */

const StringUtils = {
  /**
   * Strip HTML tags from string
   *
   * @param {string} str - String containing HTML
   * @param {boolean} preserveSpaces - Replace tags with spaces (default: true)
   * @returns {string} String without HTML tags
   */
  stripHtml(str, preserveSpaces = true) {
    if (typeof str !== 'string') {
      return '';
    }

    const replacement = preserveSpaces ? ' ' : '';
    return str
      .replace(/<[^>]*>/g, replacement)
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * Strip Markdown formatting from string
   *
   * @param {string} str - String containing Markdown
   * @returns {string} String without Markdown formatting
   */
  /**
   * Strip Markdown formatting from string
   *
   * @param {string} str - String containing Markdown
   * @returns {string} String without Markdown formatting
   */
  stripMarkdown(str) {
    if (typeof str !== 'string') {
      return '';
    }

    return str
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      // Remove inline code
      .replace(/`([^`]+)`/g, '$1')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, '')
      // Remove links
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // Remove horizontal rules
      .replace(/^(-{3,}|_{3,}|\*{3,})$/gm, '')
      // Remove blockquotes
      .replace(/^>\s+/gm, '')
      .trim();
  },
};

export default StringUtils;
