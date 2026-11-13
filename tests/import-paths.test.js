/**
 * The test suite aliases SillyTavern modules to stubs by file name, so a
 * wrong number of "../" in an import would still pass every other test.
 * This resolves each relative import against the extension's real install
 * location and checks it lands on a known SillyTavern module or a file in
 * this repository.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
// Where SillyTavern serves the extension from.
const INSTALL = '/public/scripts/extensions/third-party/VectHare';
const ST_MODULES = new Set([
    '/public/script.js',
    '/public/scripts/extensions.js',
    '/public/scripts/utils.js',
    '/public/scripts/constants.js',
    '/public/scripts/secrets.js',
    '/public/scripts/openai.js',
    '/public/scripts/textgen-settings.js',
    '/public/scripts/world-info.js',
    '/public/scripts/popup.js',
    '/public/scripts/extensions/shared.js',
    '/public/scripts/extensions/expressions/index.js',
]);

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return ['node_modules', 'tests', '.git', 'scripts'].includes(entry.name) ? [] : sourceFiles(full);
        return entry.name.endsWith('.js') && entry.name !== 'vitest.config.js' ? [full] : [];
    });
}

const IMPORT_RE = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|^import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm;

describe('relative import paths', () => {
    for (const file of sourceFiles(ROOT)) {
        const rel = path.relative(ROOT, file);
        it(rel, () => {
            const src = fs.readFileSync(file, 'utf8');
            const bad = [];
            for (const [, spec] of src.matchAll(IMPORT_RE)) {
                const installed = path.posix.normalize(path.posix.join(INSTALL, path.posix.dirname(rel.split(path.sep).join('/')), spec));
                if (installed.startsWith(INSTALL + '/')) {
                    if (!fs.existsSync(path.join(ROOT, installed.slice(INSTALL.length + 1)))) bad.push(`${spec} (missing local file)`);
                } else if (!ST_MODULES.has(installed)) {
                    bad.push(`${spec} -> ${installed}`);
                }
            }
            expect(bad).toEqual([]);
        });
    }
});
