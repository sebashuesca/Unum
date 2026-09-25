import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from '../node_modules/monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from '../node_modules/monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from '../node_modules/monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from '../node_modules/monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from '../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker?worker'

const workerScope = self as unknown as { MonacoEnvironment: { getWorker: (_moduleId: string, label: string) => Worker } }
workerScope.MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === 'json') return new JsonWorker()
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker()
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  },
}

loader.config({ monaco })
