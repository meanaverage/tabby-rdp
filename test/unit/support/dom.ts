// A small stand-in for the page, as far as a desktop's layer (DesktopSession in src/desktop.service.ts) uses it: elements
// made from its HTML template, class selectors (and `tag.class`), focus, and clicks. Events are kept, not dispatched,
// but for click(). Not a test file itself: test:unit runs test/unit/*.ts only.

export class FakeElement {
    readonly tagName: string
    className = ''
    children: FakeElement[] = []
    parent: FakeElement | null = null
    style: Record<string, string> = {}
    textContent = ''
    hidden = false
    value = ''
    disabled = false
    title = ''
    onclick: unknown = null
    private readonly listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

    constructor (tag = 'div') {
        this.tagName = tag.toUpperCase()
    }

    get classList () {
        const names = () => this.className.split(/\s+/).filter(Boolean)
        return {
            add: (...add: string[]) => { this.className = [...new Set([...names(), ...add])].join(' ') },
            remove: (...remove: string[]) => { this.className = names().filter(n => !remove.includes(n)).join(' ') },
            toggle: (name: string, on = !names().includes(name)) => {
                this.className = on ? [...new Set([...names(), name])].join(' ') : names().filter(n => n !== name).join(' ')
                return on
            },
            contains: (name: string) => names().includes(name),
        }
    }

    /** The template's elements, nested as written (no text, no attributes but the class). */
    set innerHTML (html: string) {
        this.children = []
        const open: FakeElement[] = [this]
        for (const m of html.matchAll(/<(\/?)([a-z0-9-]+)([^>]*)>/gi)) {
            if (m[1]) {
                open.pop()
                continue
            }
            const element = new FakeElement(m[2])
            element.className = /class="([^"]*)"/.exec(m[3])?.[1] ?? ''
            open[open.length - 1].appendChild(element)
            if (!/^(input|br|img)$/i.test(m[2])) {
                open.push(element)
            }
        }
    }

    appendChild (child: FakeElement): FakeElement {
        child.parent = this
        this.children.push(child)
        return child
    }

    prepend (child: FakeElement): void {
        child.parent = this
        this.children.unshift(child)
    }

    replaceChildren (...children: FakeElement[]): void {
        this.children = []
        children.forEach(child => this.appendChild(child))
    }

    remove (): void {
        if (this.parent) {
            this.parent.children = this.parent.children.filter(c => c !== this)
            this.parent = null
        }
    }

    * all (): Generator<FakeElement> {
        for (const child of this.children) {
            yield child
            yield * child.all()
        }
    }

    matches (selector: string): boolean {
        const m = /^([a-z0-9-]*)((?:\.[a-z0-9_-]+)*)$/i.exec(selector.trim())
        return !!m && (!m[1] || m[1].toUpperCase() === this.tagName) && m[2].split('.').filter(Boolean).every(c => this.classList.contains(c))
    }

    querySelector (selector: string): FakeElement | null {
        for (const element of this.all()) {
            if (!selector.includes(' ') && element.matches(selector)) {
                return element
            }
        }
        return null
    }

    querySelectorAll (selector: string): FakeElement[] {
        return selector.includes(' ') ? [] : [...this.all()].filter(element => element.matches(selector))
    }

    addEventListener (type: string, listener: (...args: unknown[]) => void): void {
        (this.listeners[type] ??= []).push(listener)
    }

    removeEventListener (): void { }

    contains (node: unknown): boolean {
        return node === this || [...this.all()].includes(node as FakeElement)
    }

    focus (): void {
        (globalThis as any).document.activeElement = this
    }

    click (): void {
        (this.listeners.click ?? []).forEach(listener => listener())
    }

    getBoundingClientRect () {
        return { width: 0, height: 0 }
    }
}

/** Puts the stand-in in place of the page's document (and getComputedStyle); `restore` puts back what was there. */
export function installDocument (): { body: FakeElement, restore: () => void } {
    const g = globalThis as any
    const saved = { document: g.document, getComputedStyle: g.getComputedStyle }
    const body = new FakeElement('body')
    g.document = { activeElement: body, body, visibilityState: 'visible', createElement: (tag: string) => new FakeElement(tag) }
    g.getComputedStyle = () => ({ position: 'relative' })
    return { body, restore: () => Object.assign(g, saved) }
}
