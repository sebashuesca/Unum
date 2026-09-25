import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ipc } from '../services/ipc'

export function TerminalPanel({ active }: { active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!host.current || terminal.current) return
    const term = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'JetBrains Mono, ui-monospace, monospace', theme: {
      background: '#0c111b', foreground: '#b8c6d8', cursor: '#48d9bc', selectionBackground: '#284a62',
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
    const observer = new ResizeObserver(() => {
      fit.fit()
      if (ipc.connected) void ipc.request('terminal.resize', { cols: term.cols, rows: term.rows }).catch(() => {})
    })
    observer.observe(host.current)
    return () => { observer.disconnect(); input.dispose(); offStatus(); offEvent(); term.dispose(); terminal.current = null }
  }, [])

  return <div ref={host} className="terminal-host" style={{ display: active ? 'block' : 'none' }} />
}
