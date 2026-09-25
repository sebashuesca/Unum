# Unum IDE

Monorepo local: Electron + React/TypeScript/Tailwind en `app-frontend/` y FastAPI + asyncio en `core-backend/`. El proceso principal de Electron inicia el backend en `127.0.0.1:8000` y entrega a la interfaz un token IPC de sesión.

## Iniciar

```bash
cd app-frontend
npm ci
npm run dev
```

La primera ejecución crea `core-backend/.venv` e instala allí las dependencias Python. `npm ci` instala las dependencias JS en `app-frontend/node_modules`. No se requiere `sudo`. Para desarrollo en navegador, ejecuta `bash core-backend/start.sh` desde la raíz y `npm run dev:web` desde `app-frontend`.

El modal inicial guarda las preferencias en `unum_workspace.json`. Los datos SQLite y los documentos locales se guardan en `.unum/`. El vault de API keys se cifra con una frase de paso y se guarda en `.unum/ai_keys.enc`; la frase de paso no se escribe en disco.

## Toolchains aislados

Los SDKs y ejecutables externos se invocan por ruta absoluta desde `.unum/runtimes/`:

```text
.unum/runtimes/
  java/bin/java
  android/platform-tools/adb
  android/platforms/android-34/...
  gradle/bin/gradle
  maven/bin/mvn
  node/bin/node
  cpp/bin/clang++
  lsp/<servidor LSP>
```

Coloca allí las distribuciones oficiales extraídas. La selección del wizard registra las preferencias; no descarga Java, Android SDK ni Gradle. Los procesos hijos usan `JAVA_HOME`, `ANDROID_HOME`, `GRADLE_USER_HOME`, repositorio Maven y cachés dentro de `.unum/`. Python de proyectos se ejecuta en `.unum/venvs/workspace`. Los servidores LSP se configuran desde la barra de Monaco y se ejecutan desde `.unum/runtimes/lsp`.

El instalador gráfico de IA descarga Ollama para Linux x86_64/aarch64 dentro de `core-backend/runtimes/ai/`, sin instalarlo globalmente. Los modelos se descargan bajo ese mismo directorio. Algunos modelos del catálogo requieren cientos de GB; revisa el tamaño mostrado antes de descargarlos. Se requiere conexión a Internet para instalar el motor, descargar modelos o usar proveedores cloud.
El asistente local puede listar el repositorio, buscar texto y leer archivos de código mediante herramientas de solo lectura; se excluyen directorios ocultos, caches y runtimes. La respuesta se transmite por WebSocket.

## Bases de datos

SQLite está integrado y soporta SQL, diseñador visual de tablas, FK e índices, diagrama ER, edición paginada e importación CSV/XLSX. El botón **Connect** abre conexiones de sesión a PostgreSQL, MySQL, MongoDB, Cassandra o Redis existentes. Las credenciales de conexión se mantienen en memoria y se eliminan al cerrar WebSocket. PostgreSQL y MySQL admiten también diseñador visual, exploración paginada, edición de celdas por clave primaria e importación CSV/XLSX por lotes con progreso WebSocket. Las tablas sin clave primaria se muestran en modo de solo lectura. El workbench ejecuta SQL/CQL en PostgreSQL, MySQL y Cassandra; MongoDB usa operaciones JSON (`find`, `insert`, `update`, `delete`) y Redis usa `scan`, `inspect`, `get`, `set` y `delete`. `inspect` muestra una vista limitada de strings, hashes, listas, conjuntos, sorted sets y streams. El diagrama ER y el explorador de objetos SQL usan introspección del backend.

Unum no instala ni arranca automáticamente servidores externos de PostgreSQL, MySQL, MongoDB, Cassandra o Redis. La conexión a esos motores requiere una instancia existente; el motor SQLite no necesita servidor. Los flujos PostgreSQL/MySQL se verificaron con un motor SQL aislado que ejercita el contrato y la generación de DDL; no se probaron contra servidores reales en este workspace.

## IPC

WebSocket: `ws://127.0.0.1:8000/ws`.

Solicitud: `{ "action": "QUERY_DATABASE", "msg_id": "1", "payload": { "sql": "SELECT 1" } }`.

Respuesta: `{ "msg_id": "1", "ok": true, "payload": { ... } }`. Los procesos largos emiten eventos asociados con `msg_id` (salida de terminal y builds, chunks de IA, progreso de descarga). Electron añade un token IPC de sesión al conectar.

Acciones principales: `SETUP_WORKSPACE`, `EXECUTE_TERMINAL`, `QUERY_DATABASE`, `GENERATE_ER_DIAGRAM`, `IMPORT_EXCEL_CSV`, `ORCHESTRATE_SDK`, `AI_SAVE_KEYS`, `AI_INSTALL_LOCAL_ENGINE`, `AI_PULL_MODEL`, `STREAM_AI_RESPONSE`, `DATABASE_CONNECT`, `DATABASE_DOCUMENT`, `RUN_FILE` y `CREATE_PROJECT`.

## Verificar

```bash
core-backend/.venv/bin/python -m unittest discover -s core-backend/tests -v
cd app-frontend && npm run lint && npm run build
```
