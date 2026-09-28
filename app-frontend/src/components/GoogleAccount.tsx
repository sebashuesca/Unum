import { useEffect, useState } from 'react'

type Profile = { name: string; email: string; picture: string }

export function GoogleAccount() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [open, setOpen] = useState(false)
  const [clientId, setClientId] = useState(localStorage.getItem('unum:google-client-id') || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void window.unum?.googleProfile().then(setProfile).catch(() => {}) }, [])
  async function signIn() {
    if (!window.unum) { setError('Google login requires the Electron app'); return }
    setBusy(true); setError('')
    try {
      localStorage.setItem('unum:google-client-id', clientId.trim())
      setProfile(await window.unum.googleLogin(clientId.trim()))
      setOpen(false)
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="account-control"><button title={profile?.email || 'Google account'} onClick={() => setOpen(!open)}>{profile?.picture ? <img src={profile.picture} alt="Google profile" referrerPolicy="no-referrer" /> : <span>G</span>}</button>{open && <div className="account-popover">{profile ? <><strong>{profile.name}</strong><small>{profile.email}</small><button onClick={() => { void window.unum?.googleLogout().then(() => { setProfile(null); setOpen(false) }) }}>Sign out</button></> : <><strong>Google account</strong><small>Create a Google Desktop OAuth client and enter its client ID.</small><input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID.apps.googleusercontent.com" /><button disabled={busy || !clientId.trim()} onClick={() => void signIn()}>{busy ? 'Opening browser…' : 'Sign in with Google'}</button>{error && <small className="account-error">{error}</small>}</>}</div>}</div>
}
