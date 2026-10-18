import { getDatabase, getCurrentChat } from "src/ts/storage/database.svelte";
import { resolveChatModelBinding, classicModelIdFor } from "src/ts/process/request/modelPresetBinding";

export function getGenerationModelString(name?:string){
    const db = getDatabase()
    // Binding-aware default label: when no explicit model name is passed (the
    // primary generation), name what the main request actually uses — the
    // bound ModelPreset, or the classic model (a slot-pinned one included).
    if(name === undefined){
        const binding = resolveChatModelBinding(getCurrentChat(), 'model')
        if(binding.kind === 'modelPreset') return binding.preset.name
        if(binding.kind === 'classic') name = classicModelIdFor(binding, 'model', db)
    }
    switch (name ?? db.aiModel){
        case 'reverse_proxy':
            return 'custom-' + (db.reverseProxyOobaMode ? 'ooba' : db.customProxyRequestModel)
        case 'openrouter':
            return 'openrouter-' + db.openrouterRequestModel
        case 'vercel':
            return 'vercel-' + db.vercelRequestModel
        case 'openai-dynamic':
            return 'openai-' + db.openAIRequestModel
        case 'google-dynamic':
        case 'google-dynamic-vertex':
            return 'google-' + db.googleRequestModel
        case 'nanogpt': {
            const modelLabel = db.nanogptRequestModelName || db.nanogptRequestModel
            return 'NanoGPT ' + modelLabel + (db.nanogptUseSubscriptionEndpoint ? ' [SUB]' : '')
        }
        default:
            return name ?? db.aiModel
    }
}