export type UnumTheme = { primary: string; accent: string; panel: string; editor: string; terminal: string }
export const defaultTheme: UnumTheme = { primary: '#46caa9', accent: '#35dfbe', panel: '#0f1724', editor: '#0f1724', terminal: '#0c111b' }
const key = 'unum:theme'

export function loadTheme(): UnumTheme {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}') as Partial<UnumTheme>
    return { ...defaultTheme, ...Object.fromEntries(Object.entries(saved).filter((entry) => /^#[0-9a-fA-F]{6}$/.test(String(entry[1])))) }
  } catch { return defaultTheme }
}

export function applyTheme(theme: UnumTheme) {
  const root = document.documentElement
  for (const [name, value] of Object.entries(theme)) root.style.setProperty(`--unum-${name}`, value)
  const channels = [1, 3, 5].map((offset) => parseInt(theme.panel.slice(offset, offset + 2), 16) / 255)
  const luminance = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  const lightPanel = luminance[0] * 0.2126 + luminance[1] * 0.7152 + luminance[2] * 0.0722 > 0.35
  root.style.setProperty('--unum-brand-ink', lightPanel ? '#142434' : '#e7f1f8')
  root.style.setProperty('--unum-brand-muted', lightPanel ? '#4b6071' : '#8799ac')
  localStorage.setItem(key, JSON.stringify(theme))
  window.dispatchEvent(new CustomEvent('unum-theme-change', { detail: theme }))
}
