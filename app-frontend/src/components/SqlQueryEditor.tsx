import { useEffect, useRef } from 'react'
import { type OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import type { SchemaTable } from './CodeEditor'
import { LocalMonacoEditor } from './LocalMonacoEditor'

export function SqlQueryEditor({ value, onChange, schema }: { value: string; onChange: (value: string) => void; schema: SchemaTable[] }) {
  const schemaRef = useRef(schema)
  const disposable = useRef<Monaco.IDisposable | null>(null)
  useEffect(() => { schemaRef.current = schema }, [schema])
  useEffect(() => () => disposable.current?.dispose(), [])
  const onMount: OnMount = (_editor, monaco) => {
    monaco.editor.setTheme('vs-dark')
    disposable.current?.dispose()
    disposable.current = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
        const word = model.getWordUntilPosition(position)
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
        return { suggestions: schemaRef.current.flatMap((table) => [
          { label: table.name, kind: monaco.languages.CompletionItemKind.Class, insertText: table.name, range },
          ...table.columns.map((column) => ({ label: column.name, kind: monaco.languages.CompletionItemKind.Field, insertText: column.name, detail: `${table.name} · ${column.type}`, range })),
        ]) }
      },
    })
  }
  return <LocalMonacoEditor height="100%" language="sql" value={value} onChange={(text) => onChange(text || '')} onMount={onMount} options={{ minimap: { enabled: false }, fontSize: 12, lineHeight: 21, automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 12 }, lineNumbers: 'off' }} />
}
