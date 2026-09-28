import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ipc } from '../services/ipc'
import { loadTheme, type UnumTheme } from '../theme'

export function TerminalPanel({ active }: { active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!host.current || terminal.current) return
    const selected = loadTheme()
    const term = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'JetBrains Mono, ui-monospace, monospace', theme: {
      background: selected.terminal, foreground: '#b8c6d8', cursor: selected.accent, selectionBackground: '#284a62',
    } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    terminal.current = term
    fit.fit()
    const start = () => void ipc.request('terminal.start', { cols: term.cols, rows: term.rows }).catch((e) => term.writeln(`\r\n${e.message}`))
    if (ipc.connected) start()
    const offStatus = ipc.onStatus((connected) => { if (connected) start() })
    const offEvent = ipc.onEvent((event) => { if (event.event === 'terminal.output') term.write(String(event.data)) })
    const input = term.onData((data) => void ipc.request('terminal.input', { data }).catch(() => {}))
    const updateTheme = (event: Event) => {
      const next = (event as CustomEvent<UnumTheme>).detail
      term.options.theme = { ...term.options.theme, background: next.terminal, cursor: next.accent }
    }
    window.addEventListener('unum-theme-change', updateTheme)
    const observer = new ResizeObserver(() => {
      fit.fit()
      if (ipc.connected) void ipc.request('terminal.resize', { cols: term.cols, rows: term.rows }).catch(() => {})
    })
    observer.observe(host.current)
    return () => { window.removeEventListener('unum-theme-change', updateTheme); observer.disconnect(); input.dispose(); offStatus(); offEvent(); term.dispose(); terminal.current = null }
  }, [])

  return <div ref={host} className="terminal-host" style={{ display: active ? 'block' : 'none' }} />
}
