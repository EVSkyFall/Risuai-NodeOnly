import { isIllustrationFeatureEnabled } from './featureFlag'

type RecoveryModule = Pick<typeof import('./recovery'), 'runIllustrationRecovery'>
type ExecutorModule = Pick<typeof import('./executor'), 'startIllustrationExecutor'>

export type IllustrationBootstrapDependencies = {
    isFeatureEnabled(): Promise<boolean>
    loadRecovery(): Promise<RecoveryModule>
    loadExecutor(): Promise<ExecutorModule>
}

const defaultDependencies: IllustrationBootstrapDependencies = {
    isFeatureEnabled: isIllustrationFeatureEnabled,
    loadRecovery: async () => await import('./recovery'),
    loadExecutor: async () => await import('./executor'),
}

export async function bootstrapIllustrationJobs(
    dependencies: IllustrationBootstrapDependencies = defaultDependencies,
): Promise<void> {
    if (!(await dependencies.isFeatureEnabled())) return
    const { runIllustrationRecovery } = await dependencies.loadRecovery()
    await runIllustrationRecovery()
    const { startIllustrationExecutor } = await dependencies.loadExecutor()
    await startIllustrationExecutor()
}
