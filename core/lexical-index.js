import { tokenizeSimple } from './bm25-scorer.js';

const STORAGE_PREFIX = 'vecthare:lexical-index:';
const memoryIndexes = new Map();

function storage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (_) {
        return null;
    }
}

function key(collectionId) {
    return `${STORAGE_PREFIX}${encodeURIComponent(collectionId)}`;
}

function emptyIndex() {
    return { version: 1, documentCount: 0, documentLengths: {}, documentFrequencies: {}, postings: {}, documents: {} };
}

export function loadLexicalIndex(collectionId) {
    const persistent = storage();
    if (persistent) {
        try {
            const value = persistent.getItem(key(collectionId));
            if (value) return JSON.parse(value);
        } catch (error) {
            console.warn('[LexicalIndex] Could not load persisted index:', error);
        }
    }
    return memoryIndexes.get(collectionId) || emptyIndex();
}

function save(collectionId, index) {
    memoryIndexes.set(collectionId, index);
    const persistent = storage();
    if (persistent) {
        try {
            persistent.setItem(key(collectionId), JSON.stringify(index));
        } catch (error) {
            console.warn('[LexicalIndex] Could not persist index; using the in-memory copy:', error);
        }
    }
}

function removeDocument(index, hash) {
    const id = String(hash);
    if (!index.documents[id]) return;
    for (const term of Object.keys(index.postings)) {
        if (index.postings[term][id] === undefined) continue;
        delete index.postings[term][id];
        index.documentFrequencies[term]--;
        if (index.documentFrequencies[term] <= 0) {
            delete index.documentFrequencies[term];
            delete index.postings[term];
        }
    }
    delete index.documents[id];
    delete index.documentLengths[id];
    index.documentCount--;
}

/** Add or replace chunks in a collection's persistent inverted index. */
export function indexLexicalItems(collectionId, items) {
    const index = loadLexicalIndex(collectionId);
    for (const item of items || []) {
        if (item?.hash === undefined || item?.hash === null) continue;
        removeDocument(index, item.hash);
        const id = String(item.hash);
        const text = typeof item.text === 'string' ? item.text : '';
        const tokens = tokenizeSimple(text);
        const frequencies = {};
        for (const token of tokens) frequencies[token] = (frequencies[token] || 0) + 1;
        index.documents[id] = { ...item, hash: item.hash, text };
        index.documentLengths[id] = tokens.length;
        index.documentCount++;
        for (const [term, frequency] of Object.entries(frequencies)) {
            index.postings[term] ||= {};
            index.postings[term][id] = frequency;
            index.documentFrequencies[term] = (index.documentFrequencies[term] || 0) + 1;
        }
    }
    save(collectionId, index);
    return index;
}

export function deleteLexicalItems(collectionId, hashes) {
    const index = loadLexicalIndex(collectionId);
    for (const hash of hashes || []) removeDocument(index, hash);
    save(collectionId, index);
}

export function purgeLexicalIndex(collectionId) {
    memoryIndexes.delete(collectionId);
    storage()?.removeItem(key(collectionId));
}

export function purgeAllLexicalIndexes() {
    memoryIndexes.clear();
    const persistent = storage();
    if (!persistent) return;
    const keys = [];
    for (let i = 0; i < persistent.length; i++) {
        const itemKey = persistent.key(i);
        if (itemKey?.startsWith(STORAGE_PREFIX)) keys.push(itemKey);
    }
    keys.forEach(itemKey => persistent.removeItem(itemKey));
}

/** Generate lexical candidates from the complete maintained collection index. */
export function searchLexicalIndex(collectionId, query, topK, options = {}) {
    const index = loadLexicalIndex(collectionId);
    const queryTerms = [...new Set(tokenizeSimple(query || ''))];
    if (!queryTerms.length || !index.documentCount) return [];
    const k1 = options.k1 ?? 1.5;
    const b = options.b ?? 0.75;
    const lengths = Object.values(index.documentLengths);
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / index.documentCount || 1;
    const scores = new Map();
    for (const term of queryTerms) {
        const posting = index.postings[term];
        if (!posting) continue;
        const df = index.documentFrequencies[term];
        const idf = Math.log(1 + (index.documentCount - df + 0.5) / (df + 0.5));
        for (const [id, frequency] of Object.entries(posting)) {
            const length = index.documentLengths[id];
            const score = idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * length / averageLength));
            scores.set(id, (scores.get(id) || 0) + score);
        }
    }
    return [...scores.entries()]
        .map(([id, bm25Score]) => ({ ...index.documents[id], metadata: index.documents[id], bm25Score }))
        .sort((a, b) => b.bm25Score - a.bm25Score || String(a.hash).localeCompare(String(b.hash)))
        .slice(0, Math.max(0, topK));
}
