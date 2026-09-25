import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Code2, Database, HardDrive, Smartphone } from 'lucide-react'
import type { WorkspaceConfiguration } from '../types'

const languageOptions = [
  ['java', 'Java', 'JVM'], ['kotlin', 'Kotlin', 'JVM / Android'], ['sql', 'SQL', 'Data'],
  ['javascript', 'JavaScript', 'Web'], ['typescript', 'TypeScript', 'Web'], ['python', 'Python', 'Automation'], ['cpp', 'C++', 'Native'],
]
const databaseOptions = [
  ['postgresql', 'PostgreSQL', 'Relational'], ['mysql', 'MySQL', 'Relational'], ['sqlite', 'SQLite', 'Embedded'],
  ['mongodb', 'MongoDB', 'Documents'], ['cassandra', 'Cassandra', 'Wide column'], ['redis', 'Redis', 'Key-value'],
]
const sdkOptions = [['java21', 'Java SDK v21', 'Local JDK'], ['android34', 'Android SDK API 34', 'ADB + build tools']]

export function WorkspaceWizard({ initial, onSave }: { initial?: WorkspaceConfiguration | null; onSave: (configuration: WorkspaceConfiguration) => Promise<void> }) {
  const [step, setStep] = useState(0)
  const [languages, setLanguages] = useState(initial?.languages || ['typescript', 'python', 'sql'])
  const [databases, setDatabases] = useState(initial?.databases || ['sqlite'])
  const [sdks, setSdks] = useState(initial?.sdks || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const groups = [languages, databases, sdks]
  const setters = [setLanguages, setDatabases, setSdks]
  const options = [languageOptions, databaseOptions, sdkOptions][step]
  const titles = ['Choose your languages', 'Select databases', 'Add SDK toolchains']
  const descriptions = [
    'Pick the languages you will use in this workspace.',
    'Select database engines to display and configure in the workbench.',
    'SDK executables stay inside this workspace. You can add them later.',
  ]

  function toggle(value: string) {
    const group = groups[step]
    setters[step](group.includes(value) ? group.filter((item) => item !== value) : [...group, value])
  }

  async function next() {
    if (step < 2) { setStep(step + 1); return }
    setSaving(true); setError('')
    try { await onSave({ languages, databases, sdks, active_database: databases.includes('sqlite') ? 'sqlite' : databases[0] }) }
    catch (failure) { setError((failure as Error).message) }
    finally { setSaving(false) }
  }

  return <div className="wizard-backdrop"><div className="wizard-modal" role="dialog" aria-modal="true" aria-label="Workspace setup">
    <div className="wizard-aside"><div className="wizard-brand">U</div><h2>Make it yours.</h2><p>Configure your workspace in three quick steps. Everything stays local.</p><div className="wizard-steps">{['Languages', 'Databases', 'SDKs & Toolchains'].map((title, index) => <button className={index === step ? 'current' : index < step ? 'complete' : ''} key={title} onClick={() => setStep(index)}><span>{index < step ? <Check size={14} /> : index + 1}</span>{title}</button>)}</div><small>UNUM IDE · WORKSPACE SETUP</small></div>
    <div className="wizard-content"><div className="wizard-counter">STEP {step + 1} OF 3</div><div className="wizard-icon">{step === 0 ? <Code2 size={24} /> : step === 1 ? <Database size={24} /> : <Smartphone size={24} />}</div><h2>{titles[step]}</h2><p>{descriptions[step]}</p><div className="wizard-options">{options.map(([id, label, detail]) => <button key={id} className={groups[step].includes(id) ? 'chosen' : ''} onClick={() => toggle(id)}><span className="option-icon">{step === 0 ? <Code2 size={18} /> : step === 1 ? <Database size={18} /> : <HardDrive size={18} />}</span><span className="option-text"><strong>{label}</strong><small>{detail}</small></span><span className="option-check">{groups[step].includes(id) && <Check size={13} />}</span></button>)}</div>{error && <div className="wizard-error">{error}</div>}<div className="wizard-navigation"><button className="ghost-button" disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft size={15} /> Back</button><button className="primary-button" disabled={saving || (step < 2 && groups[step].length === 0)} onClick={() => void next()}>{step === 2 ? saving ? 'Saving…' : 'Create workspace' : 'Continue'} <ArrowRight size={15} /></button></div></div>
  </div></div>
}
