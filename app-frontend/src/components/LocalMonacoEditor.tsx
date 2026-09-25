import { useEffect, useState } from 'react'
import Editor, { type EditorProps } from '@monaco-editor/react'

export function LocalMonacoEditor(props: EditorProps) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let mounted = true
    void import('../monaco').then(() => { if (mounted) setReady(true) })
    return () => { mounted = false }
  }, [])
  return ready ? <Editor {...props} /> : <div className="editor-loading">Loading local editor…</div>
}
