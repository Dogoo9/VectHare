import { beforeEach, describe, expect, it } from 'vitest';
import {
    deleteLexicalItems,
    indexLexicalItems,
    loadLexicalIndex,
    purgeAllLexicalIndexes,
    searchLexicalIndex,
} from '../core/lexical-index.js';

describe('collection lexical index', () => {
    beforeEach(() => purgeAllLexicalIndexes());

    it('persists corpus statistics and retrieves outside a dense candidate set', () => {
        indexLexicalItems('books', [
            { hash: 1, text: 'common words' },
            { hash: 2, text: 'rare albatross albatross' },
        ]);

        const index = loadLexicalIndex('books');
        expect(index.documentCount).toBe(2);
        expect(index.documentLengths['2']).toBe(3);
        expect(index.documentFrequencies.albatross).toBe(1);
        expect(index.postings.albatross['2']).toBe(2);
        expect(searchLexicalIndex('books', 'albatross', 10).map(result => result.hash)).toEqual([2]);
    });

    it('replaces postings on update and reflects deletion immediately', () => {
        indexLexicalItems('live', [{ hash: 1, text: 'before' }, { hash: 2, text: 'remove me' }]);
        indexLexicalItems('live', [{ hash: 1, text: 'after' }]);
        expect(searchLexicalIndex('live', 'before', 10)).toEqual([]);
        expect(searchLexicalIndex('live', 'after', 10)[0].hash).toBe(1);

        deleteLexicalItems('live', [2]);
        expect(searchLexicalIndex('live', 'remove', 10)).toEqual([]);
        expect(loadLexicalIndex('live').documentCount).toBe(1);
    });

    it('orders tied lexical scores deterministically by hash', () => {
        indexLexicalItems('ties', [
            { hash: 30, text: 'equal' },
            { hash: 10, text: 'equal' },
            { hash: 20, text: 'equal' },
        ]);
        expect(searchLexicalIndex('ties', 'equal', 10).map(result => result.hash)).toEqual([10, 20, 30]);
    });
});
