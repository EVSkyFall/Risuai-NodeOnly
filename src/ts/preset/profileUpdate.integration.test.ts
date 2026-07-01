/**
 * Integration coverage for `applyProfileSnapshotUpdate` (plan §14-7 / §14-11).
 *
 * Unit-level tests already cover `getProfileUpdateAvailability` and
 * `diffProfileSnapshot` (see profileUpdate.test.ts). This file exercises the
 * apply step end-to-end: starting from a ModelPreset that targets a v1 profile
 * snapshot, simulate a registry that has rolled the profile to v2, then drive
 * the full availability-check + apply flow and assert that the resulting
 * ModelPreset is internally coherent.
 */
import { describe, expect, test } from 'vitest'
import {
    applyProfileSnapshotUpdate,
    getProfileUpdateAvailability,
} from './profileUpdate'
import { resolveSnapshot } from './registry'
import type {
    BaseProviderDefinition,
    ModelPreset,
    ModelProfile,
    RegistryCache,
    ResolvedModelProfileSnapshot,
} from './types'

function makeBaseProvider(): BaseProviderDefinition {
    return {
        id: 'demo',
        version: 1,
        displayName: 'Demo',
        adapterKind: 'openai-compatible',
        authKinds: ['bearer'],
        endpointKinds: ['static'],
        requestSchema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        sourceUrls: ['https://example.test/docs'],
    }
}

function makeProfileV1(): ModelProfile {
    return {
        id: 'demo:standard',
        version: 1,
        displayName: 'Demo v1',
        providerBaseId: 'demo',
        profileStatus: 'current',
        modelId: 'demo-v1',
        endpoint: { kind: 'static', url: 'https://demo.test/v1/chat/completions' },
        auth: { kind: 'bearer', fields: ['apiKey'] },
        defaults: { temperature: 0.5 },
        schema: [
            {
                key: 'reasoningEffort',
                type: 'string',
                label: 'Reasoning Effort',
                default: 'low',
                mapsTo: { target: 'body', path: 'reasoning_effort' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        capabilities: ['streaming'],
        sourceUrls: ['https://example.test/docs'],
    }
}

function makeProfileV2(): ModelProfile {
    // v2 introduces a new field, removes the v1-only `reasoningEffort` field,
    // and bumps the model id. This is the exact shape the snapshot-update
    // path must handle: orphan → orphanValues, new field becomes addressable.
    return {
        id: 'demo:standard',
        version: 2,
        displayName: 'Demo v2',
        providerBaseId: 'demo',
        profileStatus: 'current',
        modelId: 'demo-v2',
        endpoint: { kind: 'static', url: 'https://demo.test/v2/chat/completions' },
        auth: { kind: 'bearer', fields: ['apiKey'] },
        defaults: { temperature: 0.7 },
        schema: [
            {
                key: 'thinkingBudget',
                type: 'integer',
                label: 'Thinking Budget',
                default: 1024,
                mapsTo: { target: 'body', path: 'thinking.budget_tokens' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        capabilities: ['streaming', 'reasoning'],
        sourceUrls: ['https://example.test/docs'],
    }
}

function makeRegistry(profile: ModelProfile): RegistryCache {
    return {
        schemaVersion: 4,
        registries: {
            bundled: {
                fetchedAt: 1_000,
                baseProviders: { demo: makeBaseProvider() },
                profiles: { [profile.id]: profile },
            },
        },
    }
}

function snapshotFor(profile: ModelProfile): ResolvedModelProfileSnapshot {
    return resolveSnapshot(makeRegistry(profile), profile.id)
}

function makePresetOnV1(): ModelPreset {
    const v1Snapshot = snapshotFor(makeProfileV1())
    return {
        id: 'preset-1',
        name: 'My Demo Preset',
        sourceProfile: {
            registryId: 'bundled',
            profileId: 'demo:standard',
            profileVersion: 1,
            fetchedAt: 1_000,
        },
        profileSnapshot: v1Snapshot,
        userValues: {
            modelId: 'demo-v1-custom',
            reasoningEffort: 'high', // will become orphan on v2
        },
        createdAt: 100,
        updatedAt: 100,
    }
}

describe('applyProfileSnapshotUpdate — end-to-end v1 → v2 migration', () => {
    test('upgrades preset to v2 snapshot, moves removed field to orphanValues, exposes new field as added', () => {
        const preset = makePresetOnV1()
        const v2Registry = makeRegistry(makeProfileV2())

        // Step 1: availability check confirms an update is offered. Pin `now`
        // so the synthesized latestSourceProfile.fetchedAt is deterministic.
        const availability = getProfileUpdateAvailability(preset, v2Registry, { now: () => 2_000 })
        expect(availability.status).toBe('available')
        if (availability.status !== 'available') return
        expect(availability.fromVersion).toBe(1)
        expect(availability.toVersion).toBe(2)

        // Step 2: apply the update with the same fixed `now`.
        const result = applyProfileSnapshotUpdate(
            preset,
            availability.latestSnapshot,
            { now: () => 2_000, sourceProfile: availability.latestSourceProfile },
        )

        // Resulting preset points at v2 snapshot.
        expect(result.preset.profileSnapshot.profileVersion).toBe(2)
        expect(result.preset.profileSnapshot.modelId).toBe('demo-v2')
        expect(result.preset.sourceProfile?.profileVersion).toBe(2)
        expect(result.preset.sourceProfile?.fetchedAt).toBe(2_000)
        expect(result.preset.updatedAt).toBe(2_000)

        // userValues only retain keys still present in v2 schema.
        expect(result.preset.userValues).toEqual({ modelId: 'demo-v1-custom' })

        // Removed field flows into orphanValues for later manual recovery.
        expect(result.preset.orphanValues).toEqual({ reasoningEffort: 'high' })
        expect(result.movedToOrphan).toEqual([
            { key: 'reasoningEffort', value: 'high', reason: 'removed' },
        ])

        // New field surfaces in newFieldKeys for UI to highlight.
        expect(result.newFieldKeys).toEqual(['thinkingBudget'])

        // Diff snapshot is internally consistent.
        expect(result.diff.fromVersion).toBe(1)
        expect(result.diff.toVersion).toBe(2)
        expect(result.diff.modelIdChanged).toBe(true)
        expect(result.diff.endpointChanged).toBe(true)
        expect(result.diff.defaultsChanged).toBe(true)
        expect(result.diff.capabilitiesChanged).toBe(true)
    })

    test('preserves previously-stored orphanValues across an update', () => {
        const preset = makePresetOnV1()
        preset.orphanValues = { staleKey: 'from-an-older-cycle' }

        const v2Registry = makeRegistry(makeProfileV2())
        const availability = getProfileUpdateAvailability(preset, v2Registry, { now: () => 2_000 })
        if (availability.status !== 'available') throw new Error('expected available')

        const result = applyProfileSnapshotUpdate(preset, availability.latestSnapshot, {
            now: () => 2_000,
            sourceProfile: availability.latestSourceProfile,
        })

        // Both old and newly-orphaned keys survive.
        expect(result.preset.orphanValues).toEqual({
            staleKey: 'from-an-older-cycle',
            reasoningEffort: 'high',
        })
    })

    test('type-changed field also moves to orphanValues (regression for §14-7 rule)', () => {
        const preset = makePresetOnV1()
        // userValues now has a value for a key that v2 keeps but with a
        // different type — simulate by re-using `reasoningEffort` in v2 but
        // typed as integer instead of string.
        const v2 = makeProfileV2()
        v2.schema = [
            ...v2.schema,
            {
                key: 'reasoningEffort',
                type: 'integer', // was 'string' in v1
                label: 'Reasoning Effort (numeric)',
                mapsTo: { target: 'body', path: 'reasoning_effort' },
            },
        ]
        const v2Registry = makeRegistry(v2)

        const availability = getProfileUpdateAvailability(preset, v2Registry, { now: () => 2_000 })
        if (availability.status !== 'available') throw new Error('expected available')

        const result = applyProfileSnapshotUpdate(preset, availability.latestSnapshot, {
            now: () => 2_000,
            sourceProfile: availability.latestSourceProfile,
        })

        expect(result.movedToOrphan).toEqual([
            { key: 'reasoningEffort', value: 'high', reason: 'type-changed' },
        ])
        expect(result.preset.orphanValues).toEqual({ reasoningEffort: 'high' })
        // userValues drops the type-incompatible value rather than coercing.
        expect(result.preset.userValues.reasoningEffort).toBeUndefined()
    })

    test('does not mutate the input preset', () => {
        const preset = makePresetOnV1()
        const snapshotBefore = JSON.stringify(preset)

        const v2Registry = makeRegistry(makeProfileV2())
        const availability = getProfileUpdateAvailability(preset, v2Registry, { now: () => 2_000 })
        if (availability.status !== 'available') throw new Error('expected available')

        applyProfileSnapshotUpdate(preset, availability.latestSnapshot, {
            now: () => 2_000,
            sourceProfile: availability.latestSourceProfile,
        })

        expect(JSON.stringify(preset)).toBe(snapshotBefore)
    })

    test('keeps userValues untouched when the snapshot is functionally identical', () => {
        const preset = makePresetOnV1()
        // Pretend the registry already has v1 — availability returns 'current'
        // and there's nothing to apply. But if a caller forces an apply with
        // the same snapshot, the result must not throw away userValues.
        const sameSnapshot = preset.profileSnapshot
        const result = applyProfileSnapshotUpdate(preset, sameSnapshot, {
            now: () => 2_000,
            sourceProfile: preset.sourceProfile,
        })

        expect(result.preset.userValues).toEqual(preset.userValues)
        expect(result.preset.orphanValues).toBeUndefined()
        expect(result.movedToOrphan).toEqual([])
        expect(result.newFieldKeys).toEqual([])
    })

    test('drops sourceProfile when the latest snapshot belongs to a different profile id', () => {
        const preset = makePresetOnV1()
        // Force a snapshot from a completely different profile id.
        const otherProfile: ModelProfile = { ...makeProfileV2(), id: 'demo:other' }
        const otherSnapshot = snapshotFor(otherProfile)
        const result = applyProfileSnapshotUpdate(preset, otherSnapshot, {
            now: () => 2_000,
            // no sourceProfile override; the helper should clear it because
            // preset.sourceProfile.profileId !== latestSnapshot.profileId
        })

        expect(result.preset.sourceProfile).toBeUndefined()
        expect(result.preset.profileSnapshot.profileId).toBe('demo:other')
    })
})
