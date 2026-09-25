import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import type { Diagram } from '../types'

type Point = { x: number; y: number }

export function ErDiagram({ diagram, onSelect }: { diagram: Diagram; onSelect?: (table: string) => void }) {
  const initial = useMemo(() => Object.fromEntries(diagram.nodes.map((node, index) => [node.id, { x: 28 + (index % 3) * 280, y: 30 + Math.floor(index / 3) * 220 }])), [diagram])
  const [positions, setPositions] = useState<Record<string, Point>>(initial)
  const drag = useRef<{ id: string; startX: number; startY: number; x: number; y: number } | null>(null)
  const frame = useRef<number | null>(null)
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])
  const height = Math.max(440, Math.ceil(diagram.nodes.length / 3) * 220 + 50)
  const width = Math.max(900, Math.min(3, diagram.nodes.length) * 280 + 40)

  function pointerDown(event: PointerEvent<SVGGElement>, id: string) {
    const position = positions[id]
    drag.current = { id, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelect?.(id)
  }
  function pointerMove(event: PointerEvent<SVGGElement>) {
    const current = drag.current
    if (!current || frame.current !== null) return
    const x = Math.max(0, current.x + event.clientX - current.startX)
    const y = Math.max(0, current.y + event.clientY - current.startY)
    frame.current = requestAnimationFrame(() => { setPositions((previous) => ({ ...previous, [current.id]: { x, y } })); frame.current = null })
  }

  return <div className="er-viewport"><svg className="er-svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="Entity relationship diagram">
    <defs><marker id="er-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="none" stroke="#5baea9" strokeWidth="1.5" /></marker></defs>
    {diagram.edges.map((edge, index) => { const from = positions[edge.from], to = positions[edge.to]; if (!from || !to) return null; return <g key={index}><path d={`M${from.x + 220} ${from.y + 55} C${from.x + 255} ${from.y + 55}, ${to.x - 35} ${to.y + 55}, ${to.x} ${to.y + 55}`} fill="none" stroke="#5baea9" strokeWidth="2" markerEnd="url(#er-arrow)" /><title>{edge.from}.{edge.column} → {edge.to}.{edge.target_column}</title></g> })}
    {diagram.nodes.map((node) => { const position = positions[node.id] || { x: 0, y: 0 }; return <g key={node.id} transform={`translate(${position.x},${position.y})`} className="er-node" onPointerDown={(event) => pointerDown(event, node.id)} onPointerMove={pointerMove} onPointerUp={() => { drag.current = null }}>
      <rect width="220" height={Math.max(70, 42 + node.columns.length * 23)} rx="7" fill="#152638" stroke="#437478" /><path d="M7 0 H213 Q220 0 220 7 V36 H0 V7 Q0 0 7 0" fill="#234e56" /><text x="13" y="23" fill="#def7f0" fontSize="12" fontWeight="700">{node.id}</text>
      {node.columns.map((column, index) => <g key={column.name}><text x="13" y={56 + index * 23} fill={column.primary_key ? '#6ce4be' : '#a9c0cd'} fontSize="11">{column.primary_key ? '◆ ' : '  '}{column.name}</text><text x="206" y={56 + index * 23} textAnchor="end" fill="#69899b" fontSize="9">{column.type}</text></g>)}
    </g> })}
  </svg></div>
}
