// Root scroll guard (v2, keyboard-aware).
//
// This app pins the page to the window: <body> has overflow:hidden and every
// real scroll happens inside an inner container (.default-chat-screen, the
// sidebar, modals…). The document root is therefore never meant to scroll.
//
// But overflow:hidden only blocks *user* scrolling — it does not stop
// programmatic scrolls (scrollIntoView, focus without preventScroll, plugin
// DOM APIs). If anything inflates the root's scrollHeight past the viewport
// (a body-level absolutely-positioned element injected by a plugin, custom
// CSS…), one such programmatic scroll drags the whole page up — the UI is
// shoved off the top with a blank band below, and the user has no way to
// scroll it back (observed on AI-response completion, Chrome/Edge desktop).
//
// History: added in ebf81fbf for exactly that symptom, then removed in
// 37ef6e3b because iOS's on-screen keyboard LEGITIMATELY scrolls the root to
// lift the focused input above the keyboard — the unconditional clamp made
// the input oscillate on every keystroke. This restore keeps the clamp but
// exempts the keyboard case: when the visual viewport is shrunk below the
// layout viewport (on-screen keyboard) or pinch-zoomed, root scrolls are
// left alone. Desktop (visual viewport ≈ layout viewport) always clamps.
// Do NOT remove this wholesale again — fix the discriminator instead.
export function installRootScrollGuard() {
    if (typeof document === 'undefined') return
    // One-time signal: this app has no legitimate root scroll outside the
    // keyboard case, so a clamp means something (plugin DOM, custom CSS,
    // focus climbing) tried to scroll an inflated root.
    let clampLogged = false
    const keyboardOrZoomActive = () => {
        const vv = window.visualViewport
        if (!vv) return false
        return vv.height < window.innerHeight - 50 || vv.scale > 1.01
    }
    document.addEventListener('scroll', (e) => {
        // Root-level scrolls target `document` (documentElement scroller) or,
        // under some styling regimes, the <body> element itself. Anything else
        // is an inner container doing its job — bail on the pointer compare.
        const isRoot = e.target === document
        const isBody = e.target === document.body
        if (!isRoot && !isBody) return
        if (keyboardOrZoomActive()) return
        const el = isRoot ? document.documentElement : document.body
        if (el.scrollTop === 0 && el.scrollLeft === 0) return
        if (!clampLogged) {
            clampLogged = true
            console.warn('[rootScrollGuard] root scroll clamped to 0 — an inflated root was scrolled programmatically (plugin DOM/custom CSS/focus). Keyboard-open scrolls are exempt.')
        }
        el.scrollTop = 0
        el.scrollLeft = 0
    }, { capture: true, passive: true })
}
