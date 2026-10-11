import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    deleteLexicalItems,
    indexLexicalItems,
    loadLexicalIndex,
    purgeAllLexicalIndexes,
    searchLexicalIndex,
} from '../core/lexical-index.js';

describe('collection lexical index', () => {
    beforeEach(() => purgeAllLexicalIndexes());
    afterEach(() => {
        purgeAllLexicalIndexes();
        vi.unstubAllGlobals();
    });

    it('scores terms that collide with Object prototype properties without mutating them', () => {
        indexLexicalItems('prototype-terms', [
            { hash: 1, text: 'constructor constructor __proto__' },
            { hash: 2, text: 'constructor castle' },
        ]);

        const index = loadLexicalIndex('prototype-terms');
        expect(index.documentFrequencies.constructor).toBe(2);
        expect(index.postings.constructor['1']).toBe(2);
        const matches = searchLexicalIndex('prototype-terms', 'constructor', 10);
        expect(matches.map(result => result.hash)).toEqual([1, 2]);
        expect(matches.every(result => Number.isFinite(result.bm25Score))).toBe(true);
        expect(searchLexicalIndex('prototype-terms', '__proto__', 10).map(result => result.hash)).toEqual([1]);
        expect(Object.hasOwn(Object, '1')).toBe(false);
        expect(Object.hasOwn(Object.prototype, '1')).toBe(false);
    });

    it('adds, replaces, and deletes hashes that collide with Object prototype properties', () => {
        indexLexicalItems('prototype-hashes', [
            { hash: '__proto__', text: 'castle' },
            { hash: 'constructor', text: 'castle' },
        ]);
        expect(loadLexicalIndex('prototype-hashes').documentCount).toBe(2);
        expect(searchLexicalIndex('prototype-hashes', 'castle', 10).map(result => result.hash))
            .toEqual(['__proto__', 'constructor']);

        indexLexicalItems('prototype-hashes', [{ hash: '__proto__', text: 'tower' }]);
        expect(searchLexicalIndex('prototype-hashes', 'castle', 10).map(result => result.hash)).toEqual(['constructor']);
        deleteLexicalItems('prototype-hashes', ['__proto__', 'constructor']);
        expect(loadLexicalIndex('prototype-hashes').documentCount).toBe(0);
        expect(searchLexicalIndex('prototype-hashes', 'tower', 10)).toEqual([]);
    });

    it('handles prototype-named terms and hashes after loading a persisted index', () => {
        const entries = new Map();
        vi.stubGlobal('localStorage', {
            getItem: key => entries.get(key) ?? null,
            setItem: (key, value) => entries.set(key, value),
            removeItem: key => entries.delete(key),
            key: index => [...entries.keys()][index],
            get length() { return entries.size; },
        });
        indexLexicalItems('persisted', [{ hash: 1, text: 'castle' }]);
        // Each operation reloads the JSON representation from storage.
        indexLexicalItems('persisted', [{ hash: '__proto__', text: 'constructor' }]);
        expect(loadLexicalIndex('persisted').documentCount).toBe(2);
        expect(searchLexicalIndex('persisted', 'constructor', 10)).toMatchObject([
            { hash: '__proto__', text: 'constructor' },
        ]);
        deleteLexicalItems('persisted', ['__proto__']);
        expect(searchLexicalIndex('persisted', 'constructor', 10)).toEqual([]);
        expect(loadLexicalIndex('persisted').documentCount).toBe(1);
    });

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
