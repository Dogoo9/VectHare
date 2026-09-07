/**
 * Tests lorebook preparation and the Include Disabled Entries storage setting.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/../../../../extensions.js', () => ({
    extension_settings: { vecthare: {} },
    getContext: vi.fn(() => ({})),
}));

vi.mock('../core/../../../../utils.js', () => ({
    getStringHash: vi.fn(text => text),
}));

vi.mock('../core/../../../../../script.js', () => ({
    getCurrentChatId: vi.fn(() => 'test-chat'),
}));

vi.mock('../core/core-vector-api.js', () => ({
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));

vi.mock('../core/collection-metadata.js', () => ({
    setCollectionMeta: vi.fn(),
    getDefaultDecayForType: vi.fn(),
}));

vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn() }));
vi.mock('../backends/backend-manager.js', () => ({ getBackend: vi.fn() }));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: {} }));

import { prepareLorebookContent } from '../core/content-vectorization.js';

describe('prepareLorebookContent', () => {
    const entries = [
        { uid: 1, content: 'Enabled entry', disable: false, key: ['enabled'] },
        { uid: 2, content: 'Disabled entry', disable: true, key: ['disabled'] },
    ];

    it('excludes disabled entries when the checkbox setting is off', () => {
        const prepared = prepareLorebookContent({ entries }, { strategy: 'per_entry', includeDisabled: false });

        expect(prepared.text).toEqual(['Enabled entry']);
        expect(prepared.entries.map(entry => entry.uid)).toEqual([1]);
    });

    it('indexes disabled entries and preserves their state when the checkbox setting is on', () => {
        const prepared = prepareLorebookContent({ entries }, { strategy: 'per_entry', includeDisabled: true });

        expect(prepared.text).toEqual(['Enabled entry', 'Disabled entry']);
        expect(prepared.entries[1]).toMatchObject({ uid: 2, disable: true });
    });
});
