import { ModelPresetAdapterError } from './error'

/**
 * Canonical `mapsTo.custom.path` identifiers consumed by the vertex-openai
 * endpoint resolver in `buildRequest.ts`. Registry profiles must use these
 * exact values to route project/location through to the URL builder.
 */
export const VERTEX_CUSTOM_PATH_PROJECT = 'project'
export const VERTEX_CUSTOM_PATH_LOCATION = 'location'

export interface VertexEndpointInput {
    project: string
    location: string
}

/**
 * Builds the Vertex AI OpenAI-compatible Chat Completions endpoint URL.
 * See https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai
 *
 * Regional locations use a `{location}-aiplatform.googleapis.com` host;
 * the `global` location uses the unprefixed `aiplatform.googleapis.com` host.
 */
export function buildVertexOpenAIEndpointUrl(input: VertexEndpointInput): string {
    const project = sanitize(input.project, 'project')
    const location = sanitize(input.location, 'location')
    const host =
        location === 'global'
            ? 'aiplatform.googleapis.com'
            : `${location}-aiplatform.googleapis.com`
    return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/endpoints/openapi/chat/completions`
}

const ALLOWED = /^[a-z0-9][a-z0-9-]*$/iu

function sanitize(value: string, field: string): string {
    if (typeof value !== 'string') {
        throw invalid(`Vertex ${field} must be a string`)
    }
    const trimmed = value.trim()
    if (trimmed.length === 0) {
        throw invalid(`Vertex ${field} is required`)
    }
    if (!ALLOWED.test(trimmed)) {
        throw invalid(
            `Vertex ${field} '${trimmed}' contains invalid characters (allowed: alphanumerics and '-')`,
        )
    }
    return trimmed
}

function invalid(message: string): ModelPresetAdapterError {
    return new ModelPresetAdapterError('invalid-request', message, {
        retryable: false,
        fallbackEligible: false,
    })
}
