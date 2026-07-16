import {
    createImagePromptMeasurementService,
    createImagePromptTokenizerLoader,
    setImagePromptMeasurementServiceForTests,
} from '../imagePromptMeasurement'
import type { NaiSettingsFingerprintDatabase } from '../settingsFingerprint'

export function installImagePromptMeasurementTestService(
    getDatabase: () => NaiSettingsFingerprintDatabase,
    countTokens: (text: string) => number = (text) => text.length === 0 ? 0 : 1,
): () => void {
    const tokenizerLoader = createImagePromptTokenizerLoader({
        loadModel: async () => new ArrayBuffer(0),
        createTokenizer: async () => ({
            encode: (text) => ({ length: countTokens(text) }),
        }),
    })
    return setImagePromptMeasurementServiceForTests(createImagePromptMeasurementService({
        getDatabase,
        tokenizerLoader,
    }))
}
