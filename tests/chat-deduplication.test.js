import { describe, expect, it } from 'vitest';
import { getStringHash } from '../core/../../../../utils.js';
import { deduplicateChunks } from '../core/chat-vectorization.js';

const debug = () => ({ trace: [], chunkFates: {}, stages: {}, stats: {} });
const msg = (mes) => ({ mes });

describe('deduplicateChunks', () => {
    const chat = ['old one', 'old two', 'recent one', 'recent two'].map(msg);

    it('skips per-message chunks that are still visible in the recent context', () => {
        const chunks = [
            { hash: getStringHash('recent two'), text: 'recent two' },
            { hash: getStringHash('old one'), text: 'old one' },
        ];
        const { toInject, skipped } = deduplicateChunks(chunks, chat, { deduplication_depth: 2 }, debug());
        expect(toInject.map(c => c.text)).toEqual(['old one']);
        expect(skipped.map(c => c.text)).toEqual(['recent two']);
    });

    it('treats depth 0 as the whole chat', () => {
        const chunks = [{ hash: getStringHash('old one'), text: 'old one' }];
        const { toInject } = deduplicateChunks(chunks, chat, { deduplication_depth: 0 }, debug());
        expect(toInject).toEqual([]);
    });

    it('skips grouped chunks only when every covered message is visible', () => {
        const full = { hash: 1, metadata: { messageHashes: ['recent one', 'recent two'].map(getStringHash) } };
        const partial = { hash: 2, metadata: { messageHashes: ['old two', 'recent one'].map(getStringHash) } };
        const { toInject, skipped } = deduplicateChunks([full, partial], chat, { deduplication_depth: 2 }, debug());
        expect(skipped).toEqual([full]);
        expect(toInject).toEqual([partial]);
    });
});
