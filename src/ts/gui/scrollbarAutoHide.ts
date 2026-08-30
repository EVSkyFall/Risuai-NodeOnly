/**
 * Show-while-scrolling scrollbars. The thumb is transparent by default
 * (styles.css) and painted only while the scroller carries `data-scrolling`.
 * One capture-phase listener stamps the scrolling element and clears the
 * stamp shortly after scrolling stops — no per-component wiring.
 */
const HIDE_DELAY_MS = 800
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

export function initScrollbarAutoHide() {
    document.addEventListener('scroll', (event) => {
        const el = event.target instanceof Element ? event.target : document.documentElement
        el.setAttribute('data-scrolling', '')
        const prev = timers.get(el)
        if (prev) clearTimeout(prev)
        timers.set(el, setTimeout(() => {
            el.removeAttribute('data-scrolling')
            timers.delete(el)
        }, HIDE_DELAY_MS))
    }, { capture: true, passive: true })
}
