export type Packet = { action: string; msg_id: string; payload: Record<string, unknown> }
export type EventPacket = { event: string; msg_id?: string; [key: string]: unknown }

declare global {
  interface Window {
    unum?: { token: () => Promise<string>; window: (action: 'minimize' | 'maximize' | 'close') => Promise<void> }
  }
}

class IpcClient {
  private socket?: WebSocket
  private nextId = 0
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private listeners = new Set<(event: EventPacket) => void>()
  private statusListeners = new Set<(connected: boolean) => void>()
  private connectionAttempt?: Promise<void>
  connected = false

  async connect() {
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return
    if (this.connectionAttempt) return this.connectionAttempt
    this.connectionAttempt = this.open()
    try { await this.connectionAttempt } finally { this.connectionAttempt = undefined }
  }

  private async open() {
    const token = await window.unum?.token()
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return
    this.socket = new WebSocket(`ws://127.0.0.1:8000/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`)
    this.socket.onopen = () => {
      this.connected = true
      this.statusListeners.forEach((listener) => listener(true))
    }
    this.socket.onmessage = (incoming) => {
      const message = JSON.parse(incoming.data)
      if (message.event) this.listeners.forEach((listener) => listener(message))
      else if (message.msg_id && this.pending.has(message.msg_id)) {
        const callback = this.pending.get(message.msg_id)!
        this.pending.delete(message.msg_id)
        if (message.ok) callback.resolve(message.payload)
        else callback.reject(new Error(message.error || 'Request failed'))
      }
    }
    this.socket.onclose = () => {
      this.connected = false
      this.statusListeners.forEach((listener) => listener(false))
      this.pending.forEach((callback) => callback.reject(new Error('Backend disconnected')))
      this.pending.clear()
      setTimeout(() => void this.connect(), 1500)
    }
  }

  request<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Backend is starting'))
    const msg_id = String(++this.nextId)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg_id, { resolve: (value) => resolve(value as T), reject })
      this.socket!.send(JSON.stringify({ action, msg_id, payload } satisfies Packet))
    })
  }

  onEvent(listener: (event: EventPacket) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onStatus(listener: (connected: boolean) => void) {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }
}

export const ipc = new IpcClient()
