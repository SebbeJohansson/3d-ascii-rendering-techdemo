/**
 * Keyboard and mouse input from a terminal in raw mode.
 *
 * Holding a key is the hard part. Most terminals only send key presses: holding W sends one
 * press, then repeats after about half a second. Terminals that support the kitty keyboard
 * protocol (kitty, WezTerm, Ghostty, foot, Alacritty, recent iTerm2) also send releases, and
 * are asked to. Elsewhere a key counts as held until its repeats stop arriving.
 */

const ESC = '\x1b['
/** Without release events: how long a first press counts as held, covering the repeat delay. */
const FIRST_HOLD_MS = 600
/** Without release events: how long after a repeat a key still counts as held. */
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
}

// Kitty protocol key codes for keys that have no character.
const KITTY_KEYS: Record<number, string> = { 27: 'escape', 32: 'space', 13: 'enter', 57441: 'shift', 57447: 'shift' }
const ARROWS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left' }
// Escape sequences, mouse reports, or any single character. The leading ? < > cover replies
// from the terminal and SGR mouse reports.
const TOKEN = /\x1b\[[?<>]?[\d;:]*[A-Za-z~]|\x1bO[A-D]|\x1b|[\s\S]/g
// An escape sequence cut off at the end of a chunk; the rest comes with the next one.
const PARTIAL = /\x1b(\[[?<>]?[\d;:]*)?$/

export function createInput(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, { onKey, onMouse }: InputHandlers) {
  /** Key name → time (ms) until which it counts as held. Infinity until released, with releases. */
  const held = new Map<string, number>()
  let releases = false
  let pending = ''

  function press(name: string, repeat: boolean) {
    const now = performance.now()
    const down = (held.get(name) ?? 0) > now
    if (releases) held.set(name, Infinity)
    else held.set(name, now + (down ? REPEAT_HOLD_MS : FIRST_HOLD_MS))
    if (!down && !repeat) onKey(name)
  }

  function release(name: string) {
    held.delete(name)
  }

  function token(t: string) {
    // Kitty protocol: CSI code[:alternates] ; modifiers[:event] u, or CSI 1 ; mods:event A-D.
    let m = /^\x1b\[(\d+)(?::[\d:]*)?(?:;(\d+)(?::(\d))?)?([uABCD~])$/.exec(t)
    if (m && (m[4] === 'u' || m[3])) {
      const code = Number(m[1])
      const mods = Number(m[2] ?? 1) - 1
      const event = Number(m[3] ?? 1)
      let name = m[4] === 'u' ? KITTY_KEYS[code] ?? String.fromCodePoint(code).toLowerCase() : ARROWS[m[4]!]!
      if (mods & 4 && name.length === 1) name = `ctrl+${name}`
      if (event === 3) release(name)
      else press(name, event === 2)
      return
    }
    // Terminal replies. `CSI ? flags u` means the kitty protocol is supported: turn it on.
    if ((m = /^\x1b\[\?\d*u$/.exec(t))) {
      releases = true
      // 1 disambiguate keys, 2 report releases, 8 report every key as an escape code.
      stdout.write(`${ESC}>11u`)
      return
    }
    if (/^\x1b\[\?[\d;]*c$/.test(t)) return
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
    if (t === '\x1b') return press('escape', false)
    if (t === ' ') return press('space', false)
    if (t.length === 1 && t >= ' ') press(t.toLowerCase(), false)
  }

  function onData(chunk: Buffer) {
    const text = pending + chunk.toString('utf8')
    const cut = PARTIAL.exec(text)
    // A lone ESC at the end is the Escape key, not the start of a sequence.
    pending = cut && cut[0] !== '\x1b' ? cut[0] : ''
    for (const [t] of (pending ? text.slice(0, -pending.length) : text).matchAll(TOKEN)) token(t)
  }

  function start() {
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    // Mouse: report presses, releases and drags (1002), in the SGR format (1006). Then ask
    // whether the kitty keyboard protocol is supported; the DA1 query (CSI c) after it gets
    // a reply from every terminal, so an unsupported one just answers that.
    stdout.write(`${ESC}?1002h${ESC}?1006h${ESC}?u${ESC}c`)
  }

  function stop() {
    if (releases) stdout.write(`${ESC}<u`)
    stdout.write(`${ESC}?1006l${ESC}?1002l`)
    stdin.off('data', onData)
    stdin.setRawMode(false)
    stdin.pause()
  }

  return {
    start,
    stop,
    /** Whether a key is held down right now. */
    isDown: (name: string) => (held.get(name) ?? 0) > performance.now(),
    /** True once the terminal turned out to report key releases. */
    get releases() {
      return releases
    },
  }
}
