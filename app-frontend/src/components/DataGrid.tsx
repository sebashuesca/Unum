import { useEffect, useRef, useState } from 'react'
import { ipc } from '../services/ipc'

export type GridData = { columns: string[]; rows: unknown[][]; total?: number; row_keys?: Record<string, unknown>[]; editable_columns?: string[] }

export function DataGrid({ data, table, connectionId = 'local', onUpdated, onError }: { data: GridData; table?: string; connectionId?: string; onUpdated?: () => void; onError?: (message: string) => void }) {
  const [scroll, setScroll] = useState(0)
  const scroller = useRef<HTMLDivElement | null>(null)
  const frame = useRef<number | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const rowHeight = 34
  const viewport = 310
  const start = Math.min(Math.max(0, Math.floor(scroll / rowHeight) - 4), Math.max(0, data.rows.length - 1))
  const end = Math.min(data.rows.length, start + Math.ceil(viewport / rowHeight) + 8)
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; queueMicrotask(() => setScroll(0)) }, [data])
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])

  function editable(rowIndex: number, columnIndex: number) {
    if (!table) return false
    if (connectionId === 'local') return data.columns[0] === '_rowid_' && columnIndex > 0
    return !!data.row_keys?.[rowIndex] && !!data.editable_columns?.includes(data.columns[columnIndex])
  }

  async function commit(rowIndex: number, columnIndex: number) {
    if (!table || !editable(rowIndex, columnIndex)) return
    if (value === String(data.rows[rowIndex][columnIndex] ?? '')) { setEditing(null); return }
    try {
      await ipc.request('db.update', { connection_id: connectionId, table, rowid: connectionId === 'local' ? data.rows[rowIndex][0] : undefined, key: data.row_keys?.[rowIndex], column: data.columns[columnIndex], value })
      setEditing(null)
      onUpdated?.()
    } catch (failure) { setEditing(null); onError?.((failure as Error).message) }
  }

  return <div className="grid-wrap">
    <div className="grid-head" style={{ gridTemplateColumns: `repeat(${data.columns.length}, minmax(150px, 1fr))` }}>
      {data.columns.map((column) => <span key={column}>{column}</span>)}
    </div>
    <div className="grid-scroll" ref={scroller} style={{ height: viewport }} onScroll={(event) => { const next = event.currentTarget.scrollTop; if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(() => { setScroll(next); frame.current = null }) }}>
      <div style={{ height: data.rows.length * rowHeight, position: 'relative' }}>
        {data.rows.slice(start, end).map((row, index) => {
          const actual = start + index
          return <div className="grid-row" key={actual} style={{ top: actual * rowHeight, gridTemplateColumns: `repeat(${data.columns.length}, minmax(150px, 1fr))` }}>
            {row.map((cell, columnIndex) => {
              const key = `${actual}:${columnIndex}`
              return <span key={columnIndex} title={String(cell ?? '')} onDoubleClick={() => { if (editable(actual, columnIndex)) { setEditing(key); setValue(String(cell ?? '')) } }}>
                {editing === key ? <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} onBlur={() => void commit(actual, columnIndex)} /> : String(cell ?? 'NULL')}
              </span>
            })}
          </div>
        })}
      </div>
    </div>
    <div className="grid-foot">{data.total ?? data.rows.length} rows · showing {data.rows.length}</div>
  </div>
}
