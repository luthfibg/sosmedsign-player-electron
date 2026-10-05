import { countPlayable, findNextPlayable } from './rotation'

export type EngineState = 'waiting' | 'playing' | 'idle'

export interface EngineElements {
  /** Dua elemen video bergantian (A/B): yang satu tampil, yang lain memuat item berikutnya agar tanpa jeda. */
  videos: [HTMLVideoElement, HTMLVideoElement]
  image: HTMLImageElement
}

export interface EngineCallbacks {
  onStateChange?: (state: EngineState) => void
  onItemStarted?: (item: PlayerItemDto) => void
  /** Item selesai wajar (video ended / timer gambar habis). Dipakai pelapor statistik tayang di M4. */
  onItemCompleted?: (item: PlayerItemDto, info: { startedAt: Date; playedSeconds: number }) => void
  onLog?: (message: string) => void
}

export interface EngineOptions {
  now?: () => Date
  /** Selang cek ulang jadwal saat tidak ada yang boleh tayang (default 30 dtk). */
  idleRecheckMs?: number
  /** Jeda sebelum mencoba lagi setelah semua item gagal berturut-turut (default 5 dtk). */
  retryBackoffMs?: number
  /** Batas menunggu video/gambar mulai tampil sebelum dianggap gagal (default 20 dtk). */
  loadTimeoutMs?: number
  /** Tambahan di atas durasi video sebelum watchdog memaksa lanjut (default 10 dtk). */
  watchdogSlackMs?: number
}

interface Current {
  index: number
  item: PlayerItemDto
  kind: 'video' | 'image'
  slot: 0 | 1 | null
  /** Waktu mulai tampil (null selama masih memuat). */
  startedAt: Date | null
  startedMs: number
}

interface Prepared {
  slot: 0 | 1
  url: string
}

const MAX_IMAGE_CACHE = 4

/**
 * Mesin pemutaran: rotasi berurutan, jadwal, transisi tanpa jeda, dan penanganan error.
 * Murni DOM + timer (tanpa React) supaya bisa diuji; PlayerScreen hanya menyambungkannya.
 *
 * Aturan (dari player Android):
 *  - item di luar jadwal dilewati dari rotasi, bukan dihapus;
 *  - error putar/decode -> lompat ke item berikutnya, tidak dicatat sebagai tayang, tidak berhenti total;
 *  - gambar tampil selama duration_seconds dari server (minimum 1 detik);
 *  - playlist baru: item yang sedang tayang diselesaikan dulu, lalu rotasi mulai dari awal.
 */
export class PlaybackEngine {
  private items: PlayerItemDto[] = []
  private pendingRestart = false
  private current: Current | null = null
  private prepared: Prepared | null = null
  private activeSlot: 0 | 1 = 0
  private consecutiveFailures = 0
  private state: EngineState = 'waiting'
  private destroyed = false

  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private imageTimer: ReturnType<typeof setTimeout> | null = null
  private loadTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Naik tiap item baru dimulai/dihentikan; hasil async dari item lama dibuang. */
  private token = 0

  private readonly imageCache = new Map<string, Promise<boolean>>()
  private readonly now: () => Date
  private readonly idleRecheckMs: number
  private readonly retryBackoffMs: number
  private readonly loadTimeoutMs: number
  private readonly watchdogSlackMs: number
  private readonly listeners: { target: HTMLVideoElement; type: string; fn: EventListener }[] = []

  constructor(
    private readonly els: EngineElements,
    private readonly callbacks: EngineCallbacks = {},
    options: EngineOptions = {}
  ) {
    this.now = options.now ?? ((): Date => new Date())
    this.idleRecheckMs = options.idleRecheckMs ?? 30_000
    this.retryBackoffMs = options.retryBackoffMs ?? 5_000
    this.loadTimeoutMs = options.loadTimeoutMs ?? 20_000
    this.watchdogSlackMs = options.watchdogSlackMs ?? 10_000

    for (const video of els.videos) {
      video.loop = false
      video.preload = 'auto'
      video.playsInline = true
      this.listen(video, 'playing', () => this.onVideoPlaying(video))
      this.listen(video, 'ended', () => this.onVideoEnded(video))
      this.listen(video, 'error', () => this.onVideoError(video))
      this.listen(video, 'loadedmetadata', () => this.onVideoMetadata(video))
    }
    this.hideAll()
  }

  /** null = server belum pernah mengirim playlist; selain itu daftar item yang siap diputar (boleh kosong). */
  setPlaylist(playlist: PlayerPlaylistDto | null): void {
    if (this.destroyed) return
    if (!playlist) {
      this.items = []
      if (!this.current) this.setState('waiting')
      return
    }
    this.items = playlist.items
    this.prepared = null

    if (this.current) {
      // Selesaikan item yang sedang tayang, lalu mulai dari awal playlist baru.
      this.pendingRestart = true
      this.preloadNext()
    } else {
      this.clearTimer('idleTimer')
      this.clearTimer('retryTimer')
      this.consecutiveFailures = 0
      this.advance(-1)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.token++
    this.clearAllTimers()
    for (const { target, type, fn } of this.listeners) target.removeEventListener(type, fn)
    this.listeners.length = 0
    this.stopMedia()
    this.current = null
  }

  // ---- pemilihan item ----

  private advance(fromIndex: number): void {
    if (this.destroyed) return
    const from = this.pendingRestart ? -1 : fromIndex
    this.pendingRestart = false
    const next = findNextPlayable(this.items, from, this.now())
    if (next < 0) {
      this.goIdle()
      return
    }
    this.startItem(next)
  }

  private startItem(index: number): void {
    const item = this.items[index]
    this.clearTimer('imageTimer')
    this.clearTimer('watchdogTimer')
    this.clearTimer('loadTimer')
    const token = ++this.token
    this.current = {
      index,
      item,
      kind: item.mediaType,
      slot: null,
      startedAt: null,
      startedMs: 0
    }
    if (item.mediaType === 'image') void this.showImage(item, token)
    else this.showVideo(item, token)
  }

  // ---- video ----

  private showVideo(item: PlayerItemDto, token: number): void {
    const prepared = this.prepared
    let slot: 0 | 1
    if (prepared && prepared.url === item.mediaUrl && prepared.slot !== this.activeSlot) {
      slot = prepared.slot
    } else {
      slot = this.activeSlot === 0 ? 1 : 0
      this.loadVideo(slot, item.mediaUrl)
    }
    this.prepared = null
    if (this.current) this.current.slot = slot

    const video = this.els.videos[slot]
    video.currentTime = 0
    this.loadTimer = setTimeout(() => {
      if (token === this.token)
        this.fail(`video tidak mulai tampil dalam ${this.loadTimeoutMs / 1000} dtk`)
    }, this.loadTimeoutMs)

    let played: Promise<void> | undefined
    try {
      played = video.play() as Promise<void> | undefined
    } catch (error) {
      this.fail(`play() gagal: ${errorText(error)}`)
      return
    }
    played?.catch((error: unknown) => {
      if (token === this.token) this.fail(`play() ditolak: ${errorText(error)}`)
    })
  }

  private loadVideo(slot: 0 | 1, url: string): void {
    const video = this.els.videos[slot]
    video.pause()
    video.src = url
    video.load()
  }

  private onVideoPlaying(video: HTMLVideoElement): void {
    const current = this.current
    if (!current || current.kind !== 'video' || current.slot === null) return
    if (video !== this.els.videos[current.slot] || current.startedAt) return

    // Item benar-benar tampil: tukar tampilan, bebaskan decoder lama, lalu siapkan item berikutnya.
    const previousSlot = this.activeSlot
    this.activeSlot = current.slot
    this.clearTimer('loadTimer')
    video.style.opacity = '1'
    this.els.image.style.opacity = '0'
    if (previousSlot !== current.slot) this.unloadVideo(previousSlot)

    current.startedAt = this.now()
    current.startedMs = Date.now()
    this.consecutiveFailures = 0
    this.armWatchdog(current.item.durationSeconds * 1000)
    this.setState('playing')
    this.callbacks.onItemStarted?.(current.item)
    this.preloadNext()
  }

  private onVideoMetadata(video: HTMLVideoElement): void {
    const current = this.current
    if (!current || current.kind !== 'video' || current.slot === null) return
    if (video !== this.els.videos[current.slot]) return
    // Durasi sebenarnya dari file menggantikan perkiraan server untuk batas watchdog.
    if (Number.isFinite(video.duration) && video.duration > 0) {
      this.armWatchdog(video.duration * 1000)
    }
  }

  private onVideoEnded(video: HTMLVideoElement): void {
    const current = this.current
    if (!current || current.kind !== 'video' || current.slot === null) return
    if (video !== this.els.videos[current.slot]) return
    this.complete()
  }

  private onVideoError(video: HTMLVideoElement): void {
    const current = this.current
    if (
      current?.kind === 'video' &&
      current.slot !== null &&
      video === this.els.videos[current.slot]
    ) {
      this.fail(`video error (${video.error?.message || video.error?.code || 'tidak diketahui'})`)
    } else if (this.prepared && video === this.els.videos[this.prepared.slot]) {
      this.prepared = null // persiapan gagal: item akan dimuat ulang saat gilirannya
    }
  }

  private armWatchdog(mediaMs: number): void {
    this.clearTimer('watchdogTimer')
    const token = this.token
    this.watchdogTimer = setTimeout(
      () => {
        if (token === this.token) this.fail('video macet (melewati batas durasi)')
      },
      Math.max(1000, mediaMs) + this.watchdogSlackMs
    )
  }

  private unloadVideo(slot: 0 | 1): void {
    const video = this.els.videos[slot]
    video.style.opacity = '0'
    if (!video.hasAttribute('src')) return // belum pernah dipakai: tidak perlu membebaskan apa pun
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  // ---- gambar ----

  private async showImage(item: PlayerItemDto, token: number): Promise<void> {
    this.loadTimer = setTimeout(() => {
      if (token === this.token) this.fail('gambar tidak termuat tepat waktu')
    }, this.loadTimeoutMs)

    const ok = await this.ensureImage(item.mediaUrl)
    if (token !== this.token || this.destroyed) return
    this.clearTimer('loadTimer')
    if (!ok) {
      this.fail('gambar gagal dimuat')
      return
    }

    const image = this.els.image
    if (image.getAttribute('src') !== item.mediaUrl) image.src = item.mediaUrl
    image.style.opacity = '1'
    this.unloadVideo(this.activeSlot === 0 ? 1 : 0)
    this.els.videos[this.activeSlot].style.opacity = '0'
    this.els.videos[this.activeSlot].pause()

    const current = this.current
    if (!current) return
    current.startedAt = this.now()
    current.startedMs = Date.now()
    this.consecutiveFailures = 0
    this.setState('playing')
    this.callbacks.onItemStarted?.(item)
    this.imageTimer = setTimeout(
      () => {
        if (token === this.token) this.complete()
      },
      Math.max(1, item.durationSeconds) * 1000
    )
    this.preloadNext()
  }

  private ensureImage(url: string): Promise<boolean> {
    const cached = this.imageCache.get(url)
    if (cached) return cached
    const promise = new Promise<boolean>((resolve) => {
      const probe = new Image()
      probe.onload = (): void => resolve(true)
      probe.onerror = (): void => resolve(false)
      probe.src = url
    })
    this.imageCache.set(url, promise)
    if (this.imageCache.size > MAX_IMAGE_CACHE) {
      const oldest = this.imageCache.keys().next().value
      if (oldest !== undefined) this.imageCache.delete(oldest)
    }
    void promise.then((ok) => {
      if (!ok) this.imageCache.delete(url) // gagal: boleh dicoba lagi
    })
    return promise
  }

  // ---- persiapan item berikutnya ----

  private preloadNext(): void {
    if (this.destroyed || !this.current) return
    const from = this.pendingRestart ? -1 : this.current.index
    const nextIndex = findNextPlayable(this.items, from, this.now())
    if (nextIndex < 0) return
    const next = this.items[nextIndex]
    if (next.mediaType === 'image') {
      void this.ensureImage(next.mediaUrl)
      return
    }
    const standby: 0 | 1 = this.activeSlot === 0 ? 1 : 0
    if (this.prepared?.slot === standby && this.prepared.url === next.mediaUrl) return
    this.loadVideo(standby, next.mediaUrl)
    this.prepared = { slot: standby, url: next.mediaUrl }
  }

  // ---- penyelesaian / kegagalan ----

  private complete(): void {
    const current = this.current
    if (!current || !current.startedAt) return
    this.token++
    this.clearTimer('imageTimer')
    this.clearTimer('watchdogTimer')
    this.clearTimer('loadTimer')
    this.consecutiveFailures = 0
    this.callbacks.onItemCompleted?.(current.item, {
      startedAt: current.startedAt,
      playedSeconds: Math.max(0, (Date.now() - current.startedMs) / 1000)
    })
    this.advance(current.index)
  }

  private fail(reason: string): void {
    const current = this.current
    if (!current || this.destroyed) return
    this.token++
    this.clearTimer('imageTimer')
    this.clearTimer('watchdogTimer')
    this.clearTimer('loadTimer')
    this.log(`Lewati "${current.item.label}": ${reason}`)
    if (current.kind === 'video' && current.slot !== null) {
      if (current.slot !== this.activeSlot) this.unloadVideo(current.slot)
      // Persiapan di slot lain tetap berlaku (tidak perlu memuat ulang item berikutnya).
      if (this.prepared?.slot === current.slot) this.prepared = null
    }

    this.consecutiveFailures++
    const playable = Math.max(1, countPlayable(this.items, this.now()))
    if (this.consecutiveFailures >= playable) {
      // Semua item yang boleh tayang sudah dicoba dan gagal: tunggu sebentar agar tidak berputar cepat.
      this.consecutiveFailures = 0
      this.stopMedia()
      this.current = null
      this.setState('idle')
      this.retryTimer = setTimeout(() => this.advance(-1), this.retryBackoffMs)
      return
    }
    this.advance(current.index)
  }

  private goIdle(): void {
    this.token++
    this.stopMedia()
    this.current = null
    this.setState('idle')
    this.clearTimer('idleTimer')
    // Evaluasi ulang jadwal secara berkala: item yang jendelanya baru dibuka mulai tayang sendiri.
    if (this.items.length > 0) {
      this.idleTimer = setTimeout(() => this.advance(-1), this.idleRecheckMs)
    }
  }

  // ---- bantu ----

  private stopMedia(): void {
    this.clearTimer('imageTimer')
    this.clearTimer('watchdogTimer')
    this.clearTimer('loadTimer')
    this.prepared = null
    for (const slot of [0, 1] as const) this.unloadVideo(slot)
    this.els.image.style.opacity = '0'
  }

  private hideAll(): void {
    for (const video of this.els.videos) video.style.opacity = '0'
    this.els.image.style.opacity = '0'
  }

  private setState(state: EngineState): void {
    if (this.state === state) return
    this.state = state
    this.callbacks.onStateChange?.(state)
  }

  private log(message: string): void {
    this.callbacks.onLog?.(message)
  }

  private listen(target: HTMLVideoElement, type: string, fn: EventListener): void {
    target.addEventListener(type, fn)
    this.listeners.push({ target, type, fn })
  }

  private clearTimer(
    name: 'watchdogTimer' | 'imageTimer' | 'loadTimer' | 'idleTimer' | 'retryTimer'
  ): void {
    const timer = this[name]
    if (timer) clearTimeout(timer)
    this[name] = null
  }

  private clearAllTimers(): void {
    for (const name of [
      'watchdogTimer',
      'imageTimer',
      'loadTimer',
      'idleTimer',
      'retryTimer'
    ] as const) {
      this.clearTimer(name)
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
