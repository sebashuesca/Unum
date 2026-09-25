import { useEffect, useRef, useState } from 'react'
import { type OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { ipc } from '../services/ipc'
import { LocalMonacoEditor } from './LocalMonacoEditor'

export type OpenFile = { path: string; uri: string; content: string; dirty: boolean }
export type SchemaTable = { name: string; columns: { name: string; type: string }[] }

function language(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', java: 'java', kt: 'kotlin', kts: 'kotlin', cpp: 'cpp', cc: 'cpp', h: 'cpp', hpp: 'cpp', sql: 'sql', json: 'json' } as Record<string, string>)[extension || ''] || 'plaintext'
}

export function CodeEditor({ file, onChange, schema }: { file: OpenFile; onChange: (content: string) => void; schema: SchemaTable[] }) {
  const lang = language(file.path)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const completionRegistration = useRef<Monaco.IDisposable | null>(null)
  const schemaRegistration = useRef<Monaco.IDisposable | null>(null)
  const schemaRef = useRef(schema)
  const lspActive = useRef(false)
  const completionId = useRef(100)
  const [lspCommand, setLspCommand] = useState(localStorage.getItem(`lsp:${lang}`) || '')
  const [lspStatus, setLspStatus] = useState('')
  const [schemaPath, setSchemaPath] = useState('')
  const [validation, setValidation] = useState('')
  const version = useRef(1)

  useEffect(() => { schemaRef.current = schema }, [schema])
  useEffect(() => () => { completionRegistration.current?.dispose(); schemaRegistration.current?.dispose() }, [])

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    if (lang === 'kotlin' && !monaco.languages.getLanguages().some((item: { id: string }) => item.id === 'kotlin')) {
      monaco.languages.register({ id: 'kotlin', extensions: ['.kt', '.kts'] })
      monaco.languages.setMonarchTokensProvider('kotlin', {
        keywords: ['class', 'fun', 'val', 'var', 'object', 'interface', 'package', 'import', 'if', 'else', 'when', 'return', 'suspend'],
        tokenizer: { root: [
          [/\/\/.*$/, 'comment'], [/"([^"\\]|\\.)*"/, 'string'], [/\b\d+(\.\d+)?\b/, 'number'],
          [/[a-zA-Z_][\w]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        ] },
      })
    }
    monaco.editor.defineTheme('unum-dark', { base: 'vs-dark', inherit: true, rules: [], colors: {
      'editor.background': '#0f1724', 'editor.foreground': '#c9d5e5', 'editorLineNumber.foreground': '#455267',
      'editor.selectionBackground': '#234760', 'editor.lineHighlightBackground': '#141f2e',
    } })
    monaco.editor.setTheme('unum-dark')
    completionRegistration.current?.dispose()
    completionRegistration.current = monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.'],
      provideCompletionItems: async (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
        if (!ipc.connected || !lspActive.current) return { suggestions: [] }
        const id = ++completionId.current
        const items = await new Promise<Array<{ label: string; insertText?: string; detail?: string; kind?: number }>>((resolve) => {
          const timeout = setTimeout(() => { off(); resolve([]) }, 1800)
          const off = ipc.onEvent((event) => {
            const message = event.message as { id?: number; result?: Array<{ label: string }> | { items?: Array<{ label: string }> } } | undefined
            if (event.event !== 'lsp.message' || event.language !== lang || message?.id !== id) return
            clearTimeout(timeout); off()
            resolve(Array.isArray(message.result) ? message.result : message.result?.items || [])
          })
          void ipc.request('lsp.message', { language: lang, message: { jsonrpc: '2.0', id, method: 'textDocument/completion', params: { textDocument: { uri: file.uri }, position: { line: position.lineNumber - 1, character: position.column - 1 } } } }).catch(() => { clearTimeout(timeout); off(); resolve([]) })
        })
        const word = model.getWordUntilPosition(position)
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
        return { suggestions: items.map((item) => ({ label: item.label, insertText: item.insertText || item.label, detail: item.detail, kind: monaco.languages.CompletionItemKind.Text, range })) }
      },
    })
    schemaRegistration.current?.dispose()
    schemaRegistration.current = monaco.languages.registerCompletionItemProvider('sql', {
      provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
        const word = model.getWordUntilPosition(position)
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
        return { suggestions: schemaRef.current.flatMap((table) => [
          { label: table.name, kind: monaco.languages.CompletionItemKind.Class, insertText: table.name, range },
          ...table.columns.map((column) => ({ label: column.name, kind: monaco.languages.CompletionItemKind.Field, insertText: column.name, range })),
        ]) }
      },
    })
  }

  useEffect(() => {
    const off = ipc.onEvent((event) => {
      if (event.event !== 'lsp.message' || event.language !== lang || !monacoRef.current || !editorRef.current) return
      const message = event.message as { method?: string; params?: { diagnostics?: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; message: string; severity?: number }[] } }
      if (message.method !== 'textDocument/publishDiagnostics') return
      const model = editorRef.current.getModel()
      if (!model) return
      monacoRef.current.editor.setModelMarkers(model, 'lsp', (message.params?.diagnostics || []).map((item) => ({
        startLineNumber: item.range.start.line + 1, startColumn: item.range.start.character + 1,
        endLineNumber: item.range.end.line + 1, endColumn: item.range.end.character + 1,
        message: item.message, severity: item.severity === 1 ? 8 : 4,
      })))
    })
    return off
  }, [lang])

  async function startLsp() {
    try {
      const command = lspCommand.trim().split(/\s+/)
      localStorage.setItem(`lsp:${lang}`, lspCommand)
      const session = await ipc.request<{ created: boolean }>('lsp.start', { language: lang, command })
      const rootUri = file.uri
      if (session.created) {
        await ipc.request('lsp.message', { language: lang, message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: { textDocument: { publishDiagnostics: {}, completion: {} } } } } })
        await ipc.request('lsp.message', { language: lang, message: { jsonrpc: '2.0', method: 'initialized', params: {} } })
      }
      await ipc.request('lsp.message', { language: lang, message: { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: rootUri, languageId: lang, version: version.current, text: file.content } } } })
      lspActive.current = true
      setLspStatus('LSP connected')
    } catch (error) { setLspStatus((error as Error).message) }
  }

  async function validate() {
    try {
      const result = await ipc.request<{ content: string }>('files.read', { path: schemaPath })
      const response = await ipc.request<{ errors: { path: string; message: string }[] }>('json.validate', { document: file.content, schema: JSON.parse(result.content) })
      setValidation(response.errors.length ? response.errors.map((e) => `${e.path}: ${e.message}`).join('\n') : 'Valid JSON')
    } catch (error) { setValidation((error as Error).message) }
  }

  return <div className="editor-shell">
    <div className="editor-toolbar">
      <span className="language-pill">{lang.toUpperCase()}</span>
      <span className="toolbar-spacer" />
      {lang === 'json' && <><input className="toolbar-input" placeholder="schema.json path" value={schemaPath} onChange={(e) => setSchemaPath(e.target.value)} /><button onClick={() => void validate()}>Validate schema</button></>}
      {lang !== 'plaintext' && <><input className="toolbar-input" placeholder="Local LSP binary in .unum/runtimes/lsp" value={lspCommand} onChange={(e) => setLspCommand(e.target.value)} /><button onClick={() => void startLsp()}>Connect LSP</button></>}
    </div>
    {(lspStatus || validation) && <div className="editor-message">{validation || lspStatus}</div>}
    <div className="editor-area"><LocalMonacoEditor path={file.path} language={lang} value={file.content} onMount={onMount} onChange={(value) => {
      const text = value || ''
      onChange(text)
      if (lspStatus === 'LSP connected') void ipc.request('lsp.message', { language: lang, message: { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: file.uri, version: ++version.current }, contentChanges: [{ text }] } } }).catch(() => {})
    }} options={{ minimap: { enabled: false }, fontSize: 13, lineHeight: 22, automaticLayout: true, padding: { top: 18 }, scrollBeyondLastLine: false }} /></div>
  </div>
}
