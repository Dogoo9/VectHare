import { beforeEach, expect, it } from 'vitest';
import { extension_settings } from '../../../../extensions.js';
import { getChunkMetadata, saveChunkMetadata, deleteChunkMetadata, setCollectionMeta,
    setChunkTemporallyBlind, isChunkTemporallyBlind } from '../core/collection-metadata.js';

const source = 'qdrant:koboldcpp:source';
const copy = 'qdrant:koboldcpp:copy';
beforeEach(() => {
    extension_settings.vecthare = { collections: {} };
    setCollectionMeta(source, {});
    setCollectionMeta(copy, {});
});

it('isolates equal hashes across collections, including after settings reload', () => {
    saveChunkMetadata(42, { enabled: false, keywords: ['original'] }, source);
    saveChunkMetadata(42, { enabled: true, keywords: ['copy'] }, copy);
    extension_settings.vecthare = JSON.parse(JSON.stringify(extension_settings.vecthare));
    expect(getChunkMetadata(42, source)).toMatchObject({ enabled: false, keywords: ['original'] });
    expect(getChunkMetadata(42, copy)).toMatchObject({ enabled: true, keywords: ['copy'] });
    expect(getChunkMetadata(42)).toBeNull();
});

it('retains legacy settings without letting scoped edits or deletion modify them', () => {
    saveChunkMetadata(42, { enabled: false, conditions: { rules: ['legacy'] } });
    const legacy = structuredClone(getChunkMetadata(42));
    expect(getChunkMetadata(42, source)).toEqual(legacy);
    const edited = getChunkMetadata(42, copy);
    edited.conditions.rules.push('new');
    saveChunkMetadata(42, edited, copy);
    expect(getChunkMetadata(42, source)).toEqual(legacy);
    deleteChunkMetadata(42, copy);
    expect(getChunkMetadata(42, copy)).toBeNull();
    expect(getChunkMetadata(42, source)).toEqual(legacy);
    expect(getChunkMetadata(42)).toEqual(legacy);
});

it('isolates the same collection name in different backend namespaces', () => {
    const other = 'standard:koboldcpp:source';
    setCollectionMeta(other, {});
    saveChunkMetadata(42, { enabled: false }, source);
    saveChunkMetadata(42, { enabled: true }, other);
    expect(getChunkMetadata(42, source).enabled).toBe(false);
    expect(getChunkMetadata(42, other).enabled).toBe(true);
});

it('scopes temporal immunity to the selected collection', () => {
    setChunkTemporallyBlind(42, true, copy);
    expect(isChunkTemporallyBlind(42, copy)).toBe(true);
    expect(isChunkTemporallyBlind(42, source)).toBe(false);
});
