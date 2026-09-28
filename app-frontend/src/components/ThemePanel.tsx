import { useEffect, useState } from 'react'
import { Paintbrush } from 'lucide-react'
import { applyTheme, defaultTheme, loadTheme, type UnumTheme } from '../theme'

const labels: Record<keyof UnumTheme, string> = { primary: 'Primary', accent: 'Accent', panel: 'Panels', editor: 'Editor', terminal: 'Terminal' }

export function ThemePanel() {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState(loadTheme)
  useEffect(() => { applyTheme(theme) }, [theme])
  return <div className="theme-control"><button onClick={() => setOpen(!open)} title="Personalize theme"><Paintbrush size={14} /> Theme</button>{open && <div className="theme-popover"><strong>Appearance</strong>{(Object.keys(labels) as (keyof UnumTheme)[]).map((name) => <label key={name}>{labels[name]}<input type="color" value={theme[name]} onChange={(event) => setTheme({ ...theme, [name]: event.target.value })} /></label>)}<button onClick={() => setTheme(defaultTheme)}>Reset theme</button></div>}</div>
}
