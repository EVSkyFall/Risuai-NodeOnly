import { IllustrationImagePromptContractError } from './errors'
import type {
    IllustrationPromptV1,
    IllustrationStoredPromptV1,
    LegacyIllustrationJobPromptV1,
} from './types'

export const MAX_ILLUSTRATION_PROMPT_BYTES = 16 * 1024

// NovelAI documents support for at most six V4 character prompts:
// https://docs.novelai.net/en/image/multiplecharacters/
export const MAX_NAI_V4_CHARACTER_CAPTIONS = 6

const encoder = new TextEncoder()
const promptKeys = new Set([
    'schemaVersion',
    'layout',
    'basePositive',
    'characterPositives',
    'baseNegative',
    'characterNegatives',
])

function invalidPrompt(message: string): never {
    throw new IllustrationImagePromptContractError('image_prompt_invalid', message)
}

function utf8PartBytes(parts: readonly string[]): number {
    return parts.reduce((total, part) => total + encoder.encode(part).byteLength, 0)
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
    if (!Array.isArray(value)) {
        invalidPrompt(`${label} must be an array of strings`)
    }
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (
            !descriptor
            || !Object.hasOwn(descriptor, 'value')
            || typeof descriptor.value !== 'string'
        ) {
            invalidPrompt(`${label} must be a dense array of strings`)
        }
    }
    if (value.length > MAX_NAI_V4_CHARACTER_CAPTIONS) {
        invalidPrompt(`${label} may contain at most ${MAX_NAI_V4_CHARACTER_CAPTIONS} entries`)
    }
}

export function parseIllustrationPromptV1(value: unknown): IllustrationPromptV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidPrompt('prompt must be an object')
    }
    const input = value as Record<string, unknown>
    const inputKeys = Object.keys(input)
    if (
        inputKeys.length !== promptKeys.size
        || inputKeys.some((key) => !promptKeys.has(key))
        || [...promptKeys].some((key) => !Object.hasOwn(input, key))
    ) {
        invalidPrompt('prompt must contain exactly the IllustrationPromptV1 fields')
    }
    for (const key of promptKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            invalidPrompt('prompt fields must be plain data properties')
        }
    }
    if (input.schemaVersion !== 1) invalidPrompt('prompt.schemaVersion must be 1')
    if (input.layout !== 'flat' && input.layout !== 'nai-v4-characters') {
        invalidPrompt('prompt.layout is invalid')
    }
    if (typeof input.basePositive !== 'string') {
        invalidPrompt('prompt.basePositive must be a string')
    }
    if (typeof input.baseNegative !== 'string') {
        invalidPrompt('prompt.baseNegative must be a string')
    }
    assertStringArray(input.characterPositives, 'prompt.characterPositives')
    assertStringArray(input.characterNegatives, 'prompt.characterNegatives')
    if (input.layout === 'flat'
        && (input.characterPositives.length !== 0 || input.characterNegatives.length !== 0)) {
        invalidPrompt('flat prompts require empty character arrays')
    }
    if (input.characterPositives.length !== input.characterNegatives.length) {
        invalidPrompt('positive and negative character prompts must have equal cardinality')
    }

    const prompt: IllustrationPromptV1 = {
        schemaVersion: 1,
        layout: input.layout,
        basePositive: input.basePositive,
        characterPositives: [...input.characterPositives],
        baseNegative: input.baseNegative,
        characterNegatives: [...input.characterNegatives],
    }
    if (utf8PartBytes([prompt.basePositive, ...prompt.characterPositives])
        > MAX_ILLUSTRATION_PROMPT_BYTES) {
        invalidPrompt('positive prompt parts must total at most 16 KiB UTF-8')
    }
    if (utf8PartBytes([prompt.baseNegative, ...prompt.characterNegatives])
        > MAX_ILLUSTRATION_PROMPT_BYTES) {
        invalidPrompt('negative prompt parts must total at most 16 KiB UTF-8')
    }
    return prompt
}

export function wrapLegacyIllustrationPrompt(
    positive: unknown,
    negative: unknown,
): IllustrationPromptV1 {
    if (typeof positive !== 'string' || positive.trim().length === 0) {
        throw new IllustrationImagePromptContractError(
            'image_prompt_invalid',
            'positive prompt must be a non-empty string',
        )
    }
    if (typeof negative !== 'string') {
        throw new IllustrationImagePromptContractError(
            'image_prompt_invalid',
            'negative prompt must be a string',
        )
    }
    return parseIllustrationPromptV1({
        schemaVersion: 1,
        layout: 'flat',
        basePositive: positive,
        characterPositives: [],
        baseNegative: negative,
        characterNegatives: [],
    })
}

export function isLegacyIllustrationStoredPrompt(
    value: IllustrationStoredPromptV1 | unknown,
): value is LegacyIllustrationJobPromptV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const input = value as Record<string, unknown>
    const keys = Object.keys(input)
    return keys.length === 2
        && Object.hasOwn(input, 'positive')
        && Object.hasOwn(input, 'negative')
        && typeof input.positive === 'string'
        && typeof input.negative === 'string'
}

export function decodeIllustrationStoredPrompt(value: unknown): IllustrationPromptV1 {
    if (isLegacyIllustrationStoredPrompt(value)) {
        // Physical legacy records are decoded losslessly, without applying the
        // new structured validation or making them retroactively measurable.
        return {
            schemaVersion: 1,
            layout: 'flat',
            basePositive: value.positive,
            characterPositives: [],
            baseNegative: value.negative,
            characterNegatives: [],
        }
    }
    return parseIllustrationPromptV1(value)
}

export function legacyStoredPrompt(
    positive: string,
    negative: string,
): LegacyIllustrationJobPromptV1 {
    return { positive, negative }
}
