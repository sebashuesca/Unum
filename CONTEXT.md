# Contexto técnico de Unum IDE

Estado documentado: 28 de septiembre de 2026. Este archivo describe la implementación presente en el repositorio. `AGENTS.md` en la raíz enlaza a este mismo contenido para las siguientes sesiones de desarrollo.

## 1. VISIÓN GENERAL Y ARQUITECTURA

- **Nombre:** Unum IDE.
- **Ruta base:** `/home/sebas/Escritorio/Unum`.
- **Frontend:** `app-frontend/`; Electron, React, TypeScript, Tailwind CSS, Monaco Editor y xterm.js. La vista principal y el diseño de paneles viven en `app-frontend/src/App.tsx`; los módulos visuales están en `app-frontend/src/components/`.
- **Backend:** `core-backend/`; paquete Python con estructura `src-layout`, cuyo punto de entrada es `core-backend/src/unum_core/main.py`. FastAPI coordina módulos asíncronos de archivos, terminal, datos, SDK, LSP e IA.
- **Protocolo:** WebSocket IPC en `ws://127.0.0.1:8000/ws` durante desarrollo; en la aplicación empaquetada Electron asigna un puerto loopback libre por sesión y lo entrega al renderer junto con el token. Endpoint HTTP `GET /health` para comprobar disponibilidad.

### Inicio y flujo de comunicación

1. En desarrollo, `app-frontend/electron/main.ts` inicia `core-backend/start.sh`; en la distribución instalada ejecuta `resources/backend/unum-backend[.exe]`, generado con PyInstaller. Crea una ventana sin marco y entrega al renderer puerto y token IPC de sesión mediante `electron/preload.cts`. Electron usa aislamiento de contexto, desactiva la integración Node del renderer y bloquea navegación/ventanas externas.
2. Durante desarrollo, `start.sh` crea `core-backend/.venv` si hace falta e instala el paquete Python allí. El paquete distribuido incluye Python y las dependencias del backend en un binario autónomo. FastAPI escucha únicamente en `127.0.0.1`: puerto 8000 en desarrollo y puerto libre asignado por Electron en el paquete.
3. `app-frontend/src/services/ipc.ts` mantiene la conexión WebSocket, correlaciona respuestas por `msg_id`, distribuye eventos y reconecta cuando se cierra el socket.
4. Cada solicitud tiene la forma `{ "action": "...", "msg_id": "...", "payload": {} }`. La respuesta ordinaria es `{ "msg_id": "...", "ok": true, "payload": {} }` o incluye `ok: false` y `error`. Los trabajos largos emiten paquetes con `event` y el mismo `msg_id`.
5. El backend exige `UNUM_IPC_TOKEN` cuando Electron lo proporciona. La terminal, los LSP, las cargas de archivos y las conexiones externas a bases de datos tienen ciclo de vida asociado al WebSocket y se cierran al desconectar.

### Rutas principales

| Responsabilidad | Ruta |
| --- | --- |
| Shell, menú, paneles, barra de estado | `app-frontend/src/App.tsx` |
| Cliente IPC | `app-frontend/src/services/ipc.ts` |
| Wizard, editor, terminal, datos, SDK e IA | `app-frontend/src/components/` |
| Despacho IPC y ciclo de vida FastAPI | `core-backend/src/unum_core/main.py` |
| Entornos y rutas de ejecutables | `core-backend/src/unum_core/env_manager.py` |
| SQLite y conectores externos | `core-backend/src/unum_core/database.py`, `connections.py` |
| Grid y DDL de PostgreSQL/MySQL | `core-backend/src/unum_core/relational.py` |
| IA local, claves y herramientas del agente | `core-backend/src/unum_core/ai_hub.py`, `ai_vault.py`, `agent.py` |

## 2. POLÍTICA RIGUROSA DE AISLAMIENTO

**Regla para todo desarrollo futuro:** no exigir `sudo` ni instalaciones globales de Java/JDK, Android SDK/ADB, Gradle, Maven, PostgreSQL, MySQL u Ollama en Fedora. No resolver estos SDK, motores o ejecutables de IA desde el `$PATH` global. Los subprocesos de SDK se lanzan con ejecutables locales validados mediante `EnvironmentManager`.

| Recurso | Ubicación y comportamiento actual |
| --- | --- |
| Dependencias Python del backend | En desarrollo, `core-backend/.venv/`, creado por `core-backend/start.sh`; en producción, dentro del ejecutable PyInstaller incluido en el instalador. |
| Entornos Python de proyectos | `.unum/venvs/<nombre>/`; el runner usa `.unum/venvs/workspace/`. |
| JDK, Android/ADB, Gradle, Maven, Node, C++ y LSP | `.unum/runtimes/<nombre>/`; se invocan por ruta absoluta. El JDK requiere `bin/java` y `bin/javac` para builds. |
| Motor de IA instalado desde la GUI | `core-backend/runtimes/ai/ollama/`; modelos, registro y datos del proceso permanecen en `core-backend/runtimes/ai/`. |
| Datos SQL integrados | `.unum/data.sqlite3`, mediante SQLAlchemy async y `aiosqlite`. |
| Documentos integrados | `.unum/documents/`, mediante `dbm`; no requiere servidor de base de datos. |
| Cachés y configuración de procesos hijos | Variables como `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_USER_HOME`, `GRADLE_USER_HOME`, repositorio Maven y caché pip apuntan al workspace. El proceso padre y el `$PATH` global no se modifican. |

**Límites reales del aislamiento:** el desarrollo presupone que el SO ya puede ejecutar `bash`, `python3`, Node/npm y Electron. El instalador incluye Electron y el backend Python autónomo; Python y Node/npm solo son necesarios en el equipo de build. El wizard **registra** Java 21 y Android API 34, pero no los descarga: sus distribuciones deben colocarse en `.unum/runtimes/`. Actualmente la instalación gráfica automática cubre **Ollama para Linux x86_64/aarch64**; no existe instalador de `llama.cpp`. Las opciones PostgreSQL, MySQL, MongoDB, Cassandra y Redis son conexiones a instancias existentes; Unum no instala ni inicia esos servidores. Los controladores de conexión se incluyen en el backend empaquetado o se instalan en el `venv` local durante desarrollo.

`unum_workspace.json` contiene preferencias, no credenciales. Las conexiones externas guardan usuario/contraseña solo en memoria durante la sesión WebSocket. Las API keys cloud se cifran con Scrypt y Fernet en `.unum/ai_keys.enc`, con permisos `0600`; la frase de paso no se guarda en disco. `.unum/`, el `venv`, `node_modules`, los builds y `core-backend/runtimes/` están excluidos por `.gitignore`.

En esta actualización se retiraron `.unum/ai_keys.enc` y `.unum/ai_routes.json` del índice de Git sin borrar sus copias locales. Los commits anteriores pueden seguir conteniendo el archivo cifrado; no se reescribió el historial.

## 3. MÓDULOS IMPLEMENTADOS Y ALCANCE ACTUAL

### Onboarding Wizard

`WorkspaceWizard.tsx` presenta tres pasos: (1) Java, Kotlin, SQL, JavaScript, TypeScript, Python y C++; (2) PostgreSQL, MySQL, SQLite, MongoDB, Cassandra y Redis; (3) Java SDK 21 y Android SDK API 34. La acción `SETUP_WORKSPACE` valida y guarda atómicamente `unum_workspace.json` en la raíz; `GET_WORKSPACE` decide si debe mostrarse el modal inicial.

**Configuración encontrada al documentar:** lenguajes `cpp` y `python`; bases `mysql` y `postgresql`; ningún SDK seleccionado; `active_database` configurada como `mysql`. Esta selección no establece por sí sola una conexión MySQL ni instala sus binarios. El workbench inicia en SQLite local hasta que se conecte explícitamente a otro motor.

### IDE Shell, editor y terminal

- `App.tsx` contiene menú técnico superior, botón Ejecutar, explorador de archivos, secciones de BD/SDK activos, acceso al AI Hub, pestañas de archivos, panel inferior acoplable a la derecha o abajo y barra de estado con IPC, errores, Git, codificación, SDK y BD.
- `BrandMark.tsx` dibuja el isotipo oficial como rombo menta de borde abierto y cuadrado interior, tomando como referencia la marca CSS publicada en `unum-dev.vercel.app`. El header muestra `unum.` e `IDE` en una línea; la bienvenida usa solo el emblema a 92 px con resplandor suave. `public/brand.svg` y `public/favicon.svg` contienen el mismo vector; el isotipo y el texto del header siguen las variables del tema.
- Al cambiar a datos o SDK, `App.tsx` oculta las pestañas del editor y colapsa el explorador para ampliar la vista; al volver a código restaura el diseño. `ThemePanel.tsx` cambia colores principales, de paneles, editor Monaco y terminal xterm, y `theme.ts` guarda la selección en `localStorage`.
- `GoogleAccount.tsx` y `electron/main.ts` implementan OAuth de escritorio con navegador externo, callback loopback y PKCE. El perfil aparece en la barra superior; los tokens se cifran mediante `safeStorage` en `userData/google-session.enc` y se renuevan cuando hay refresh token. Requiere un ID de cliente OAuth **Desktop** introducido en la GUI y `safeStorage` disponible; no se incluye un ID de cliente en el repositorio.
- `CodeEditor.tsx` y `LocalMonacoEditor.tsx` cargan Monaco localmente, con resaltado de lenguajes y servidor LSP configurable desde `.unum/runtimes/lsp/`. `lsp_manager.py` conecta stdio mediante tramas `Content-Length`. La validación JSON usa JSON Schema Draft 2020-12 en `json.validate`.
- `TerminalPanel.tsx` usa xterm.js y un PTY de Linux gestionado por `terminal.py`. `EXECUTE_TERMINAL` admite inicio, entrada y redimensionado; la salida viaja por eventos `terminal.output`. También existe diagnóstico básico de errores de Python visibles en la terminal.
- `runner.py` ejecuta archivos Python en un `venv` del workspace y JavaScript, Java o C++ mediante binarios locales. `RUN_FILE` transmite stdout/stderr y emite `run.exit` con sugerencias cuando falla.
- `files.py` limita lecturas/escrituras al workspace, evita seguir enlaces simbólicos en el árbol y omite cachés, binarios y directorios generados.

### Data Workspace / SGBD Workbench

- `DatabaseWorkbench.tsx` ofrece árbol de objetos, editor SQL con autocompletado basado en esquema, diseñador de tablas, diagrama ER, importación drag-and-drop y resultados tabulares. `DataGrid.tsx` renderiza solo las filas visibles de cada página. SQLite pagina en bloques de hasta 500 registros; la UI solicita normalmente 100 por página.
- `database.py` proporciona SQLite local con DML/DDL, introspección de tablas, vistas, columnas, FK e índices; diseñador con PK/FK/índices; edición de celdas por `rowid`; y datos para el diagrama ER. `ErDiagram.tsx` dibuja **SVG interactivo**, no un canvas HTML.
- `connections.py` conecta en sesión a PostgreSQL y MySQL por SQLAlchemy async; MongoDB por PyMongo async; Redis por `redis.asyncio`; Cassandra mediante su controlador ejecutado fuera del bucle principal. El workbench ejecuta SQL/CQL y operaciones JSON para MongoDB (`find`, `insert`, `update`, `delete`) y Redis (`scan`, `inspect`, `get`, `set`, `delete`). La introspección externa alimenta el explorador y el diagrama SQL. Redis expone una muestra limitada de claves mediante `SCAN` y la inspección de valores respeta el tipo de clave y un límite de resultados.
- `relational.py` añade a PostgreSQL y MySQL diseñador visual con PK/FK/índices, lectura paginada, serialización de tipos SQL y edición directa de columnas no PK mediante clave primaria completa. Las tablas sin PK son de solo lectura en el grid. El backend valida y escapa identificadores antes de generar DDL. Los cambios de esquema ejecutados en SQL invalidan las tablas reflejadas en caché.
- `uploads.py` recibe `.csv` y `.xlsx` por fragmentos WebSocket para el drag-and-drop. `migration.py` infiere tipos y nombres, genera DDL por dialecto SQLite/PostgreSQL/MySQL y realiza INSERT por lotes de 1000 filas con pandas; Excel se lee con openpyxl en modo de solo lectura. Durante la inserción, `IMPORT_PROGRESS` informa porcentaje y filas insertadas en la interfaz. El límite actual de archivo es **100 MB**. No se carga toda la tabla importada en el grid.
- `documents.py` añade colecciones JSON locales respaldadas por `dbm`; no equivale a ejecutar MongoDB localmente.

### Java & Android Toolchain

- `projects.py` genera plantillas Java Standard/Maven, Kotlin CLI/Gradle y Android Native/Gradle API 34 en el workspace.
- `android_orchestrator.py` invoca el ADB local, sondea dispositivos aproximadamente cada tres segundos y ejecuta tareas Gradle/Maven en el directorio del proyecto con stdout/stderr en vivo. Requiere JDK local antes de construir. `MobileToolchain.tsx` expone el wizard de proyectos, estado de runtimes, monitor de dispositivos y selector de tareas (`build`, `assembleDebug`, `clean`, `test`).
- Android SDK Studio muestra rutas locales de `ANDROID_HOME`/`JAVA_HOME`, enumera AVD, inicia el emulador local sin ventana y presenta capturas PNG de ADB en un canvas con toques. La captura se actualiza cada 1,5 segundos; no es video a 60 FPS. `Build APK` usa `gradlew` del proyecto o Gradle local para `assembleDebug`/`assembleRelease`, transmite logs y permite abrir la carpeta del APK o exportar una copia desde Electron.
- Los SDK no están incluidos en el repositorio ni se descargan desde esta pantalla. Builds reales requieren distribuciones locales compatibles y, cuando proceda, dependencias del proyecto disponibles para Gradle/Maven.

### AI Hub y Unum Assistant

- `AIHub.tsx` ofrece pantallas GUI de proveedores, motor local, catálogo, asignación de especialistas y chat lateral. `ai_vault.py` guarda claves cifradas de OpenAI, Anthropic, DeepSeek, Kimi/Moonshot, Groq y Mistral; se pueden probar desde la GUI.
- `ai_hub.py` instala y controla un proceso Ollama local en `127.0.0.1:11434`. Si el binario local existe, el backend lo inicia al arrancar y observa `/api/tags`. Descarga un archivo oficial `tar.zst` en `core-backend/runtimes/ai/`, valida rutas de extracción y limita tamaños. El catálogo expone Hermes, Kimi K2, DeepSeek Coder, Qwen 2.5 Coder y CodeLlama; `AI_PULL_MODEL` emite `AI_DOWNLOAD_PROGRESS` con porcentaje y KB/s. **Kimi K2 figura como opción muy grande, de aproximadamente 373 GB.**
- Al terminar una descarga o guardar una API key, se hace una prueba de conversación `ping` con el nombre exacto del modelo. Tras un resultado válido se asignan los cuatro especialistas automáticamente. Las solicitudes de Ollama usan `options.temperature` numérica. Para modelos que responden HTTP 400 por no admitir herramientas nativas, el chat usa un protocolo JSON de respaldo; la precisión de las llamadas depende del modelo.
- El cuarto especialista, `chat_consultant` (Code Consultant / Chat Bot), aparece en `Specialists` y en el selector de Unum Assistant. Su proveedor y modelo se guardan junto a las demás rutas en `.unum/ai_routes.json`; las configuraciones antiguas de tres roles se migran heredando la ruta de `code`. La UI conserva el rol seleccionado en `localStorage`. Su prompt pide análisis de arquitectura, explicación de componentes y asesoría antes de implementar. Solo recibe herramientas de lectura por defecto; edición y comandos requieren activar la casilla de esa solicitud y una petición explícita del usuario. Para proveedores cloud también se requiere la opción de acceso al workspace.
- `STREAM_AI_RESPONSE` transmite chunks al chat y acepta historial reciente. El agente puede consultar Git, buscar y leer fuentes, escribir archivos, sustituir un bloque exacto y ejecutar comandos con runtimes locales permitidos. Limita tamaños y número de llamadas y excluye directorios ocultos, runtimes y cachés. `AI_FILE_CHANGED` actualiza el editor si el archivo abierto no tiene cambios pendientes. Los proveedores cloud pueden usar herramientas del workspace solo cuando el usuario activa la casilla correspondiente en el chat; el contenido solicitado se envía al proveedor.
- La salida `stderr` de runner/build y los errores SQL se pueden enviar desde la UI al especialista de depuración. `agent.py` también proporciona diagnósticos de reglas cuando no hay modelo disponible.
- **Alcance:** el instalador implementado es de Ollama; no hay instalador ni adaptador `llama.cpp` en el estado actual. La suite no usa API keys reales ni una cuenta Google real.

### Contrato IPC de referencia

| Área | Acciones principales | Eventos relevantes |
| --- | --- | --- |
| Workspace y archivos | `GET_WORKSPACE`, `SETUP_WORKSPACE`, `files.tree/read/write/create`, `GIT_STATUS` | Respuesta por `msg_id` |
| Terminal y ejecución | `EXECUTE_TERMINAL`, `terminal.start/input/resize`, `RUN_FILE` | `terminal.output`, `run.output`, `run.exit` |
| Datos | `QUERY_DATABASE`, `DATABASE_CONNECTIONS/CONNECT/DISCONNECT/DOCUMENT`, `db.objects/create_table/page/update`, `GENERATE_ER_DIAGRAM`, `UPLOAD_FILE`, `IMPORT_EXCEL_CSV` | `IMPORT_PROGRESS`, respuesta por `msg_id` |
| SDK | `RUNTIME_STATUS`, `CREATE_PROJECT`, `ORCHESTRATE_SDK` (`status`, `avds`, `emulator`, `screen`, `tap`, `build`) | `android.devices`, `build.output`, `build.exit` con `artifacts` |
| Editor | `lsp.start`, `lsp.message`, `json.validate` | `lsp.message`, `lsp.exit` |
| IA | `AI_STATUS`, `AI_SAVE_KEYS`, `AI_TEST_KEY`, `AI_SET_ROUTES`, `AI_INSTALL_LOCAL_ENGINE`, `AI_START_ENGINE`, `AI_STOP_ENGINE`, `AI_PULL_MODEL`, `STREAM_AI_RESPONSE`, `agent.tool` | `AI_DOWNLOAD_PROGRESS`, `AI_JOB_DONE/ERROR`, `AI_RESPONSE_CHUNK/DONE/ERROR`, `AI_FILE_CHANGED` |

Para detalles de campos y alias de acciones, consultar el despachador de `main.py` y los consumidores de `ipc.ts`.

### Empaquetado Windows y Linux

`core-backend/build_backend.py` genera `unum-backend` en `app-frontend/resources/bin/linux/` o `unum-backend.exe` en `app-frontend/resources/bin/win/`. `app-frontend/scripts/package.mjs` construye el backend y el frontend en el host nativo y configura electron-builder para AppImage/deb o NSIS/portable. Los artefactos salen a `app-frontend/release/`; el binario Python se incluye como recurso externo a `app.asar`. En producción el workspace se guarda en `userData/workspace`; los runtimes opcionales permanecen allí y no se instalan globalmente. Cada instancia empaquetada usa un puerto loopback propio; el backend acepta `Origin: file://` solo con el token de sesión correcto. Windows usa `cmd.exe` con pipes asíncronas para la terminal; Linux conserva el PTY. Consultar `PACKAGING.md` para comandos y límites de distribución.

## 4. ESTADO DE VERIFICACIÓN Y PRUEBAS

- **Backend:** última ejecución registrada: **17/17 pruebas pasadas** con `unittest`. Cubren autenticación del origen `file://` y token IPC, contrato WebSocket/JSON Schema, SQLite/DDL/ER/paginación, diseñador/grid/importación SQL externa, Redis simulado, CSV/XLSX, documentos, configuración y plantillas, vault cifrado, PTY, extracción segura, validación de claves cloud y asignación automática de IA, edición de archivos por modelos locales/cloud, migración de rutas y acceso de solo lectura del consultor, fallback de modelos sin herramientas nativas y AVD/APK con ejecutables locales de prueba.
- **Frontend:** `npm run lint` y `npm run build` pasaron sin errores. El build compila TypeScript, el proceso Electron y el bundle Vite. Vite avisa que algunos chunks de Monaco superan 500 kB; el editor se carga de forma diferida.
- **Empaquetado Linux:** `npm run package:linux` regeneró `Unum IDE-0.1.0.AppImage` y `unum-ide_0.1.0_amd64.deb`. El `.deb` contiene `resources/backend/unum-backend`; el binario copiado coincide con el original por SHA-256. `smoke_packaged.py` reprodujo el 403 del binario anterior y comprobó en el nuevo `/health`, rechazo de token incorrecto, aceptación de `Origin: file://` con token correcto y salida de terminal. El build Windows está configurado, pero requiere ejecutarse y validarse en Windows x64.
- **Verificado en vivo:** arranque del backend y `GET /health`; arranque de Ollama desde el binario local en `11434`; detección de `deepseek-coder:1.3b`; prueba real `ping`; autoasignación de rutas; respuesta real de `STREAM_AI_RESPONSE` por WebSocket. El modelo respondió HTTP 400 a herramientas nativas y el chat respondió mediante la ruta de respaldo.
- **No verificado en vivo:** ventana GUI mediante inspección visual; OAuth con una cuenta real; AVD y SDK Android reales; APK con Gradle real; servidores de BD externos; credenciales cloud; nueva descarga de Ollama o modelos.

Comandos desde la raíz del proyecto:

```bash
core-backend/.venv/bin/python -m unittest discover -s core-backend/tests -v
cd app-frontend && npm run lint && npm run build
```

Inicio de la aplicación, desde la raíz:

```bash
cd app-frontend
npm ci
npm run dev
```

Para desarrollo solo web: iniciar `bash core-backend/start.sh` desde la raíz y luego `npm run dev:web` dentro de `app-frontend/`. La primera instalación de dependencias, el instalador de Ollama y los modelos requieren acceso a red.

Para instaladores: `cd app-frontend && npm run package:linux` en Linux o `npm run package:win` en Windows. Salida en `app-frontend/release/`; más detalles en `PACKAGING.md`.

## 5. INSTRUCCIONES PARA FUTURAS SESIONES DE IA

1. Mantener el monorepo: componentes, estilos y cliente IPC en `app-frontend/`; servicios y orquestación en `core-backend/src/unum_core/`. Usar `main.py` como punto de integración del protocolo, sin concentrar allí lógica de negocio nueva.
2. Respetar `{ action, msg_id, payload }` y los eventos correlacionados. Cerrar tareas, PTY, LSP y conexiones al desconectar o apagar. Mantener las operaciones largas fuera del hilo de render y del bucle principal cuando bloqueen.
3. Preservar la política de aislamiento. Ninguna característica nueva debe requerir `sudo`, un JDK/Android SDK/Gradle/Maven global, un servidor DB global ni un runtime de IA global. Validar rutas y ejecutar SDKs mediante `EnvironmentManager`; colocar descargas en rutas locales del proyecto.
4. Distinguir preferencias, binarios instalados y conexiones activas. Seleccionar un motor en el wizard no significa que exista, que se haya iniciado ni que esté conectado. La edición remota del grid está limitada a PostgreSQL/MySQL y exige PK. No documentar `llama.cpp` ni virtualización automática de servidores externos como funciones existentes hasta implementarlas y verificarlas.
5. No guardar secretos en `unum_workspace.json`, logs, código fuente o respuestas IPC. Mantener claves cifradas y contraseñas de base de datos limitadas a la sesión. Evitar enviar contenido local a proveedores cloud de forma implícita.
6. Conservar la paginación y virtualización del grid y la importación por lotes. Extender el mismo enfoque si se añaden motores o formatos de datos.
7. Antes de entregar cambios, ejecutar la suite del backend y `npm run lint`/`npm run build`; añadir pruebas de integración para riesgos nuevos y señalar claramente cualquier dependencia externa que impida una prueba en vivo.
