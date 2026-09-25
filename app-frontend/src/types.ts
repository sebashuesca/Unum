export type WorkspaceConfiguration = {
  version?: number
  languages: string[]
  databases: string[]
  sdks: string[]
  active_database?: string
}

export type FileEntry = { name: string; path: string; type: 'file' | 'directory'; children: FileEntry[] }

export type SchemaColumn = { name: string; type: string; primary_key: boolean; not_null?: boolean }
export type SchemaTable = {
  name: string
  columns: SchemaColumn[]
  foreign_keys: { column: string; references_table: string; references_column: string }[]
  indexes: { name: string; unique: boolean }[]
}
export type DatabaseObjects = { tables: SchemaTable[]; views: string[]; procedures: string[] }
export type Diagram = { nodes: { id: string; columns: SchemaColumn[] }[]; edges: { from: string; column: string; to: string; target_column: string }[] }
export type DatabaseConnection = { id: string; kind: string; label: string; database: string }

export type AiCatalogItem = { id: string; name: string; model: string; size_gb: number; role: string; source: string }
export type AiRoute = { provider: string; model: string }
export type AiRoutes = Record<'code' | 'sql' | 'debug', AiRoute>
export type AiStatus = { installed: boolean; running: boolean; catalog: AiCatalogItem[]; routes: AiRoutes; providers: string[]; installed_models: string[] }
