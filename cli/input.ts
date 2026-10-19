/**
 * Keyboard and mouse input from a terminal in raw mode.
 *
 * Holding a key is the hard part. Most terminals only send key presses: holding W sends one
 * press, then repeats after about half a second. So a key counts as held while its repeats
 * keep arriving. Terminals that support the kitty keyboard protocol (kitty, WezTerm, Ghostty,
 * foot, Alacritty) are asked to also report releases, which then end a hold right away.
 * Releases only ever shorten a hold: some terminals say they support the protocol but never
 * send them, and a key must not stay down forever.
 *
 * Pasted text is ignored. Some terminals paste on right-click (VS Code on Windows does), and a
 * pasted command would otherwise read as a burst of key presses.
 */

const ESC = '\x1b['
/** How long a first press counts as held, covering the delay before key repeat starts. */
const FIRST_HOLD_MS = 600
/** How long after a repeat a key still counts as held. */
const REPEAT_HOLD_MS = 150

export interface MouseEvent {
  kind: 'down' | 'drag' | 'up' | 'wheel'
  /** 0 left, 1 middle, 2 right. */
  button: number
  /** Cell coordinates, 0-based. */
  x: number
  y: number
  /** For wheel events: -1 up, 1 down. */
  delta: number
}

export interface InputHandlers {
  /** A key went down (not called for repeats). Names: 'w', 'up', 'space', 'escape', 'ctrl+c', ... */
  onKey: (name: string) => void
  onMouse: (event: MouseEvent) => void
  /** The terminal answered a status request (CSI 5n): it has read everything written before it. */
  onStatus?: () => void
  /** Gets every raw sequence the terminal sends, for debugging input. */
  onRaw?: (sequence: string) => void
}

// Kitty protocol key codes for keys that have no character.
const KITTY_KEYS: Record<number, string> = { 9: 'tab', 27: 'escape', 32: 'space', 13: 'enter', 57441: 'shift', 57447: 'shift' }
const ARROWS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left' }
// Escape sequences, mouse reports, or any single character. The leading ? < > cover replies
// from the terminal and SGR mouse reports.
const TOKEN = /\x1b\[[?<>]?[\d;:]*[A-Za-z~]|\x1bO[A-D]|\x1b|[\s\S]/g
// An escape sequence cut off at the end of a chunk; the rest comes with the next one.
const PARTIAL = /\x1b(\[[?<>]?[\d;:]*)?$/
// Bracketed paste: the terminal wraps pasted text in these.
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** Without bracketed paste: this many plain characters arriving at once can only be a paste. */
const PASTE_LENGTH = 4

export function createInput(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, { onKey, onMouse, onStatus, onRaw }: InputHandlers) {
  /** Key name → time (ms) until which it counts as held. */
  const held = new Map<string, number>()
  /** Whether the kitty protocol was turned on, and whether a release has actually arrived. */
  let kitty = false
  let releases = false
  let pending = ''
  let pasting = false

  function press(name: string, repeat: boolean) {
    const now = performance.now()
    const down = (held.get(name) ?? 0) > now
    held.set(name, now + (down ? REPEAT_HOLD_MS : FIRST_HOLD_MS))
    if (!down && !repeat) onKey(name)
  }

  function release(name: string) {
    held.delete(name)
  }

  function token(t: string) {
    onRaw?.(t)
    if (t === PASTE_START) pasting = true
    else if (t === PASTE_END) pasting = false
    if (pasting || t === PASTE_END) return
    // Kitty protocol: CSI code[:alternates] ; modifiers[:event] u, or CSI 1 ; mods:event A-D.
    let m = /^\x1b\[(\d+)(?::[\d:]*)?(?:;(\d+)(?::(\d))?)?([uABCD~])$/.exec(t)
    if (m && (m[4] === 'u' || m[3])) {
      const code = Number(m[1])
      const mods = Number(m[2] ?? 1) - 1
      const event = Number(m[3] ?? 1)
      let name = m[4] === 'u' ? KITTY_KEYS[code] ?? String.fromCodePoint(code).toLowerCase() : ARROWS[m[4]!]!
      if (mods & 4 && name.length === 1) name = `ctrl+${name}`
      if (mods & 1 && name === 'tab') name = 'shift+tab'
      if (event === 3) {
        releases = true
        release(name)
      }
      else press(name, event === 2)
      return
    }
    // Terminal replies. `CSI ? flags u` means the kitty protocol is supported: turn it on.
    if ((m = /^\x1b\[\?\d*u$/.exec(t))) {
      kitty = true
      // 1 disambiguate keys, 2 report releases, 8 report every key as an escape code.
      stdout.write(`${ESC}>11u`)
      return
    }
    if (/^\x1b\[\?[\d;]*c$/.test(t)) return
    if (t === '\x1b[0n') return onStatus?.()
    // SGR mouse: CSI < button ; x ; y M (press or motion) or m (release).
    if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(t))) {
      const b = Number(m[1])
      const x = Number(m[2]) - 1
      const y = Number(m[3]) - 1
      if (b & 64) onMouse({ kind: 'wheel', button: 0, x, y, delta: b & 1 ? 1 : -1 })
      else onMouse({ kind: m[4] === 'm' ? 'up' : b & 32 ? 'drag' : 'down', button: b & 3, x, y, delta: 0 })
      return
    }
    // Legacy keys: arrows, Ctrl+C, a lone escape, plain characters.
    if ((m = /^\x1b[[O]([A-D])$/.exec(t))) return press(ARROWS[m[1]!]!, false)
    if (t === '\x03') return press('ctrl+c', false)
    if (t === '\t') return press('tab', false)
    if (t === '\x1b[Z') return press('shift+tab', false)
    if (t === '\x1b') return press('escape', false)
    if (t === ' ') return press('space', false)
    if (t.length === 1 && t >= ' ') press(t.toLowerCase(), false)
  }

  function onData(chunk: Buffer) {
    const text = pending + chunk.toString('utf8')
    const cut = PARTIAL.exec(text)
    // A lone ESC at the end is the Escape key, not the start of a sequence.
    pending = cut && cut[0] !== '\x1b' ? cut[0] : ''
    const complete = pending ? text.slice(0, -pending.length) : text
    // Typing and key repeat send a character at a time; a run of plain text is a paste from a
    // terminal without bracketed paste.
    if (!complete.includes('\x1b') && complete.length >= PASTE_LENGTH) {
      onRaw?.(`(ignored paste) ${complete}`)
      return
    }
    for (const [t] of complete.matchAll(TOKEN)) token(t)
  }

  function start() {
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    // Mouse: report presses, releases and drags (1002), in the SGR format (1006). Then ask
    // whether the kitty keyboard protocol is supported; the DA1 query (CSI c) after it gets
    // a reply from every terminal, so an unsupported one just answers that.
    // Bracketed paste (2004) marks pasted text, so it can be ignored.
    stdout.write(`${ESC}?1002h${ESC}?1006h${ESC}?2004h${ESC}?u${ESC}c`)
  }

  function stop() {
    if (kitty) stdout.write(`${ESC}<u`)
    stdout.write(`${ESC}?2004l${ESC}?1006l${ESC}?1002l`)
    stdin.off('data', onData)
    stdin.setRawMode(false)
    stdin.pause()
  }

  return {
    start,
    stop,
    /** Whether a key is held down right now. */
    isDown: (name: string) => (held.get(name) ?? 0) > performance.now(),
    /** True once the terminal has actually reported a key release. */
    get releases() {
      return releases
    },
  }
}
