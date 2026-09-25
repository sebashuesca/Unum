import { useEffect, useState } from 'react'
import { Code2, FolderPlus, Play, RefreshCw, Smartphone, Wrench } from 'lucide-react'
import { ipc } from '../services/ipc'

type Device = { serial: string; state: string; detail: string }

export function MobileToolchain({ onProjectCreated, onError }: { onProjectCreated: () => void; onError: (message: string) => void }) {
  const [devices, setDevices] = useState<Device[]>([])
  const [runtimes, setRuntimes] = useState<Record<string, boolean>>({})
  const [template, setTemplate] = useState<'java' | 'kotlin' | 'android'>('android')
  const [projectName, setProjectName] = useState('MyApp')
  const [packageName, setPackageName] = useState('dev.unum.app')
  const [project, setProject] = useState('.')
  const [tool, setTool] = useState<'gradle' | 'maven'>('gradle')
  const [task, setTask] = useState('build')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const off = ipc.onEvent((event) => {
      if (event.event === 'android.devices') setDevices((event.devices as Device[]) || [])
      if (event.event === 'build.exit') setBusy(false)
    })
    const begin = () => {
      void ipc.request<{ runtimes: Record<string, boolean> }>('RUNTIME_STATUS').then((result) => setRuntimes(result.runtimes)).catch(() => {})
      void ipc.request('ORCHESTRATE_SDK', { operation: 'monitor' }).catch(() => {})
    }
    const offStatus = ipc.onStatus((connected) => { if (connected) begin() })
    if (ipc.connected) begin()
    return () => { off(); offStatus() }
  }, [])

  async function createProject() {
    try {
      const result = await ipc.request<{ path: string }>('CREATE_PROJECT', { template, name: projectName, package: packageName })
      setProject(result.path); setMessage(`Created ${result.path}`); onProjectCreated()
    } catch (failure) { onError((failure as Error).message) }
  }
  async function runBuild() {
    setBusy(true)
    try { await ipc.request('ORCHESTRATE_SDK', { operation: 'build', tool, project, args: [task] }) }
    catch (failure) { setBusy(false); onError((failure as Error).message) }
  }
  async function refreshDevices() {
    try { setDevices((await ipc.request<{ devices: Device[] }>('ORCHESTRATE_SDK', { operation: 'devices' })).devices) }
    catch (failure) { onError((failure as Error).message) }
  }

  return <div className="tool-page mobile-page"><div className="page-heading"><div><span className="eyebrow">MOBILE & JAVA TOOLCHAIN</span><h2>Build projects locally.</h2><p>Use SDK executables contained inside this workspace.</p></div><Smartphone size={32} /></div>{message && <div className="workbench-message">{message}</div>}
    <div className="tool-card"><div className="card-heading"><span><FolderPlus size={16} /> NEW PROJECT</span></div><div className="template-grid">{([['java', 'Java Standard', 'Maven · Java 21'], ['kotlin', 'Kotlin CLI', 'Gradle · JVM 21'], ['android', 'Android Native', 'Gradle · API 34']] as const).map(([id, title, description]) => <button key={id} className={template === id ? 'active' : ''} onClick={() => setTemplate(id)}><Code2 size={20} /><strong>{title}</strong><small>{description}</small></button>)}</div><div className="template-fields"><label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><label>Package<input value={packageName} onChange={(event) => setPackageName(event.target.value)} /></label><button className="primary-button" onClick={() => void createProject()}><FolderPlus size={14} /> Generate project</button></div></div>
    <div className="mobile-grid"><div className="tool-card"><div className="card-heading"><span><Smartphone size={16} /> ADB DEVICES</span><button className="subtle-button" onClick={() => void refreshDevices()}><RefreshCw size={13} /> Refresh</button></div>{devices.length ? devices.map((device) => <div className="device-card" key={device.serial}><span className="device-dot" /><strong>{device.serial}</strong><span>{device.state}</span><small>{device.detail}</small></div>) : <div className="card-empty">No device connected. Local ADB: .unum/runtimes/android/platform-tools/adb</div>}</div><div className="tool-card"><div className="card-heading"><span><Wrench size={16} /> SDK STATUS</span></div><div className="runtime-list">{['java', 'android', 'gradle', 'maven', 'node', 'cpp'].map((name) => <div key={name}><span className={runtimes[name] ? 'runtime-ready' : 'runtime-missing'} />{name.toUpperCase()}<small>{runtimes[name] ? 'Available locally' : 'Not provisioned'}</small></div>)}</div></div></div>
    <div className="tool-card"><div className="card-heading"><span><Play size={16} /> BUILD RUNNER</span></div><div className="build-row"><select value={tool} onChange={(event) => setTool(event.target.value as 'gradle' | 'maven')}><option value="gradle">Gradle</option><option value="maven">Maven</option></select><input value={project} onChange={(event) => setProject(event.target.value)} placeholder="Project directory" /><select value={task} onChange={(event) => setTask(event.target.value)}><option value="build">build</option><option value="assembleDebug">assembleDebug</option><option value="clean">clean</option><option value="test">test</option></select><button className="primary-button" disabled={busy} onClick={() => void runBuild()}><Play size={13} /> {busy ? 'Running…' : 'Run task'}</button></div><p className="card-note">Build output streams to the bottom dock. Gradle and Maven must be placed under .unum/runtimes.</p></div>
  </div>
}
