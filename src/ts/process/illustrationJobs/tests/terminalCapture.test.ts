import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chat, Message } from '../../../storage/database.svelte'

const harness = vi.hoisted(() => ({
    featureEnabled: vi.fn(),
    captureAdmitted: vi.fn(),
    registerTrustedTurn: vi.fn(),
}))

vi.mock('../featureFlag', () => ({
    isIllustrationFeatureEnabled: harness.featureEnabled,
}))

vi.mock('../capturePolicy', () => ({
    isAutomaticCaptureAdmitted: harness.captureAdmitted,
}))

vi.mock('../coordinator', () => ({
    registerTrustedTurn: harness.registerTrustedTurn,
}))

type TerminalCaptureModule = typeof import('../terminalCapture')

let finalizeIllustrationRootTurn: TerminalCaptureModule['finalizeIllustrationRootTurn']

beforeEach(async () => {
    vi.resetModules()
    harness.featureEnabled.mockReset()
    harness.captureAdmitted.mockReset()
    harness.registerTrustedTurn.mockReset()
    harness.featureEnabled.mockResolvedValue(true)
    harness.captureAdmitted.mockResolvedValue(true)
    harness.registerTrustedTurn.mockResolvedValue({})
    ;({ finalizeIllustrationRootTurn } = await import('../terminalCapture'))
})

function normalContext(overrides: {
    rootTurnId?: string
    chatId?: string
    messageId?: string
    text?: string
} = {}) {
    const message = {
        role: 'char',
        data: overrides.text ?? 'The final assistant variant.',
        chatId: overrides.messageId,
    } as Message
    const chat = {
        id: overrides.chatId,
        message: [message],
        note: '',
        name: 'chat',
        localLore: [],
        fmIndex: -1,
    } as Chat
    return {
        chat,
        message,
        context: {
            outcome: 'normal' as const,
            chaId: 'character-1',
            chat,
            message,
            rootTurnId: overrides.rootTurnId ?? 'root-turn-1',
        },
    }
}

describe('terminal illustration capture', () => {
    test('ignores recursive, aborted, and failed exits', async () => {
        for (const outcome of ['continuing', 'aborted', 'failed'] as const) {
            expect(finalizeIllustrationRootTurn({ outcome, rootTurnId: `root-${outcome}` }))
                .toBeUndefined()
        }
        await Promise.resolve()

        expect(harness.featureEnabled).not.toHaveBeenCalled()
        expect(harness.registerTrustedTurn).not.toHaveBeenCalled()
    })

    test('dispatches once while registration hangs, snapshots text, and stays done after success', async () => {
        let resolveRegistration!: (value: unknown) => void
        harness.registerTrustedTurn.mockImplementation(() => new Promise((resolve) => {
            resolveRegistration = resolve
        }))
        const { context, message } = normalContext({
            chatId: 'conversation-1',
            messageId: 'message-1',
            text: 'Original final text.',
        })

        expect(finalizeIllustrationRootTurn({ outcome: 'continuing', rootTurnId: context.rootTurnId }))
            .toBeUndefined()
        expect(finalizeIllustrationRootTurn(context)).toBeUndefined()
        expect(finalizeIllustrationRootTurn(context)).toBeUndefined()
        message.data = 'Changed after the terminal boundary.'

        await vi.waitFor(() => expect(harness.registerTrustedTurn).toHaveBeenCalledTimes(1))
        expect(harness.registerTrustedTurn).toHaveBeenCalledWith({
            chaId: 'character-1',
            conversationId: 'conversation-1',
            expectedMessageId: 'message-1',
            rootTurnId: 'root-turn-1',
            sourceVariantText: 'Original final text.',
            origin: 'automatic',
            enforceCaptureMode: true,
        })

        finalizeIllustrationRootTurn(context)
        expect(harness.registerTrustedTurn).toHaveBeenCalledTimes(1)
        resolveRegistration({})
        await vi.waitFor(() => expect(harness.registerTrustedTurn).toHaveBeenCalledTimes(1))

        finalizeIllustrationRootTurn(context)
        await Promise.resolve()
        expect(harness.registerTrustedTurn).toHaveBeenCalledTimes(1)
    })

    test('manual capture mode suppresses the automatic path with no ID mint or registration', async () => {
        harness.captureAdmitted.mockResolvedValue(false)
        const { context, chat, message } = normalContext()

        finalizeIllustrationRootTurn(context)
        await vi.waitFor(() => expect(harness.captureAdmitted).toHaveBeenCalledTimes(1))
        await Promise.resolve()

        expect(harness.registerTrustedTurn).not.toHaveBeenCalled()
        expect(chat.id).toBeUndefined()
        expect(message.chatId).toBeUndefined()
    })

    test('does not consult the capture policy once the feature is off', async () => {
        harness.featureEnabled.mockResolvedValue(false)
        const { context } = normalContext()

        finalizeIllustrationRootTurn(context)
        await vi.waitFor(() => expect(harness.featureEnabled).toHaveBeenCalledTimes(1))
        await Promise.resolve()

        expect(harness.captureAdmitted).not.toHaveBeenCalled()
        expect(harness.registerTrustedTurn).not.toHaveBeenCalled()
    })

    test('feature OFF has no registration or ID-minting side effects', async () => {
        harness.featureEnabled.mockResolvedValue(false)
        const { context, chat, message } = normalContext()

        finalizeIllustrationRootTurn(context)
        await vi.waitFor(() => expect(harness.featureEnabled).toHaveBeenCalledTimes(1))

        expect(harness.registerTrustedTurn).not.toHaveBeenCalled()
        expect(chat.id).toBeUndefined()
        expect(message.chatId).toBeUndefined()
    })

    test('does not reserve a root turn while an OFF check is pending', async () => {
        let resolveDisabled!: (enabled: boolean) => void
        harness.featureEnabled
            .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                resolveDisabled = resolve
            }))
            .mockResolvedValueOnce(true)
        const { context } = normalContext()

        finalizeIllustrationRootTurn(context)
        finalizeIllustrationRootTurn(context)

        await vi.waitFor(() => expect(harness.featureEnabled).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(harness.registerTrustedTurn).toHaveBeenCalledTimes(1))
        resolveDisabled(false)
    })

    test('mints stable IDs only after the feature is confirmed ON', async () => {
        const { context, chat, message } = normalContext()

        finalizeIllustrationRootTurn(context)
        await vi.waitFor(() => expect(harness.registerTrustedTurn).toHaveBeenCalledTimes(1))

        expect(chat.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(message.chatId).toMatch(/^[0-9a-f-]{36}$/)
        expect(harness.registerTrustedTurn).toHaveBeenCalledWith(expect.objectContaining({
            conversationId: chat.id,
            expectedMessageId: message.chatId,
        }))
    })

    test('contains registration errors, redacts details, and permits an idempotent retry', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
        harness.registerTrustedTurn
            .mockRejectedValueOnce(new Error('secret provider-shaped detail'))
            .mockResolvedValueOnce({})
        const { context } = normalContext({
            chatId: 'conversation-1',
            messageId: 'message-1',
        })

        expect(finalizeIllustrationRootTurn(context)).toBeUndefined()
        await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
            '[illustration] terminal capture failed',
        ))
        expect(warning.mock.calls.flat().join(' ')).not.toContain('secret')

        finalizeIllustrationRootTurn(context)
        await vi.waitFor(() => expect(harness.registerTrustedTurn).toHaveBeenCalledTimes(2))
        finalizeIllustrationRootTurn(context)
        await Promise.resolve()
        expect(harness.registerTrustedTurn).toHaveBeenCalledTimes(2)

        warning.mockRestore()
    })
})
