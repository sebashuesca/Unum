import { useEffect, useRef, useState } from 'react'
import { Code2, FolderPlus, Play, RefreshCw, Smartphone, Wrench } from 'lucide-react'
import { ipc } from '../services/ipc'

type Device = { serial: string; state: string; detail: string }

export function MobileToolchain({ onProjectCreated, onError }: { onProjectCreated: () => void; onError: (message: string) => void }) {
  const [devices, setDevices] = useState<Device[]>([])
  const [runtimes, setRuntimes] = useState<Record<string, boolean>>({})
  const [paths, setPaths] = useState({ android_home: '', java_home: '' })
  const [avds, setAvds] = useState<string[]>([])
  const [avd, setAvd] = useState('')
  const [preview, setPreview] = useState('')
  const [variant, setVariant] = useState<'debug' | 'release'>('debug')
  const [artifacts, setArtifacts] = useState<string[]>([])
  const canvas = useRef<HTMLCanvasElement>(null)
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
      if (event.event === 'build.exit') {
        setBusy(false)
        const found = (event.artifacts as string[] | undefined) || []
        if (found.length) { setArtifacts(found); setMessage(`APK generated: ${found[0]}`) }
        else if (Number(event.code) !== 0) setMessage(`Build failed: ${((event.suggestions as string[]) || []).join('; ')}`)
      }
    })
    const begin = () => {
      void ipc.request<{ runtimes: Record<string, boolean>; android_home: string; java_home: string }>('ORCHESTRATE_SDK', { operation: 'status' }).then((result) => {
        setRuntimes(result.runtimes); setPaths({ android_home: result.android_home, java_home: result.java_home })
        if (result.runtimes.emulator) void ipc.request<{ avds: string[] }>('ORCHESTRATE_SDK', { operation: 'avds' }).then((found) => { setAvds(found.avds); setAvd(found.avds[0] || '') }).catch(() => {})
      }).catch(() => {})
      void ipc.request('ORCHESTRATE_SDK', { operation: 'monitor' }).catch(() => {})
    }
    const offStatus = ipc.onStatus((connected) => { if (connected) begin() })
    if (ipc.connected) begin()
    return () => { off(); offStatus() }
  }, [])

  useEffect(() => {
    if (!preview) return
    let active = true
    const capture = async () => {
      try {
        const result = await ipc.request<{ png: string }>('ORCHESTRATE_SDK', { operation: 'screen', serial: preview })
        if (!active) return
        const frame = new Image()
        frame.onload = () => {
          if (!active || !canvas.current) return
          canvas.current.width = frame.width; canvas.current.height = frame.height
          canvas.current.getContext('2d')?.drawImage(frame, 0, 0)
        }
        frame.src = `data:image/png;base64,${result.png}`
      } catch { if (active) setPreview('') }
    }
    void capture()
    const timer = window.setInterval(() => void capture(), 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [preview])

  async function createProject() {
    try {
      const result = await ipc.request<{ path: string }>('CREATE_PROJECT', { template, name: projectName, package: packageName })
      setProject(result.path); setMessage(`Created ${result.path}`); onProjectCreated()
    } catch (failure) { onError((failure as Error).message) }
  }
  async function runBuild(apk = false) {
    setBusy(true); setArtifacts([])
    try { await ipc.request('ORCHESTRATE_SDK', { operation: 'build', tool: apk ? 'apk' : tool, project, args: apk ? [variant] : [task] }) }
    catch (failure) { setBusy(false); onError((failure as Error).message) }
  }
  async function refreshDevices() {
    try { setDevices((await ipc.request<{ devices: Device[] }>('ORCHESTRATE_SDK', { operation: 'devices' })).devices) }
    catch (failure) { onError((failure as Error).message) }
  }
  async function startEmulator() {
    try { await ipc.request('ORCHESTRATE_SDK', { operation: 'emulator', avd }); setMessage(`Starting ${avd}; waiting for ADB.`) }
    catch (failure) { onError((failure as Error).message) }
  }
  async function tap(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!canvas.current) return
    const rect = canvas.current.getBoundingClientRect()
    const x = Math.round((event.clientX - rect.left) * canvas.current.width / rect.width)
    const y = Math.round((event.clientY - rect.top) * canvas.current.height / rect.height)
    try { await ipc.request('ORCHESTRATE_SDK', { operation: 'tap', serial: preview, x, y }) }
    catch (failure) { onError((failure as Error).message) }
  }

  return <div className="tool-page mobile-page"><div className="page-heading"><div><span className="eyebrow">ANDROID SDK STUDIO</span><h2>Build projects locally.</h2><p>Use SDK executables contained inside this workspace.</p></div><Smartphone size={32} /></div>{message && <div className="workbench-message">{message}</div>}
    <div className="tool-card"><div className="card-heading"><span><FolderPlus size={16} /> NEW PROJECT</span></div><div className="template-grid">{([['java', 'Java Standard', 'Maven · Java 21'], ['kotlin', 'Kotlin CLI', 'Gradle · JVM 21'], ['android', 'Android Native', 'Gradle · API 34']] as const).map(([id, title, description]) => <button key={id} className={template === id ? 'active' : ''} onClick={() => setTemplate(id)}><Code2 size={20} /><strong>{title}</strong><small>{description}</small></button>)}</div><div className="template-fields"><label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><label>Package<input value={packageName} onChange={(event) => setPackageName(event.target.value)} /></label><button className="primary-button" onClick={() => void createProject()}><FolderPlus size={14} /> Generate project</button></div></div>
    <div className="mobile-grid"><div className="tool-card"><div className="card-heading"><span><Smartphone size={16} /> ADB DEVICES</span><button className="subtle-button" onClick={() => void refreshDevices()}><RefreshCw size={13} /> Refresh</button></div>{devices.length ? devices.map((device) => <div className="device-card" key={device.serial}><span className="device-dot" /><strong>{device.serial}</strong><span>{device.state}</span><small>{device.detail}</small><button onClick={() => setPreview(device.serial)}>View</button></div>) : <div className="card-empty">No device connected. Local ADB: .unum/runtimes/android/platform-tools/adb</div>}</div><div className="tool-card"><div className="card-heading"><span><Wrench size={16} /> SDK STATUS</span></div><div className="runtime-list">{['java', 'android', 'emulator', 'gradle', 'maven', 'node', 'cpp'].map((name) => <div key={name}><span className={runtimes[name] ? 'runtime-ready' : 'runtime-missing'} />{name.toUpperCase()}<small>{runtimes[name] ? 'Available locally' : 'Not provisioned'}</small></div>)}</div><p className="card-note">JAVA_HOME: {paths.java_home}<br />ANDROID_HOME: {paths.android_home}</p></div></div>
    <div className="tool-card"><div className="card-heading"><span><Smartphone size={16} /> LOCAL EMULATOR</span></div><div className="build-row"><select value={avd} onChange={(event) => setAvd(event.target.value)}>{avds.length ? avds.map((name) => <option key={name}>{name}</option>) : <option value="">No local AVD</option>}</select><button className="primary-button" disabled={!avd || devices.some((device) => device.state === 'device')} onClick={() => void startEmulator()}><Play size={13} /> Launch emulator</button></div>{preview && <div className="emulator-preview"><button onClick={() => setPreview('')}>Close preview</button><canvas ref={canvas} onClick={(event) => void tap(event)} aria-label={`Screen of ${preview}`} /></div>}</div>
    <div className="tool-card"><div className="card-heading"><span><Play size={16} /> BUILD RUNNER</span></div><div className="build-row"><select value={tool} onChange={(event) => setTool(event.target.value as 'gradle' | 'maven')}><option value="gradle">Gradle</option><option value="maven">Maven</option></select><input value={project} onChange={(event) => setProject(event.target.value)} placeholder="Project directory" /><select value={task} onChange={(event) => setTask(event.target.value)}><option value="build">build</option><option value="assembleDebug">assembleDebug</option><option value="clean">clean</option><option value="test">test</option></select><button className="primary-button" disabled={busy} onClick={() => void runBuild()}><Play size={13} /> {busy ? 'Running…' : 'Run task'}</button></div><div className="build-row"><select value={variant} onChange={(event) => setVariant(event.target.value as 'debug' | 'release')}><option value="debug">Debug APK</option><option value="release">Release APK</option></select><button className="primary-button" disabled={busy} onClick={() => void runBuild(true)}>Build APK</button></div>{artifacts.map((path) => <div className="apk-artifact" key={path}><code>{path}</code><button onClick={() => void window.unum?.revealArtifact(path)}>Open APK location</button><button onClick={() => void window.unum?.exportArtifact(path)}>Export APK</button></div>)}<p className="card-note">Build output streams to the bottom dock.</p></div>
  </div>
}
