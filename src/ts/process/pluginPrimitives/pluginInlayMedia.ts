import { getInlayAssetBlob } from '../files/inlays'

export interface PluginInlayMediaReadInput {
    assetId: string
}

export type PluginInlayMediaReadResult =
    | {
        status: 'succeeded'
        result: {
            assetId: string
            data: Blob
            mediaType: 'image' | 'video' | 'audio'
            mimeType: string
            ext: string
            name: string
            width?: number
            height?: number
        }
    }
    | { status: 'definite_failure'; error: string; code: string }

export interface PluginInlayMediaDependencies {
    readInlay(assetId: string): Promise<{
        data: Blob
        ext: string
        name: string
        type: string
        width?: number
        height?: number
    } | null>
}

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    webm: 'video/webm',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
}

export function createPluginInlayMediaApi(deps: PluginInlayMediaDependencies) {
    return {
        async readMedia(input: PluginInlayMediaReadInput): Promise<PluginInlayMediaReadResult> {
            const assetId = typeof input?.assetId === 'string' ? input.assetId : ''
            if (!assetId || /[{}\r\n:]/.test(assetId)) {
                return {
                    status: 'definite_failure',
                    error: 'assetId is missing or malformed',
                    code: 'inlay_asset_id_invalid',
                }
            }

            let asset
            try {
                asset = await deps.readInlay(assetId)
            } catch (error) {
                return {
                    status: 'definite_failure',
                    error: error instanceof Error ? error.message : String(error),
                    code: 'inlay_read_failed',
                }
            }
            if (!asset) {
                return {
                    status: 'definite_failure',
                    error: 'the inlay asset does not exist',
                    code: 'inlay_not_found',
                }
            }
            if (asset.type !== 'image' && asset.type !== 'video' && asset.type !== 'audio') {
                return {
                    status: 'definite_failure',
                    error: `the inlay is ${asset.type}, not image, video, or audio media`,
                    code: 'inlay_media_unsupported',
                }
            }
            if (!(asset.data instanceof Blob) || asset.data.size === 0) {
                return {
                    status: 'definite_failure',
                    error: 'the inlay asset holds no media data',
                    code: 'inlay_data_empty',
                }
            }

            const ext = String(asset.ext ?? '').toLowerCase()
            const mimeType = asset.data.type || MIME_BY_EXT[ext]
            if (!mimeType || !mimeType.startsWith(`${asset.type}/`)) {
                return {
                    status: 'definite_failure',
                    error: 'the inlay media type is not recognized',
                    code: 'inlay_mime_unsupported',
                }
            }
            return {
                status: 'succeeded',
                result: {
                    assetId,
                    data: asset.data,
                    mediaType: asset.type,
                    mimeType,
                    ext,
                    name: String(asset.name ?? ''),
                    ...(Number.isFinite(asset.width) ? { width: Number(asset.width) } : {}),
                    ...(Number.isFinite(asset.height) ? { height: Number(asset.height) } : {}),
                },
            }
        },
    }
}

export function createDefaultPluginInlayMediaApi() {
    return createPluginInlayMediaApi({
        readInlay: async assetId => await getInlayAssetBlob(assetId),
    })
}
