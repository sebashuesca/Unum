import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Database, FileSpreadsheet, GitBranch, Plus, RefreshCw, Table2, Trash2, Play } from 'lucide-react'
import { DataGrid, type GridData } from './DataGrid'
import { ErDiagram } from './ErDiagram'
import { SqlQueryEditor } from './SqlQueryEditor'
import { ipc } from '../services/ipc'
import type { DatabaseConnection, DatabaseObjects, Diagram } from '../types'

type ColumnInput = { name: string; type: string; primary_key: boolean; required: boolean; references_table: string; references_column: string }
type IndexInput = { name: string; columns: string; unique: boolean }
const emptyColumn = (): ColumnInput => ({ name: '', type: 'TEXT', primary_key: false, required: false, references_table: '', references_column: '' })
const initialObjects: DatabaseObjects = { tables: [], views: [], procedures: [] }

function encode(bytes: Uint8Array) {
  const sections: string[] = []
  for (let start = 0; start < bytes.length; start += 0x8000) sections.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)))
  return btoa(sections.join(''))
}

function sqlName(name: string, kind: string) {
  const marker = kind === 'mysql' ? '`' : '"'
  return marker + name.replaceAll(marker, marker + marker) + marker
}

export function DatabaseWorkbench({ initialSql = '', initialConnectionId = 'local', onSchemaChange, onError, onConsole, onConnectionChange }: { initialSql?: string; initialConnectionId?: string; onSchemaChange?: (objects: DatabaseObjects) => void; onError?: (message: string) => void; onConsole?: (line: string) => void; onConnectionChange?: (id: string, label: string, kind: string) => void }) {
  const [objects, setObjects] = useState<DatabaseObjects>(initialObjects)
  const [connections, setConnections] = useState<DatabaseConnection[]>([{ id: 'local', kind: 'sqlite', label: 'SQLite · local', database: 'data.sqlite3' }])
  const [connectionId, setConnectionId] = useState(initialConnectionId)
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectionForm, setConnectionForm] = useState({ kind: 'postgresql', host: '127.0.0.1', port: '5432', database: '', username: '', password: '', label: '' })
  const [documentQuery, setDocumentQuery] = useState('{"operation":"find","collection":"items","filter":{}}')
  const [tab, setTab] = useState<'sql' | 'tables' | 'diagram' | 'import'>('sql')
  const [sql, setSql] = useState(initialSql || 'SELECT name, type FROM sqlite_master ORDER BY name;')
  const [grid, setGrid] = useState<GridData | null>(null)
  const [table, setTable] = useState('')
  const [offset, setOffset] = useState(0)
  const [diagram, setDiagram] = useState<Diagram | null>(null)
  const [newTable, setNewTable] = useState('')
  const [columns, setColumns] = useState<ColumnInput[]>([emptyColumn()])
  const [indexes, setIndexes] = useState<IndexInput[]>([])
  const [importPath, setImportPath] = useState('')
  const [preview, setPreview] = useState<{ table: string; ddl: string; rows: number; sample: string[][] } | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [importProgress, setImportProgress] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const error = useCallback((failure: unknown) => { const detail = (failure as Error).message; setMessage(detail); onError?.(detail) }, [onError])
  const activeConnection = connections.find((item) => item.id === connectionId) || connections[0]
  const remote = connectionId !== 'local'
  const documentStore = ['mongodb', 'redis'].includes(activeConnection.kind)
  const relational = ['sqlite', 'postgresql', 'mysql'].includes(activeConnection.kind)
  const refresh = useCallback(async () => {
    try { const next = await ipc.request<DatabaseObjects>('db.objects', { connection_id: connectionId }); setObjects(next); if (connectionId === 'local') onSchemaChange?.(next) }
    catch (failure) { if ((failure as Error).message === 'Database connection not found') { setConnectionId('local'); onConnectionChange?.('local', 'SQLite local', 'sqlite') } else error(failure) }
  }, [connectionId, error, onConnectionChange, onSchemaChange])
  useEffect(() => { if (ipc.connected) queueMicrotask(() => void refresh()); return ipc.onStatus((connected) => { if (connected) void refresh() }) }, [refresh])
  useEffect(() => ipc.onEvent((event) => { if (event.event === 'IMPORT_PROGRESS') setImportProgress(Number(event.percent || 0)) }), [])
  useEffect(() => {
    const load = () => { void ipc.request<{ connections: DatabaseConnection[] }>('DATABASE_CONNECTIONS').then((result) => { setConnections(result.connections); if (!result.connections.some((item) => item.id === connectionId)) { setConnectionId('local'); onConnectionChange?.('local', 'SQLite local', 'sqlite') } }).catch(error) }
    if (ipc.connected) load()
    return ipc.onStatus((connected) => { if (connected) load() })
  }, [connectionId, error, onConnectionChange])

  async function connectDatabase() {
    try {
      const item = await ipc.request<DatabaseConnection>('DATABASE_CONNECT', { ...connectionForm, port: Number(connectionForm.port) })
      setConnections((current) => [...current, item]); setConnectionId(item.id); setSql('SELECT 1;'); setDocumentQuery(item.kind === 'redis' ? '{"operation":"scan","pattern":"*"}' : '{"operation":"find","collection":"items","filter":{}}'); setGrid(null); setTab('sql'); onConnectionChange?.(item.id, item.label, item.kind); setConnectionForm((current) => ({ ...current, password: '' })); setConnectOpen(false); setMessage(`Connected to ${item.label}`)
    } catch (failure) { error(failure) }
  }
  async function disconnectDatabase() {
    if (!remote) return
    try { await ipc.request('DATABASE_DISCONNECT', { connection_id: connectionId }); setConnections((current) => current.filter((item) => item.id !== connectionId)); setConnectionId('local'); setSql('SELECT name, type FROM sqlite_master ORDER BY name;'); onConnectionChange?.('local', 'SQLite local', 'sqlite'); setGrid(null); setTable('') }
    catch (failure) { error(failure) }
  }
  async function runDocument(query?: Record<string, unknown>) {
    try {
      const operation = query || JSON.parse(documentQuery) as Record<string, unknown>
      const result = await ipc.request<Record<string, unknown>>('DATABASE_DOCUMENT', { ...operation, connection_id: connectionId })
      if (Array.isArray(result.documents)) {
        const documents = result.documents as Record<string, unknown>[]
        const names = [...new Set(documents.flatMap((item) => Object.keys(item)))]
        setGrid({ columns: names, rows: documents.map((item) => names.map((name) => typeof item[name] === 'object' && item[name] !== null ? JSON.stringify(item[name]) : item[name])) })
      } else if (Array.isArray(result.keys)) setGrid({ columns: ['key'], rows: (result.keys as string[]).map((key) => [key]) })
      else if ('type' in result && 'key' in result) setGrid({ columns: ['key', 'type', 'value'], rows: [[result.key, result.type, typeof result.value === 'string' ? result.value : JSON.stringify(result.value)]] })
      else setGrid({ columns: ['result'], rows: [[JSON.stringify(result, null, 2)]] })
      setTable(''); onConsole?.(`${activeConnection.kind} · ${String(operation.operation)}\n${JSON.stringify(result)}`)
    } catch (failure) { error(failure) }
  }

  async function runQuery() {
    try { const result = await ipc.request<GridData>('QUERY_DATABASE', { sql, connection_id: connectionId }); setGrid(result); setTable(''); setTab('sql'); onConsole?.(`Query completed · ${result.rows.length} rows\n${sql}`); if (/^\s*(CREATE|ALTER|DROP|TRUNCATE)/i.test(sql)) await refresh() }
    catch (failure) { error(failure) }
  }
  async function loadTable(name: string, nextOffset = 0) {
    try {
      if (!relational) {
        if (activeConnection.kind === 'mongodb' || activeConnection.kind === 'redis') {
          const operation = activeConnection.kind === 'mongodb' ? { operation: 'find', collection: name, filter: {} } : { operation: 'inspect', key: name }
          setDocumentQuery(JSON.stringify(operation, null, 2))
          await runDocument(operation)
        } else { setSql(`SELECT * FROM ${sqlName(name, activeConnection.kind)} LIMIT 100;`); setGrid(null) }
        setTab('sql'); return
      }
      setGrid(await ipc.request<GridData>('db.page', { connection_id: connectionId, table: name, offset: nextOffset, limit: 100 }))
      setTable(name); setOffset(nextOffset); setTab('sql'); onConsole?.(`Opened ${activeConnection.kind} table ${name} · offset ${nextOffset}`)
    }
    catch (failure) { error(failure) }
  }
  async function refreshDiagram() {
    try { setDiagram(remote ? { nodes: objects.tables.map((item) => ({ id: item.name, columns: item.columns })), edges: objects.tables.flatMap((item) => item.foreign_keys.map((fk) => ({ from: item.name, column: fk.column, to: fk.references_table, target_column: fk.references_column }))) } : await ipc.request<Diagram>('GENERATE_ER_DIAGRAM')) }
    catch (failure) { error(failure) }
  }
  async function createTable() {
    try {
      const cleanColumns = columns.filter((column) => column.name.trim()).map((column) => ({ ...column, references_table: column.references_table || undefined, references_column: column.references_column || undefined }))
      const cleanIndexes = indexes.filter((index) => index.name.trim()).map((index) => ({ name: index.name, columns: index.columns.split(',').map((name) => name.trim()).filter(Boolean), unique: index.unique }))
      await ipc.request('db.create_table', { connection_id: connectionId, name: newTable, columns: cleanColumns, indexes: cleanIndexes })
      setMessage(`Table ${newTable} created`); setNewTable(''); setColumns([emptyColumn()]); setIndexes([])
      await refresh(); if (remote) setDiagram(null); else await refreshDiagram()
    } catch (failure) { error(failure) }
  }
  async function previewPath(path: string, tableName?: string) {
    try { setImportPath(path); setPreview(await ipc.request('IMPORT_EXCEL_CSV', { operation: 'preview', connection_id: connectionId, path, table: tableName })); setTab('import') }
    catch (failure) { error(failure) }
  }
  async function upload(file: File) {
    setBusy(true); setUploadProgress(0); setImportProgress(null); setPreview(null)
    try {
      const started = await ipc.request<{ upload_id: string }>('UPLOAD_FILE', { operation: 'begin', filename: file.name, size: file.size })
      for (let offset = 0; offset < file.size; offset += 256 * 1024) {
        const bytes = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer())
        await ipc.request('UPLOAD_FILE', { operation: 'chunk', upload_id: started.upload_id, data: encode(bytes) })
        setUploadProgress(Math.round((offset + bytes.length) / file.size * 100))
      }
      const result = await ipc.request<{ path: string }>('UPLOAD_FILE', { operation: 'finish', upload_id: started.upload_id })
      await previewPath(result.path, file.name.replace(/\.(csv|xlsx)$/i, ''))
    } catch (failure) { error(failure) }
    finally { setBusy(false) }
  }
  async function importData() {
    setBusy(true); setImportProgress(0)
    try {
      const result = await ipc.request<{ table: string; inserted: number }>('IMPORT_EXCEL_CSV', { operation: 'import', connection_id: connectionId, path: importPath, table: preview?.table })
      setMessage(`${result.inserted} rows imported into ${result.table}`); onConsole?.(`Imported ${result.inserted} rows into ${result.table}`)
      setPreview(null); await refresh(); await loadTable(result.table)
    } catch (failure) { error(failure) }
    finally { setBusy(false) }
  }

  return <div className="db-workbench"><div className="workbench-heading"><div><span className="eyebrow">DATA WORKSPACE</span><h2>Database Explorer</h2><p>Explore schema objects, write queries, and manage connected data.</p></div><button className="ghost-button" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh schema</button></div>
    <div className="connection-toolbar"><select value={connectionId} onChange={(event) => { const next = event.target.value; const selected = connections.find((item) => item.id === next); setConnectionId(next); setGrid(null); setTable(''); setTab('sql'); setSql(next === 'local' ? initialSql || 'SELECT name, type FROM sqlite_master ORDER BY name;' : 'SELECT 1;'); onConnectionChange?.(next, selected?.label || '', selected?.kind || 'sqlite') }}>{connections.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select><button onClick={() => setConnectOpen(!connectOpen)}><Plus size={13} /> Connect</button>{remote && <button onClick={() => void disconnectDatabase()}>Disconnect</button>}</div>
    {connectOpen && <div className="connection-form"><select value={connectionForm.kind} onChange={(event) => setConnectionForm({ ...connectionForm, kind: event.target.value, port: String(({ postgresql: 5432, mysql: 3306, mongodb: 27017, redis: 6379, cassandra: 9042 } as Record<string, number>)[event.target.value]) })}>{['postgresql', 'mysql', 'mongodb', 'cassandra', 'redis'].map((kind) => <option key={kind} value={kind}>{kind.toUpperCase()}</option>)}</select><input placeholder="Host" value={connectionForm.host} onChange={(event) => setConnectionForm({ ...connectionForm, host: event.target.value })} /><input placeholder="Port" type="number" value={connectionForm.port} onChange={(event) => setConnectionForm({ ...connectionForm, port: event.target.value })} /><input placeholder="Database / keyspace / Redis DB" value={connectionForm.database} onChange={(event) => setConnectionForm({ ...connectionForm, database: event.target.value })} /><input placeholder="Username" value={connectionForm.username} onChange={(event) => setConnectionForm({ ...connectionForm, username: event.target.value })} /><input placeholder="Password (session only)" type="password" value={connectionForm.password} onChange={(event) => setConnectionForm({ ...connectionForm, password: event.target.value })} /><button className="primary-button" onClick={() => void connectDatabase()}>Connect</button></div>}
    <div className="workbench-layout"><div className="db-object-tree"><div className="db-tree-title"><Database size={15} /> {activeConnection.kind.toUpperCase()} · {activeConnection.database} <ChevronDown size={13} /></div><div className="db-tree-group"><Table2 size={14} /> {activeConnection.kind === 'mongodb' ? 'COLLECTIONS' : activeConnection.kind === 'redis' ? 'KEYS' : 'TABLES'} <span>{objects.tables.length}</span></div>{objects.tables.map((item) => <div key={item.name}><button className={`db-tree-item ${table === item.name ? 'active' : ''}`} onClick={() => void loadTable(item.name)}><ChevronRight size={12} />{item.name}</button>{relational && <div className="db-tree-sub">{item.columns.length} columns · {item.foreign_keys.length} FKs</div>}</div>)}<div className="db-tree-group"><Table2 size={14} /> VIEWS <span>{objects.views.length}</span></div>{objects.views.map((view) => <button className="db-tree-item" key={view} onClick={() => { setSql(`SELECT * FROM ${sqlName(view, activeConnection.kind)} LIMIT 100;`); setTab('sql') }}>{view}</button>)}<div className="db-tree-group"><GitBranch size={14} /> PROCEDURES <span>{objects.procedures.length}</span></div>{!remote && <small className="db-tree-note">SQLite does not expose stored procedures.</small>}</div>
      <div className="db-workspace-main"><div className="workbench-tabs">{([['sql', documentStore ? 'Document Query' : activeConnection.kind === 'cassandra' ? 'CQL Editor' : 'SQL Editor'], ...(relational ? [['tables', 'Table Designer']] as const : []), ...(!documentStore ? [['diagram', 'ER Diagram']] as const : []), ...(relational ? [['import', 'Import Data']] as const : [])] as const).map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); if (id === 'diagram') void refreshDiagram() }}>{label}</button>)}</div>
        {message && <div className="workbench-message" onClick={() => setMessage('')}>{message} ×</div>}
        {tab === 'sql' && <div className="db-tab"><div className="db-card"><div className="card-heading"><span>{documentStore ? 'DOCUMENT OPERATION · JSON' : 'SQL QUERY'}</span><button className="primary-button" onClick={() => void (documentStore ? runDocument() : runQuery())}><Play size={13} /> Run Query</button></div>{documentStore ? <textarea className="document-query" value={documentQuery} onChange={(event) => setDocumentQuery(event.target.value)} spellCheck={false} /> : <div className="sql-editor"><SqlQueryEditor value={sql} onChange={setSql} schema={objects.tables} /></div>}</div>{grid && <div className="db-card"><div className="card-heading"><span>RESULTS {table && `· ${table}`}</span>{table && <div className="pagination"><button disabled={!offset} onClick={() => void loadTable(table, Math.max(0, offset - 100))}>Previous</button><span>{offset + 1}–{Math.min(offset + grid.rows.length, grid.total || 0)} / {grid.total}</span><button disabled={offset + 100 >= (grid.total || 0)} onClick={() => void loadTable(table, offset + 100)}>Next</button></div>}</div><DataGrid data={grid} table={table || undefined} connectionId={connectionId} onError={(detail) => error(new Error(detail))} onUpdated={() => { if (table) void loadTable(table, offset) }} /></div>}</div>}
        {tab === 'tables' && <div className="db-tab"><div className="db-card"><div className="card-heading"><span>CREATE TABLE</span><button className="primary-button" onClick={() => void createTable()}><Plus size={13} /> Create table</button></div><div className="designer-body"><label>Table name<input value={newTable} onChange={(event) => setNewTable(event.target.value)} placeholder="customers" /></label><div className="designer-label">COLUMNS</div><div className="designer-head"><span>Name</span><span>Type</span><span>PK</span><span>Required</span><span>References table</span><span>Column</span><span /></div>{columns.map((column, index) => <div className="designer-row" key={index}><input value={column.name} onChange={(event) => setColumns(columns.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} placeholder="id" /><select value={column.type} onChange={(event) => setColumns(columns.map((item, i) => i === index ? { ...item, type: event.target.value } : item))}>{['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME'].map((type) => <option key={type}>{type}</option>)}</select><input type="checkbox" checked={column.primary_key} onChange={(event) => setColumns(columns.map((item, i) => i === index ? { ...item, primary_key: event.target.checked } : item))} /><input type="checkbox" checked={column.required} onChange={(event) => setColumns(columns.map((item, i) => i === index ? { ...item, required: event.target.checked } : item))} /><select value={column.references_table} onChange={(event) => setColumns(columns.map((item, i) => i === index ? { ...item, references_table: event.target.value } : item))}><option value="">—</option>{objects.tables.map((item) => <option key={item.name}>{item.name}</option>)}</select><input value={column.references_column} onChange={(event) => setColumns(columns.map((item, i) => i === index ? { ...item, references_column: event.target.value } : item))} placeholder="id" /><button onClick={() => setColumns(columns.filter((_, i) => i !== index))}><Trash2 size={14} /></button></div>)}<button className="inline-add" onClick={() => setColumns([...columns, emptyColumn()])}><Plus size={13} /> Add column</button><div className="designer-label">INDEXES</div>{indexes.map((index, row) => <div className="index-row" key={row}><input placeholder="index_name" value={index.name} onChange={(event) => setIndexes(indexes.map((item, i) => i === row ? { ...item, name: event.target.value } : item))} /><input placeholder="column_a, column_b" value={index.columns} onChange={(event) => setIndexes(indexes.map((item, i) => i === row ? { ...item, columns: event.target.value } : item))} /><label><input type="checkbox" checked={index.unique} onChange={(event) => setIndexes(indexes.map((item, i) => i === row ? { ...item, unique: event.target.checked } : item))} /> Unique</label><button onClick={() => setIndexes(indexes.filter((_, i) => i !== row))}><Trash2 size={14} /></button></div>)}<button className="inline-add" onClick={() => setIndexes([...indexes, { name: '', columns: '', unique: false }])}><Plus size={13} /> Add index</button></div></div></div>}
        {tab === 'diagram' && <div className="db-tab"><div className="db-card"><div className="card-heading"><span>ENTITY RELATIONSHIP DIAGRAM</span><button className="subtle-button" onClick={() => void refreshDiagram()}><RefreshCw size={13} /> Refresh</button></div>{diagram?.nodes.length ? <ErDiagram key={diagram.nodes.map((node) => node.id).join('|')} diagram={diagram} onSelect={(name) => void loadTable(name)} /> : <div className="card-empty">Create tables to see their relationships.</div>}</div></div>}
        {tab === 'import' && <div className="db-tab"><div className="db-card"><div className="card-heading"><span>IMPORT EXCEL / CSV</span></div>
          <div className="import-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void upload(file) }}><FileSpreadsheet size={28} /><strong>Drop a .csv or .xlsx file here</strong><span>or choose a file from your computer</span><input type="file" accept=".csv,.xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file) }} />{busy && !preview && <progress value={uploadProgress} max={100} />}</div>
          <div className="import-row"><input placeholder="Or enter a workspace-relative path" value={importPath} onChange={(event) => setImportPath(event.target.value)} /><button onClick={() => void previewPath(importPath)}>Preview</button></div>
          {preview && <div className="import-preview"><strong>{preview.table} · {preview.rows} rows</strong><pre>{preview.ddl}</pre><div className="import-sample">{preview.sample.map((row, index) => <span key={index}>{row.join('  ·  ')}</span>)}</div>{importProgress !== null && <div className="import-load-progress"><progress value={importProgress} max={100} /><span>{importProgress}% inserted</span></div>}<button className="primary-button" disabled={busy} onClick={() => void importData()}>Import {preview.rows} rows</button></div>}
        </div></div>}
      </div></div>
  </div>
}
