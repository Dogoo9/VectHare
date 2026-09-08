import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, logger } from '../utils/logger.js';

describe('logger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        configureLogger({ level: 'info', content: false });
    });

    it('suppresses messages below the configured level', () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        configureLogger({ level: 'info' });
        logger.debug('diagnostic');
        logger.trace('fine diagnostic');
        logger.info('retrieval complete');
        expect(debug).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledOnce();
    });

    it.each(['error', 'warn', 'info'])('does not emit content text at %s level', logLevel => {
        const output = vi.spyOn(console, logLevel).mockImplementation(() => {});
        configureLogger({ level: logLevel, content: false });
        logger[logLevel]('event', { text: 'private passage', query: 'private question', count: 2 });
        expect(JSON.stringify(output.mock.calls)).not.toContain('private passage');
        expect(JSON.stringify(output.mock.calls)).not.toContain('private question');
        expect(output.mock.calls[0][1]).toMatchObject({ text: '[redacted:15 chars]', query: '[redacted:16 chars]', count: 2 });
    });

    it('only emits content when explicitly enabled', () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        configureLogger({ level: 'debug', content: true });
        logger.debug('diagnostic', { text: 'explicit content' });
        expect(debug.mock.calls[0][1].text).toBe('explicit content');
    });
});
