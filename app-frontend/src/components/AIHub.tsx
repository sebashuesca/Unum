import { useCallback, useEffect, useState } from 'react'
import { Bot, Check, ChevronRight, Cloud, Download, HardDrive, KeyRound, Play, RefreshCw, Send, ShieldCheck, Square, Wrench } from 'lucide-react'
import { ipc } from '../services/ipc'
import type { AiRoutes, AiStatus } from '../types'

const providers = [
  ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['deepseek', 'DeepSeek'],
  ['kimi', 'Kimi / Moonshot'], ['groq', 'Groq'], ['mistral', 'Mistral'],
] as const
const roleNames: Record<keyof AiRoutes, string> = { code: 'Code / Refactor', sql: 'SQL / Schemas', debug: 'Error Debugger' }
const emptyStatus: AiStatus = { installed: false, running: false, catalog: [], routes: { code: { provider: 'local', model: '' }, sql: { provider: 'local', model: '' }, debug: { provider: 'local', model: '' } }, providers: [], installed_models: [] }
type ChatMessage = { role: 'user' | 'assistant'; content: string }
type Progress = { kind: string; model?: string; status?: string; percent?: number | null; speed_kbps?: number; done?: boolean }

export function AIHub({ initialError = '', onError }: { initialError?: string; onError: (message: string) => void }) {
  const [status, setStatus] = useState<AiStatus>(emptyStatus)
  const [tab, setTab] = useState<'overview' | 'providers' | 'models' | 'routing'>('overview')
  const [selectedProvider, setSelectedProvider] = useState<string>('openai')
  const [apiKey, setApiKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [routes, setRoutes] = useState<AiRoutes>(emptyStatus.routes)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [chatRole, setChatRole] = useState<keyof AiRoutes>(initialError ? 'debug' : 'code')
  const [draft, setDraft] = useState(initialError ? 'Suggest a fix for this build error.' : '')
  const [messages, setMessages] = useState<ChatMessage[]>([])

  const refresh = useCallback(async () => {
    try { const result = await ipc.request<AiStatus>('AI_STATUS'); setStatus(result); setRoutes(result.routes) }
    catch (failure) { onError((failure as Error).message) }
  }, [onError])
  useEffect(() => {
    if (ipc.connected) queueMicrotask(() => void refresh())
    const off = ipc.onEvent((event) => {
      if (event.event === 'AI_DOWNLOAD_PROGRESS') setProgress(event as unknown as Progress)
      if (event.event === 'AI_JOB_DONE') { setBusy(''); setNotice('Operation completed'); void refresh() }
      if (event.event === 'AI_JOB_ERROR') { setBusy(''); onError(String(event.error)) }
      if (event.event === 'AI_RESPONSE_CHUNK') setMessages((previous) => {
        const next = [...previous]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + String(event.chunk) }
        return next
      })
      if (event.event === 'AI_RESPONSE_DONE') setBusy('')
      if (event.event === 'AI_RESPONSE_ERROR') {
        setBusy(''); onError(String(event.error))
        setMessages((previous) => previous.map((item, index) => index === previous.length - 1 ? { ...item, content: `Error: ${event.error}` } : item))
      }
    })
    return off
  }, [onError, refresh])

  async function saveKey() {
    try {
      const result = await ipc.request<{ providers: string[] }>('AI_SAVE_KEYS', { provider: selectedProvider, api_key: apiKey, passphrase })
      setStatus((previous) => ({ ...previous, providers: result.providers })); setApiKey(''); setNotice(`${selectedProvider} credential encrypted locally`)
    } catch (failure) { onError((failure as Error).message) }
  }
  async function testKey() {
    setBusy('test')
    try { const result = await ipc.request<{ models: string[] }>('AI_TEST_KEY', { provider: selectedProvider, passphrase }); setNotice(`Connected to ${selectedProvider}. ${result.models.length} models sampled.`) }
    catch (failure) { onError((failure as Error).message) }
    finally { setBusy('') }
  }
  async function install() {
    setBusy('engine'); setProgress(null)
    try { await ipc.request('AI_INSTALL_LOCAL_ENGINE') }
    catch (failure) { setBusy(''); onError((failure as Error).message) }
  }
  async function toggleEngine() {
    setBusy('toggle')
    try { await ipc.request(status.running ? 'AI_STOP_ENGINE' : 'AI_START_ENGINE'); await refresh() }
    catch (failure) { onError((failure as Error).message) }
    finally { setBusy('') }
  }
  async function pull(modelId: string) {
    setBusy(modelId); setProgress(null)
    try { await ipc.request('AI_PULL_MODEL', { model_id: modelId }) }
    catch (failure) { setBusy(''); onError((failure as Error).message) }
  }
  async function saveRoutes() {
    try { await ipc.request('AI_SET_ROUTES', { routes }); setNotice('Role assignments saved'); await refresh() }
    catch (failure) { onError((failure as Error).message) }
  }
  async function send() {
    if (!draft.trim() || busy === 'chat') return
    const question = draft.trim()
    setMessages((previous) => [...previous, { role: 'user', content: question }, { role: 'assistant', content: '' }])
    setDraft(''); setBusy('chat')
    try { await ipc.request('STREAM_AI_RESPONSE', { question, role: chatRole, passphrase, stderr: chatRole === 'debug' ? initialError : '' }) }
    catch (failure) { setBusy(''); onError((failure as Error).message) }
  }

  return <div className="ai-hub"><div className="ai-management"><div className="workbench-heading"><div><span className="eyebrow">AI MANAGEMENT CENTER</span><h2>AI Hub</h2><p>Configure providers, run a contained engine, and route specialist models.</p></div><button className="ghost-button" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button></div><div className="workbench-tabs">{([['overview', 'Overview'], ['providers', 'Cloud Providers'], ['models', 'Model Catalog'], ['routing', 'Specialists']] as const).map(([id, title]) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{title}</button>)}</div>{notice && <div className="workbench-message" onClick={() => setNotice('')}>{notice} ×</div>}
    {tab === 'overview' && <div className="ai-tab"><div className="ai-hero"><div className="ai-hero-icon"><Bot size={26} /></div><div><span className="eyebrow">LOCAL FIRST AI</span><h3>One place for every model.</h3><p>Your local runner lives under core-backend/runtimes/ai. Cloud keys are encrypted with your passphrase.</p></div></div><div className="ai-overview-grid"><div className="ai-card"><div className="ai-card-title"><HardDrive size={17} /> Local engine</div><p>Ollama server · 127.0.0.1:11435</p><div className="ai-state"><span className={status.running ? 'runtime-ready' : 'runtime-missing'} />{status.running ? 'Running' : status.installed ? 'Installed · stopped' : 'Not installed'}</div><div className="ai-actions">{!status.installed && <button className="primary-button" disabled={!!busy} onClick={() => void install()}><Download size={14} /> Install local engine</button>}<button className="ghost-button" disabled={!status.installed || !!busy} onClick={() => void toggleEngine()}>{status.running ? <Square size={13} /> : <Play size={13} />}{status.running ? 'Stop' : 'Start'}</button></div>{busy === 'engine' && <div className="ai-progress"><progress value={progress?.kind === 'engine' ? progress.percent || 0 : 0} max={100} /><span>{progress?.percent ?? 0}% · {progress?.speed_kbps ?? 0} KB/s</span></div>}</div><div className="ai-card"><div className="ai-card-title"><Cloud size={17} /> Cloud connections</div><p>Provider credentials encrypted at rest.</p><strong className="ai-stat">{status.providers.length} <small>/ {providers.length} connected</small></strong><button className="inline-link" onClick={() => setTab('providers')}>Manage providers <ChevronRight size={13} /></button></div><div className="ai-card"><div className="ai-card-title"><Wrench size={17} /> Local models</div><p>Models stored inside core-backend/runtimes/ai.</p><strong className="ai-stat">{status.installed_models.length} <small>installed</small></strong><button className="inline-link" onClick={() => setTab('models')}>Explore catalog <ChevronRight size={13} /></button></div></div></div>}
    {tab === 'providers' && <div className="ai-tab"><div className="ai-card"><div className="ai-card-title"><KeyRound size={17} /> Encrypted credentials</div><p>Enter a passphrase of at least 8 characters. It stays in memory for this session; it is never written to disk.</p><label className="ai-field">Vault passphrase<input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Master passphrase" /></label><div className="provider-grid">{providers.map(([id, title]) => <button className={selectedProvider === id ? 'active' : ''} key={id} onClick={() => setSelectedProvider(id)}><Cloud size={16} /><strong>{title}</strong>{status.providers.includes(id) && <Check size={14} />}</button>)}</div><label className="ai-field">{providers.find(([id]) => id === selectedProvider)?.[1]} API key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste API key" /></label><div className="ai-actions"><button className="primary-button" disabled={!apiKey || !passphrase} onClick={() => void saveKey()}><ShieldCheck size={14} /> Save encrypted</button><button className="ghost-button" disabled={!status.providers.includes(selectedProvider) || !passphrase || !!busy} onClick={() => void testKey()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button></div></div></div>}
    {tab === 'models' && <div className="ai-tab"><div className="catalog-intro"><div><h3>Model Store</h3><p>Pull models from the public Ollama Registry into the contained local runtime.</p></div><span>{status.installed_models.length} installed</span></div><div className="model-grid">{status.catalog.map((model) => { const installed = status.installed_models.some((name) => name === model.model || name.startsWith(model.model.split(':')[0] + ':')); const pulling = busy === model.id; return <div className="model-card" key={model.id}><div className="model-card-top"><div className="model-avatar"><Bot size={20} /></div><span>{model.size_gb} GB</span></div><h3>{model.name}</h3><p>{model.role}</p><code>{model.model}</code>{model.id === 'kimi' && <small className="model-warning">Requires approximately 373 GB and specialist hardware.</small>}{pulling && <div className="ai-progress"><progress value={progress?.model === model.id ? progress.percent || 0 : 0} max={100} /><span>{progress?.status || 'Preparing…'} · {progress?.percent ?? 0}% · {progress?.speed_kbps ?? 0} KB/s</span></div>}<button className={installed ? 'ghost-button' : 'primary-button'} disabled={!status.running || !!busy || installed} onClick={() => void pull(model.id)}>{installed ? <Check size={13} /> : <Download size={13} />}{installed ? 'Installed' : 'Pull model'}</button></div> })}</div></div>}
    {tab === 'routing' && <div className="ai-tab"><div className="ai-card"><div className="ai-card-title"><Wrench size={17} /> Specialist router</div><p>Assign one provider and model per task. Cloud models use the encrypted key for their provider.</p>{(Object.keys(roleNames) as (keyof AiRoutes)[]).map((role) => <div className="route-row" key={role}><strong>{roleNames[role]}</strong><select value={routes[role]?.provider || 'local'} onChange={(event) => setRoutes({ ...routes, [role]: { ...routes[role], provider: event.target.value } })}><option value="local">Local Ollama</option>{providers.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select><input value={routes[role]?.model || ''} onChange={(event) => setRoutes({ ...routes, [role]: { ...routes[role], model: event.target.value } })} placeholder="Model identifier" list="local-models" /></div>)}<datalist id="local-models">{status.installed_models.map((model) => <option key={model} value={model} />)}</datalist><button className="primary-button" onClick={() => void saveRoutes()}>Save role assignments</button></div></div>}
  </div><aside className="assistant-panel"><div className="assistant-heading"><div className="agent-avatar"><Bot size={19} /></div><div><strong>Unum Assistant</strong><span>Streaming · specialist routing</span></div></div><div className="assistant-messages">{messages.length ? messages.map((item, index) => <div className={`chat-message ${item.role}`} key={index}><span className="chat-role">{item.role === 'user' ? 'YOU' : 'UNUM'}</span>{item.content || 'Thinking…'}</div>) : <div className="assistant-empty"><Bot size={31} /><strong>How can I help?</strong><span>Ask about code, SQL or build errors.</span></div>}</div><div className="assistant-compose"><select value={chatRole} onChange={(event) => setChatRole(event.target.value as keyof AiRoutes)}><option value="code">Code specialist</option><option value="sql">SQL specialist</option><option value="debug">Error debugger</option></select><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder="Ask Unum Assistant…" /><button className="primary-button" disabled={!draft.trim() || !!busy} onClick={() => void send()}><Send size={14} /> Send</button></div></aside></div>
}
