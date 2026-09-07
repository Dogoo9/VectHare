import { describe, expect, it } from 'vitest';
import { matchesTextPattern } from '../core/plain-text-matcher.js';
import { evaluateConditionRule } from '../core/conditional-activation.js';

describe('shared plain-text matcher', () => {
    it.each([
        ['art', 'Art is everywhere'],
        ['red fox', 'A RED   FOX appeared'],
        ['red fox', 'a red\nfox appeared'],
        ['hello', '(hello), friend'],
        ["don't", "Please don't go"],
        ['mother-in-law', 'my mother-in-law'],
        ['猫', 'その 猫 は眠る'],
        ['café', 'A CAFE\u0301 table'],
    ])('matches plain %j in %j using words and normalized whitespace', (pattern, text) => {
        expect(matchesTextPattern(text, pattern)).toBe(true);
    });

    it.each([
        ['art', 'party'],
        ['art', 'artful'],
        ['cat', 'concatenate'],
        ['猫', '子猫'],
        ['red fox', 'red clever fox'],
    ])('does not match plain %j inside %j', (pattern, text) => {
        expect(matchesTextPattern(text, pattern)).toBe(false);
    });

    it('supports case-sensitive matching', () => {
        expect(matchesTextPattern('Art', 'art', { caseSensitive: true })).toBe(false);
        expect(matchesTextPattern('Art', 'Art', { caseSensitive: true })).toBe(true);
    });

    it('escapes regex punctuation in plain values', () => {
        expect(matchesTextPattern('Use C++ (today).', 'C++ (today)')).toBe(true);
        expect(matchesTextPattern('Use CCCC today.', 'C++ (today)')).toBe(false);
    });

    it('retains explicit substring compatibility mode', () => {
        expect(matchesTextPattern('party', 'art', { plainMatchMode: 'substring' })).toBe(true);
    });

    it('retains /regex/flags behavior', () => {
        expect(matchesTextPattern('PARTIES', '/part(y|ies)/i')).toBe(true);
        expect(matchesTextPattern('PARTIES', '/part(y|ies)/')).toBe(true);
        expect(matchesTextPattern('PARTIES', '/part(y|ies)/', { caseSensitive: true })).toBe(false);
    });
});

describe('pattern conditions use the shared matcher', () => {
    const context = { recentMessages: ['The party starts now.'] };

    it('defaults plain conditions to word matching', () => {
        expect(evaluateConditionRule({ type: 'pattern', settings: { patterns: ['art'] } }, context)).toBe(false);
    });

    it('allows substring compatibility and explicit regex conditions', () => {
        expect(evaluateConditionRule({ type: 'pattern', settings: { patterns: ['art'], plainMatchMode: 'substring' } }, context)).toBe(true);
        expect(evaluateConditionRule({ type: 'pattern', settings: { patterns: ['/PARTY/i'] } }, context)).toBe(true);
    });
});
