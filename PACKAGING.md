# Empaquetado de Unum IDE

El instalador incluye Electron y un ejecutable autónomo del backend Python. El equipo del usuario no necesita Python, `venv` ni paquetes Python instalados para abrir el IDE. El build se realiza **en la plataforma de destino**: PyInstaller crea un binario Linux en Linux y un `.exe` Windows en Windows.

## Preparación del equipo de build

- Python 3.11 o posterior, Node.js y npm para compilar. Se usan solo durante el build; el script crea `core-backend/.venv` y `npm ci` instala dependencias en `app-frontend/node_modules`.
- Acceso de red para descargar dependencias de Python/npm, Electron y herramientas de electron-builder la primera vez.
- En Windows, ejecutar en un host Windows x64; en Linux, en un host Linux x64. Para distribuir en varias distribuciones Linux, compilar en una base con `glibc` tan antigua como la mínima admitida.

Desde la raíz del repositorio:

```bash
cd app-frontend
npm ci
npm run package:linux   # host Linux: AppImage y .deb
# npm run package:win   # host Windows x64: NSIS .exe y portable .exe
```

`package.mjs` instala `core-backend[package]` en el `venv` local si hace falta, ejecuta `core-backend/build_backend.py`, compila el frontend y llama a electron-builder. Puede indicarse un intérprete de build con `UNUM_BUILD_PYTHON` cuando aún no existe `core-backend/.venv`. `build_backend.py` también puede ejecutarse directamente con el Python del `venv`.

En Fedora sin `libcrypt.so.1`, el script descarga `libxcrypt-compat` con `dnf download`, lo extrae en `app-frontend/build/compat/` y lo expone solo al proceso de empaquetado mediante `LD_LIBRARY_PATH`; no ejecuta `dnf install` ni usa `sudo`. Si el equipo de build ya tiene esa biblioteca en otra ruta, puede indicarse su directorio con `UNUM_BUILD_LIB_DIR`.

| Plataforma | Backend generado | Instaladores |
| --- | --- | --- |
| Linux | `app-frontend/resources/bin/linux/unum-backend` | `app-frontend/release/*.AppImage`, `*.deb` |
| Windows | `app-frontend/resources/bin/win/unum-backend.exe` | `app-frontend/release/*.exe` (NSIS y portable) |

El directorio `release/` se usa porque `dist/` contiene el bundle Vite. electron-builder coloca el backend como `resources/backend/unum-backend[.exe]` fuera de `app.asar`. El proceso principal de Electron lo ejecuta directamente, pasa `UNUM_IPC_TOKEN` y `UNUM_BACKEND_PORT` y guarda los datos del workspace en `userData/workspace`, una ruta escribible. El puerto loopback se asigna por instancia empaquetada; el preload entrega puerto y token juntos al renderer. El backend acepta el origen `file://` del AppImage solo cuando el token coincide. Durante desarrollo sigue arrancando `core-backend/start.sh` en el puerto 8000.

El backend no instala JDK, Android SDK, Gradle, servidores de bases externas ni Ollama en el SO. Los runtimes opcionales y los entornos Python para proyectos viven bajo `userData/workspace/.unum/runtimes/` y `.unum/venvs/`. Ejecutar archivos Python desde la distribución requiere añadir un intérprete Python local a `.unum/runtimes/python/`; el ejecutable congelado del servidor no se usa como intérprete de proyectos. El instalador gráfico de Ollama conserva su ruta local bajo `userData/workspace/core-backend/runtimes/ai/`. La terminal usa PTY en Linux y un proceso `cmd.exe` con pipes asíncronas en Windows; el resize de terminal no se aplica al shell Windows.

## Verificación

En Linux, después de construir el backend:

```bash
core-backend/.venv/bin/python core-backend/smoke_packaged.py app-frontend/resources/bin/linux/unum-backend
```

El script inicia el binario con un workspace temporal y puerto loopback libre, comprueba `/health`, rechaza un token incorrecto, abre el WebSocket con `Origin: file://` y token válido y ejecuta un comando en la terminal. Para inspeccionar el paquete sin generar instaladores: `cd app-frontend && npm exec -- electron-builder --linux dir`.
