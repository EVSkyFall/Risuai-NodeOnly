// Prefix-preserving HTML swap for streaming chat bodies.
//
// A naive {@html} rewrite replaces the container's entire subtree on every
// streamed chunk, which destroys and recreates every child element — visible
// flicker, and every <img> re-fetches even with immutable cache headers
// because the element itself is new. During streaming only the tail of the
// message grows, so we keep the longest run of leading children that are
// still identical and replace only from the first difference onward.
//
// The prefix is computed by comparing the previous CANONICAL fragment against
// the new one — never against the live DOM. Post-render passes (checkImg src
// fixes, inlay placeholder resolution) mutate the live children, so a live
// comparison would see every processed node as "changed" and tear down the
// exact elements this action exists to preserve.
//
// Parse semantics are untouched: callers still hand us the full HTML string
// produced by the normal pipeline; only the DOM application is incremental.
export function morphHtml(node: HTMLElement, html: string) {
    let lastHtml: string | null = null
    let lastCanonical: DocumentFragment | null = null

    const apply = (h: string) => {
        if (h === lastHtml) return
        lastHtml = h

        const tpl = document.createElement('template')
        tpl.innerHTML = h
        const fresh = tpl.content
        // Keep an untouched copy for the next diff — the nodes in `fresh`
        // are about to be moved into the live DOM (and then post-processed).
        const canonical = fresh.cloneNode(true) as DocumentFragment

        let i = 0
        // The canonical prefix index is only meaningful if the live children
        // still align positionally with the previous canonical fragment.
        // Post-render passes may REMOVE top-level children (e.g. the inlay
        // resolver drops placeholders under hideAllImages), which shifts every
        // later position — a count-clamp would then keep the WRONG nodes and
        // duplicate siblings. Attribute/subtree mutations keep the count, so
        // count equality is the alignment test; on divergence, full replace.
        if (lastCanonical && node.childNodes.length === lastCanonical.childNodes.length) {
            const prev = lastCanonical.childNodes
            const next = fresh.childNodes
            while (
                i < prev.length &&
                i < next.length &&
                prev[i].isEqualNode(next[i])
            ) {
                i++
            }
        }

        while (node.childNodes.length > i) {
            node.removeChild(node.lastChild)
        }

        if (fresh.childNodes.length > i) {
            const frag = document.createDocumentFragment()
            // appendChild moves the node out of `fresh`, so index i always
            // points at the next remaining new node.
            while (fresh.childNodes.length > i) {
                frag.appendChild(fresh.childNodes[i])
            }
            node.appendChild(frag)
        }

        lastCanonical = canonical
    }

    apply(html)
    return { update: apply }
}
