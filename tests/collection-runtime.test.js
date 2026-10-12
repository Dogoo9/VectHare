import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extension_settings } from '../../../../extensions.js';
import { getCollectionMeta, setCollectionMeta, setChatCollectionPolicy, applyChatCollectionPolicy } from '../core/collection-metadata.js';
import { storedCollectionKey, resolveCollectionSettings, physicalCollectionId, lockCollections, collectionMutation } from '../core/collection-runtime.js';
import { profile, fingerprint, probes } from './embedding-fixtures.js';
beforeEach(() => { extension_settings.vecthare = { collections: {}, chatCollectionPolicies: {} }; });
describe('physical namespaces and collection settings', () => {
    it('isolates same names and leaves bare aliases ambiguous', () => {
        setCollectionMeta('standard:koboldcpp:same', { displayName: 'kobold' });
        setCollectionMeta('standard:llamacpp:same', { displayName: 'llama' });
        expect(getCollectionMeta('standard:koboldcpp:same').displayName).toBe('kobold');
        expect(getCollectionMeta('standard:llamacpp:same').displayName).toBe('llama');
        expect(() => storedCollectionKey('same')).toThrow('Ambiguous');
        expect(getCollectionMeta('qdrant:koboldcpp:same').displayName).toBeNull();
    });
    it('preserves unambiguous legacy bare aliases', () => {
        setCollectionMeta('old', { displayName: 'old data' });
        expect(getCollectionMeta('standard:koboldcpp:old').displayName).toBe('old data');
    });
    it('keeps inference separate from source/model/backend/ID', () => {
        const locator = { backend: 'lancedb', source: 'koboldcpp', model: 'old-model', collectionId: 'physical' };
        setCollectionMeta('lancedb:koboldcpp:logical', { storageLocator: locator, embeddingConnection: profile(), embedding: { fingerprint: fingerprint(), probes, compatibility: 'compatible' } });
        const resolved = resolveCollectionSettings('lancedb:koboldcpp:logical', { source: 'openai', vector_backend: 'qdrant' });
        expect(resolved.source).toBe('llamacpp'); expect(resolved.collection_locator).toEqual(locator);
        expect(physicalCollectionId('logical', resolved)).toBe('physical');
        expect(resolved.local_embedding_profile.probes).toEqual(probes);
    });
    it('fails closed when a saved profile fingerprint changes', () => {
        setCollectionMeta('old', { embeddingConnection: profile({ fingerprint: fingerprint({ queryPrefix: 'changed' }) }), embedding: { fingerprint: fingerprint() } });
        expect(() => resolveCollectionSettings('old', {})).toThrow('provenance');
    });
    it('keeps chat selections scoped to their source/backend', () => {
        setChatCollectionPolicy('chat', { mode: 'only_selected', selectedCollections: ['standard:koboldcpp:lorebook_same'] });
        expect(applyChatCollectionPolicy(['standard:koboldcpp:lorebook_same', 'standard:llamacpp:lorebook_same'], 'chat')).toEqual(['standard:koboldcpp:lorebook_same']);
    });
    it('drains ongoing autosync before snapshot, rejects overlapping migrations, and releases locks', async () => {
        const settings = { collection_locator: { backend: 'standard', source: 'koboldcpp', model: '', collectionId: 'old' } };
        let finish; const running = collectionMutation('old', settings, () => new Promise(resolve => { finish = resolve; }));
        await Promise.resolve();
        let acquired = false; const lock = lockCollections([{ id: 'old', settings }]).then(unlock => { acquired = true; return unlock; });
        await Promise.resolve(); expect(acquired).toBe(false);
        await expect(collectionMutation('old', settings, vi.fn())).rejects.toThrow('paused');
        await expect(lockCollections([{ id: 'old', settings }])).rejects.toThrow('already');
        finish(); await running; const unlock = await lock; expect(acquired).toBe(true); unlock();
        const fn = vi.fn(); await collectionMutation('old', settings, fn); expect(fn).toHaveBeenCalledOnce();
    });
});
