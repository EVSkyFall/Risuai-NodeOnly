import { get } from 'svelte/store'
import { generationStates } from './ts/process/generationState'

export function preLoadCheck(){
    window.addEventListener('beforeunload', (e) => {
        const hasLiveGeneration = Array.from(get(generationStates).values())
            .some((entry) => entry.kind === 'live')
        if(!hasLiveGeneration) return
        e.preventDefault()
        //legacy browser
        e.returnValue = true
    })

    return true;
}
