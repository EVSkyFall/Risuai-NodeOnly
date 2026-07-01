import type { ModelPreset } from '../types'
import { ModelPresetAdapterError } from './error'

/**
 * Resolves the wire model id for an adapter directly from the preset's user
 * values / schema default / snapshot, bypassing `customBody`.
 *
 * Per plan §4-5 the model selection is a wire invariant: `customBody.model`
 * must not be able to redirect requests to a different model (or, for Google,
 * a different endpoint URL via the URL path). Adapters use this helper so the
 * value cannot be hijacked by a customBody key collision.
 */
export function resolveWireModelId(
    preset: ModelPreset,
    options: { vendorName?: string } = {},
): string {
    const vendorName = options.vendorName ?? 'Adapter'
    const schema = preset.profileSnapshot.schema
    const modelField = schema.find((field) => field.key === 'modelId')
    if (modelField) {
        // If the user values record explicitly carries the modelId key, that
        // intent must be a non-empty string. Empty string / null / wrong type
        // is treated as a configuration error rather than silently falling
        // back to the default model (otherwise corrupted UI/migration data
        // would call the wrong endpoint without the user noticing).
        if (Object.prototype.hasOwnProperty.call(preset.userValues, modelField.key)) {
            const userValue = preset.userValues[modelField.key]
            if (typeof userValue === 'string' && userValue.length > 0) return userValue
            if (userValue !== undefined) {
                throw new ModelPresetAdapterError(
                    'invalid-request',
                    `${vendorName} adapter requires a non-empty string modelId user value`,
                    { retryable: false },
                )
            }
        }
        if (typeof modelField.default === 'string' && modelField.default.length > 0) {
            return modelField.default
        }
    }
    if (preset.profileSnapshot.modelId) return preset.profileSnapshot.modelId
    throw new ModelPresetAdapterError(
        'invalid-request',
        `${vendorName} adapter requires a modelId`,
        { retryable: false },
    )
}
