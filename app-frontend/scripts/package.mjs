import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(frontend, '..')
const backend = join(root, 'core-backend')
const buildEnv = { ...process.env }
const requested = process.argv[2]
const host = process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'linux' : ''
if (!host || requested !== host) {
  throw new Error(`Build ${requested || 'target'} on its native ${requested === 'win' ? 'Windows' : 'Linux'} host`)
}

function run(command, args, cwd = root, shell = false) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell, env: buildEnv })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`)
}

function prepareLinuxPackaging() {
  if (host !== 'linux') return
  let libraryDir = process.env.UNUM_BUILD_LIB_DIR
  const hasLibcrypt = ['/lib64/libcrypt.so.1', '/usr/lib64/libcrypt.so.1',
    '/lib/x86_64-linux-gnu/libcrypt.so.1', '/usr/lib/x86_64-linux-gnu/libcrypt.so.1'].some(existsSync)
  if (!libraryDir && !hasLibcrypt) {
    if (process.arch !== 'x64') throw new Error('Set UNUM_BUILD_LIB_DIR to a local libcrypt.so.1 directory')
    const downloadDir = join(frontend, 'build', 'compat', 'libcrypt')
    libraryDir = join(downloadDir, 'usr', 'lib64')
    if (!existsSync(join(libraryDir, 'libcrypt.so.1'))) {
      mkdirSync(downloadDir, { recursive: true })
      run('dnf', ['download', '--arch=x86_64', `--destdir=${downloadDir}`, 'libxcrypt-compat'])
      const rpm = readdirSync(downloadDir).find((name) => name.endsWith('.x86_64.rpm'))
      if (!rpm) throw new Error('libxcrypt-compat RPM was not downloaded')
      const archive = spawnSync('rpm2cpio', [join(downloadDir, rpm)], { maxBuffer: 8 * 1024 * 1024 })
      if (archive.status !== 0) throw new Error('rpm2cpio failed to unpack libxcrypt-compat')
      const extracted = spawnSync('cpio', ['-id', '--quiet'], { cwd: downloadDir, input: archive.stdout,
        stdio: ['pipe', 'inherit', 'inherit'] })
      if (extracted.status !== 0 || !existsSync(join(libraryDir, 'libcrypt.so.1'))) {
        throw new Error('Could not extract local libcrypt.so.1 for electron-builder')
      }
    }
  }
  if (libraryDir) buildEnv.LD_LIBRARY_PATH = [libraryDir, buildEnv.LD_LIBRARY_PATH].filter(Boolean).join(':')
}

const python = join(backend, '.venv', host === 'win' ? 'Scripts/python.exe' : 'bin/python')
if (!existsSync(python)) {
  const bootstrap = process.env.UNUM_BUILD_PYTHON || (host === 'win' ? 'py' : 'python3')
  const args = host === 'win' && !process.env.UNUM_BUILD_PYTHON ? ['-3', '-m', 'venv', join(backend, '.venv')] : ['-m', 'venv', join(backend, '.venv')]
  run(bootstrap, args)
}
run(python, ['-m', 'pip', 'install', '-e', `${backend}[package]`])
run(python, [join(backend, 'build_backend.py')])

const binary = join(frontend, 'resources', 'bin', host, host === 'win' ? 'unum-backend.exe' : 'unum-backend')
if (!existsSync(binary)) throw new Error(`Missing packaged backend: ${binary}`)
const npm = host === 'win' ? 'npm.cmd' : 'npm'
run(npm, ['run', 'build'], frontend, host === 'win')
prepareLinuxPackaging()
run(npm, ['exec', '--', 'electron-builder', `--${host === 'win' ? 'win' : 'linux'}`,
  ...(host === 'win' ? ['nsis', 'portable'] : ['AppImage', 'deb'])], frontend, host === 'win')
