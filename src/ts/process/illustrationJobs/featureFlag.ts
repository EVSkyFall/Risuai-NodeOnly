import { readPersistentJson, writePersistentJson } from '../../storage/persistentKv'

export const ILLUSTRATION_FEATURE_FLAG_KEY = 'illustration:v1:featureEnabled'

export class IllustrationFeatureDisabledError extends Error {
    readonly code = 'feature_disabled' as const

    constructor() {
        super('Agentic illustration is disabled')
        this.name = 'IllustrationFeatureDisabledError'
    }
}

export async function isIllustrationFeatureEnabled(): Promise<boolean> {
    try {
        return (await readPersistentJson<unknown>(ILLUSTRATION_FEATURE_FLAG_KEY)) === true
    } catch {
        return false
    }
}

export async function setIllustrationFeatureEnabled(enabled: boolean): Promise<boolean> {
    await writePersistentJson(ILLUSTRATION_FEATURE_FLAG_KEY, enabled === true)
    return enabled === true
}

export async function requireIllustrationFeatureEnabled(): Promise<void> {
    if (!(await isIllustrationFeatureEnabled())) throw new IllustrationFeatureDisabledError()
}
