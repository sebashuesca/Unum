import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Code2, Database, FileCode2, Folder, GitBranch, HardDrive, LayoutPanelLeft, Maximize2, Minus, Play, Plus, RefreshCw, Save, Settings2, Smartphone, X } from 'lucide-react'
import { AIHub } from './components/AIHub'
import { CodeEditor, type OpenFile } from './components/CodeEditor'
import { DatabaseWorkbench } from './components/DatabaseWorkbench'
import { MobileToolchain } from './components/MobileToolchain'
import { TerminalPanel } from './components/TerminalPanel'
import { WorkspaceWizard } from './components/WorkspaceWizard'
import { ipc, type EventPacket } from './services/ipc'
import type { DatabaseObjects, FileEntry, WorkspaceConfiguration } from './types'
import './App.css'
import './styles/advanced.css'

type Section = 'explorer' | 'database' | 'mobile' | 'ai'
type DockTab = 'terminal' | 'output' | 'db'

function FileTree({ entries, onOpen, depth = 0 }: { entries: FileEntry[]; onOpen: (path: string) => void; depth?: number }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  return <>{entries.map((entry) => <div key={entry.path}><button className="tree-item" style={{ paddingLeft: 13 + depth * 14 }} onClick={() => entry.type === 'directory' ? setClosed({ ...closed, [entry.path]: !closed[entry.path] }) : onOpen(entry.path)}>{entry.type === 'directory' ? <>{closed[entry.path] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<Folder size={15} className="folder-icon" /></> : <><span className="tree-spacer" /><FileCode2 size={14} className="file-icon" /></>}<span>{entry.name}</span></button>{entry.type === 'directory' && !closed[entry.path] && <FileTree entries={entry.children} onOpen={onOpen} depth={depth + 1} />}</div>)}</>
}

const menus: Record<string, { label: string; action: string }[]> = {
  Unum: [{ label: 'Workspace setup', action: 'setup' }, { label: 'AI Hub', action: 'ai' }],
  Archivo: [{ label: 'New file', action: 'new-file' }, { label: 'New project', action: 'new-project' }, { label: 'Save · Ctrl+S', action: 'save' }],
  Editar: [{ label: 'Open editor', action: 'explorer' }, { label: 'Save changes', action: 'save' }],
  Selección: [{ label: 'File explorer', action: 'explorer' }],
  Ver: [{ label: 'Database Explorer', action: 'database' }, { label: 'Mobile Toolchain', action: 'mobile' }, { label: 'AI Hub', action: 'ai' }],
  Ejecutar: [{ label: 'Run active file', action: 'run' }],
  Terminal: [{ label: 'Open terminal', action: 'terminal' }, { label: 'Show output', action: 'output' }],
  Ayuda: [{ label: 'Open README', action: 'readme' }],
  'Base de Datos': [{ label: 'Open workbench', action: 'database' }, { label: 'DB console', action: 'db-console' }],
  Servidor: [{ label: 'AI engine control', action: 'ai' }],
  Herramientas: [{ label: 'Workspace setup', action: 'setup' }, { label: 'SDK status', action: 'mobile' }],
  Compilar: [{ label: 'Build runner', action: 'mobile' }],
  Conectar: [{ label: 'Cloud providers', action: 'ai' }],
}

function App() {
  const [connected, setConnected] = useState(false)
  const [configuration, setConfiguration] = useState<WorkspaceConfiguration | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [section, setSection] = useState<Section>('explorer')
  const [menu, setMenu] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [files, setFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState('')
  const [newFile, setNewFile] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [objects, setObjects] = useState<DatabaseObjects>({ tables: [], views: [], procedures: [] })
  const [activeConnectionId, setActiveConnectionId] = useState('local')
  const [activeDatabase, setActiveDatabase] = useState('SQLite local')
  const [activeDatabaseKind, setActiveDatabaseKind] = useState('sqlite')
  const [runtimes, setRuntimes] = useState<Record<string, boolean>>({})
  const [git, setGit] = useState<{ branch: string | null; dirty: boolean }>({ branch: null, dirty: false })
  const [dockTab, setDockTab] = useState<DockTab>('terminal')
  const [dockOpen, setDockOpen] = useState(true)
  const [dockSide, setDockSide] = useState<'bottom' | 'right'>('bottom')
  const [dockSize, setDockSize] = useState(238)
  const [output, setOutput] = useState<string[]>([])
  const [dbConsole, setDbConsole] = useState<string[]>([])
  const [errorCount, setErrorCount] = useState(0)
  const [lastError, setLastError] = useState('')
  const [notice, setNotice] = useState('')
  const [hubKey, setHubKey] = useState(0)
  const [sqlFromFile, setSqlFromFile] = useState('')
  const stderr = useRef('')
  const resizing = useRef(false)

  const report = useCallback((message: string) => { setNotice(message); setLastError(message); setErrorCount((count) => count + 1) }, [])
  const changeDatabase = useCallback((id: string, label: string, kind: string) => { setActiveConnectionId(id); setActiveDatabase(label); setActiveDatabaseKind(kind) }, [])
  const refreshFiles = useCallback(async () => { try { setEntries((await ipc.request<{ entries: FileEntry[] }>('files.tree')).entries) } catch (failure) { report((failure as Error).message) } }, [report])
  const refreshWorkspace = useCallback(async () => {
    try {
      const [workspace, runtime, gitInfo, schema] = await Promise.all([
        ipc.request<{ configuration: WorkspaceConfiguration | null }>('GET_WORKSPACE'),
        ipc.request<{ runtimes: Record<string, boolean> }>('RUNTIME_STATUS'),
        ipc.request<{ branch: string | null; dirty: boolean }>('GIT_STATUS'),
        ipc.request<DatabaseObjects>('db.objects'),
      ])
      setConfiguration(workspace.configuration); setSetupOpen(!workspace.configuration)
      setRuntimes(runtime.runtimes); setGit(gitInfo); setObjects(schema)
      await refreshFiles()
    } catch (failure) { report((failure as Error).message) }
  }, [refreshFiles, report])

  useEffect(() => {
    void ipc.connect()
    const offStatus = ipc.onStatus((status) => { setConnected(status); if (status) void refreshWorkspace(); else { setActiveConnectionId('local'); setActiveDatabase('SQLite local'); setActiveDatabaseKind('sqlite') } })
    const offEvent = ipc.onEvent((event: EventPacket) => {
      if (event.event === 'build.output' || event.event === 'run.output') {
        const data = String(event.data)
        if (event.channel === 'stderr') stderr.current = (stderr.current + data).slice(-12000)
        setOutput((previous) => [...previous.slice(-800), data]); setDockTab('output'); setDockOpen(true)
      }
      if (event.event === 'build.exit' || event.event === 'run.exit') {
        const code = Number(event.code)
        const suggestions = (event.suggestions as string[] | undefined) || []
        setOutput((previous) => [...previous, `\nProcess exited with code ${code}\n`, ...suggestions.map((item) => `${item}\n`)])
        if (code !== 0) { setErrorCount((count) => count + 1); setLastError(stderr.current || suggestions.join('\n')) }
        stderr.current = ''
      }
      if (event.event === 'agent.suggestion') { setOutput((previous) => [...previous, `\nSuggested fix: ${((event.suggestions as string[]) || []).join('; ')}\n`]); setDockTab('output') }
    })
    return () => { offStatus(); offEvent() }
  }, [refreshWorkspace])

  async function openFile(path: string) {
    const existing = files.find((item) => item.path === path)
    if (existing) { setActivePath(path); setSection('explorer'); return }
    try {
      const result = await ipc.request<{ uri: string; content: string }>('files.read', { path })
      setFiles((previous) => [...previous, { path, uri: result.uri, content: result.content, dirty: false }])
      setActivePath(path); setSection('explorer')
    } catch (failure) { report((failure as Error).message) }
  }
  async function createFile() {
    const path = newFilePath.trim()
    if (!path) return
    try {
      await ipc.request('files.create', { path })
      setNewFile(false); setNewFilePath(''); await refreshFiles(); await openFile(path)
    } catch (failure) { report((failure as Error).message) }
  }
  async function saveFile() {
    const file = files.find((item) => item.path === activePath)
    if (!file) return
    try { await ipc.request('files.write', { path: file.path, content: file.content }); setFiles((previous) => previous.map((item) => item.path === file.path ? { ...item, dirty: false } : item)); setNotice(`Saved ${file.path}`) }
    catch (failure) { report((failure as Error).message) }
  }
  async function runActive() {
    const file = files.find((item) => item.path === activePath)
    if (!file) { setDockTab('terminal'); setDockOpen(true); return }
    if (file.path.endsWith('.sql')) { setSqlFromFile(file.content); setSection('database'); return }
    try { if (file.dirty) await saveFile(); setOutput([]); stderr.current = ''; setDockTab('output'); setDockOpen(true); await ipc.request('RUN_FILE', { path: file.path }) }
    catch (failure) { report((failure as Error).message) }
  }
  function sendErrorToAI() { setHubKey((key) => key + 1); setSection('ai') }
  async function saveSetup(next: WorkspaceConfiguration) {
    const result = await ipc.request<{ configuration: WorkspaceConfiguration }>('SETUP_WORKSPACE', next)
    setConfiguration(result.configuration); setSetupOpen(false); await refreshWorkspace()
  }

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFile() }
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  })
  useEffect(() => {
    const move = (event: PointerEvent) => { if (resizing.current) setDockSize(Math.max(160, Math.min(dockSide === 'bottom' ? 500 : 600, dockSide === 'bottom' ? window.innerHeight - event.clientY : window.innerWidth - event.clientX))) }
    const stop = () => { resizing.current = false }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  }, [dockSide])

  async function menuAction(action: string) {
    setMenu('')
    if (action === 'setup') { setSetupOpen(true); return }
    if (action === 'new-file') { setSection('explorer'); setNewFile(true); return }
    if (action === 'new-project') { setSection('mobile'); return }
    if (action === 'save') { await saveFile(); return }
    if (action === 'run') { await runActive(); return }
    if (action === 'terminal' || action === 'output' || action === 'db-console') { setDockTab(action === 'db-console' ? 'db' : action); setDockOpen(true); return }
    if (action === 'readme') { await openFile('README.md'); return }
    if (['explorer', 'database', 'mobile', 'ai'].includes(action)) setSection(action as Section)
  }

  const activeFile = files.find((item) => item.path === activePath)
  const selectedDatabases = configuration?.databases || []
  const selectedSdks = configuration?.sdks || []
  return <div className="app-shell"><div className="titlebar"><div className="titlebrand"><div className="brand-mark">U</div><strong>unum</strong><span className="brand-ide">IDE</span></div><div className="title-center">{activeFile ? activeFile.path : 'Workspace'} <span>— Unum IDE</span></div><div className="window-actions"><button onClick={() => window.unum?.window('minimize')} aria-label="Minimize"><Minus size={15} /></button><button onClick={() => window.unum?.window('maximize')} aria-label="Maximize"><Maximize2 size={12} /></button><button className="close-window" onClick={() => window.unum?.window('close')} aria-label="Close"><X size={16} /></button></div></div>
    <div className="tech-header"><div className="technical-menus">{Object.keys(menus).map((title) => <div className="tech-menu" key={title}><button className={menu === title ? 'active' : ''} onClick={() => setMenu(menu === title ? '' : title)}>{title}</button>{menu === title && <div className="menu-popover">{menus[title].map((item) => <button key={item.label} onClick={() => void menuAction(item.action)}>{item.label}</button>)}</div>}</div>)}</div><button className="header-run" onClick={() => void runActive()}><Play size={13} /> Ejecutar</button></div>
    <div className="workspace"><nav className="activity-bar" aria-label="Main navigation"><div className="activity-top"><button title="Explorer" className={section === 'explorer' ? 'selected' : ''} onClick={() => setSection('explorer')}><Code2 size={20} /></button><button title="Database Explorer" className={section === 'database' ? 'selected' : ''} onClick={() => setSection('database')}><Database size={20} /></button><button title="Mobile & Java" className={section === 'mobile' ? 'selected' : ''} onClick={() => setSection('mobile')}><Smartphone size={20} /></button><button title="AI Hub" className={section === 'ai' ? 'selected' : ''} onClick={() => setSection('ai')}><Bot size={21} /></button></div><div className="activity-bottom"><button title="Workspace setup" onClick={() => setSetupOpen(true)}><Settings2 size={19} /></button></div></nav>
      <aside className="sidebar"><header><span>WORKSPACE</span><div className="sidebar-actions"><button onClick={() => { setSection('explorer'); setNewFile(true) }} title="New file"><Plus size={14} /></button><button onClick={() => void refreshFiles()} title="Refresh"><RefreshCw size={14} /></button></div></header>
        <div className="sidebar-section"><ChevronDown size={13} /><strong>EXPLORER</strong></div>
        {newFile && <input className="new-file-input" autoFocus placeholder="new-file.ts" value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createFile(); if (event.key === 'Escape') setNewFile(false) }} />}
        <div className="tree-scroll"><FileTree entries={entries} onOpen={(path) => void openFile(path)} /></div>
        <div className="sidebar-section"><Database size={13} /><strong>BASES DE DATOS ACTIVAS</strong></div>
        <div className="sidebar-runtime-list">{selectedDatabases.length ? selectedDatabases.map((name) => <button key={name} onClick={() => setSection('database')}><span className={name === activeDatabaseKind ? 'runtime-ready' : 'runtime-missing'} />{name.toUpperCase()}<small>{name === activeDatabaseKind ? 'Connected' : 'Available'}</small></button>) : <small>No database selected</small>}</div>
        <div className="sidebar-section"><HardDrive size={13} /><strong>SDKS ACTIVOS</strong></div>
        <div className="sidebar-runtime-list">{selectedSdks.length ? selectedSdks.map((name) => <button key={name} onClick={() => setSection('mobile')}><span className={runtimes[name === 'java21' ? 'java' : 'android'] ? 'runtime-ready' : 'runtime-missing'} />{name === 'java21' ? 'JAVA 21' : 'ANDROID 34'}<small>{runtimes[name === 'java21' ? 'java' : 'android'] ? 'Ready' : 'Not provisioned'}</small></button>) : <small>No SDK selected</small>}</div>
        <button className="sidebar-ai" onClick={() => setSection('ai')}><Bot size={17} /> OPEN AI HUB <ChevronRight size={14} /></button><div className="sidebar-footer"><HardDrive size={13} /> Local workspace</div>
      </aside>
      <main className={`main-content ${dockSide === 'right' ? 'main-dock-right' : ''}`}><div className="main-upper"><div className="tabs"><div className="tab-strip">{files.map((file) => <button key={file.path} className={`file-tab ${activePath === file.path && section === 'explorer' ? 'active' : ''}`} onClick={() => { setActivePath(file.path); setSection('explorer') }}><FileCode2 size={15} /><span>{file.path.split('/').pop()}</span>{file.dirty && <i className="dirty-dot" />}<X size={13} className="tab-close" onClick={(event) => { event.stopPropagation(); setFiles((previous) => previous.filter((item) => item.path !== file.path)); if (activePath === file.path) setActivePath('') }} /></button>)}</div><button className="save-button" onClick={() => void saveFile()} title="Save file"><Save size={15} /></button></div><div className="breadcrumbs">UNUM WORKSPACE <ChevronRight size={12} /> {section === 'explorer' ? activePath || 'Overview' : section.toUpperCase()}</div><div className="content-area">
        {section === 'explorer' && (activeFile ? <CodeEditor key={activeFile.path} file={activeFile} schema={objects.tables} onChange={(content) => setFiles((previous) => previous.map((file) => file.path === activeFile.path ? { ...file, content, dirty: true } : file))} /> : <div className="welcome"><div className="welcome-logo">U</div><h1>Build in one place.</h1><p>Code, data, Android, and AI in one local workspace.</p><div className="quick-actions"><button onClick={() => setSection('database')}><Database size={18} /><span><strong>Explore data</strong><small>SQL, visual schemas and ER diagrams</small></span><ChevronRight size={16} /></button><button onClick={() => setSection('mobile')}><Smartphone size={18} /><span><strong>Create a project</strong><small>Java, Kotlin and Android templates</small></span><ChevronRight size={16} /></button><button onClick={() => setSection('ai')}><Bot size={18} /><span><strong>Open AI Hub</strong><small>Local models, cloud providers, specialists</small></span><ChevronRight size={16} /></button></div><span className="welcome-hint">Open a file from the explorer to start editing.</span></div>)}
        {section === 'database' && <DatabaseWorkbench key={sqlFromFile} initialSql={sqlFromFile} initialConnectionId={activeConnectionId} onSchemaChange={setObjects} onError={report} onConnectionChange={changeDatabase} onConsole={(line) => setDbConsole((previous) => [...previous.slice(-100), line])} />}
        {section === 'mobile' && <MobileToolchain onProjectCreated={() => void refreshFiles()} onError={report} />}
        {section === 'ai' && <AIHub key={hubKey} initialError={lastError} onError={report} />}
      </div></div><div className={`bottom-panel ${dockOpen ? '' : 'collapsed'}`} style={dockSide === 'bottom' && dockOpen ? { height: dockSize } : dockSide === 'right' && dockOpen ? { width: dockSize } : undefined}>{dockOpen && <div className="dock-resize" onPointerDown={() => { resizing.current = true }} />}<div className="panel-tabs"><button className={dockTab === 'terminal' ? 'active' : ''} onClick={() => { setDockTab('terminal'); setDockOpen(true) }}>TERMINAL</button><button className={dockTab === 'output' ? 'active' : ''} onClick={() => { setDockTab('output'); setDockOpen(true) }}>SALIDA</button><button className={dockTab === 'db' ? 'active' : ''} onClick={() => { setDockTab('db'); setDockOpen(true) }}>CONSOLA DB</button><span /><button title="Move dock" onClick={() => setDockSide(dockSide === 'bottom' ? 'right' : 'bottom')}><LayoutPanelLeft size={14} /></button><button title={dockOpen ? 'Collapse dock' : 'Expand dock'} onClick={() => setDockOpen(!dockOpen)}>{dockOpen ? <Minus size={14} /> : <Plus size={14} />}</button></div>{dockOpen && <div className="panel-body"><TerminalPanel active={dockTab === 'terminal'} /><div className="output-host" style={{ display: dockTab === 'output' ? 'block' : 'none' }}><pre>{output.join('') || 'Build and run output appears here.'}</pre>{lastError && <button className="error-to-ai" onClick={sendErrorToAI}><Bot size={14} /> Send error to AI specialist</button>}</div><pre className="output-host" style={{ display: dockTab === 'db' ? 'block' : 'none' }}>{dbConsole.join('\n\n') || 'Database activity appears here.'}</pre></div>}</div></main></div>
    <div className="statusbar"><div><span className={`status-dot ${connected ? 'online' : ''}`} />{connected ? 'Conectado' : 'Connecting…'}<span className="status-divider" /><button onClick={() => { setDockTab('output'); setDockOpen(true) }}>{errorCount} ERRORES</button><span className="status-divider" /><span><GitBranch size={12} /> {git.branch ? `${git.branch}${git.dirty ? '*' : ''}` : 'Sin Git'}</span></div><div>{notice && <button className="notice" onClick={() => setNotice('')}>{notice} <X size={12} /></button>}<span>UTF-8</span><span>SDK: {selectedSdks.length ? selectedSdks.join(', ') : '—'}</span><span>BD: {activeDatabase}</span></div></div>
    {setupOpen && connected && <WorkspaceWizard initial={configuration} onSave={saveSetup} />}
  </div>
}

export default App
