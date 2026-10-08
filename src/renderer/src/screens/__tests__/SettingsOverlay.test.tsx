// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsOverlay from '../SettingsOverlay'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function overview(overrides: Partial<SettingsOverviewDto> = {}): SettingsOverviewDto {
  return {
    device: { registered: true, deviceCode: 'abcd1234-ffff', deviceName: 'Lobby', venueId: 7 },
    app: { version: '1.2.3', electron: '39.0.0', backendUrl: 'https://cms.example.test/' },
    system: {
      appBytes: 300 * 1024 * 1024,
      systemTotalBytes: 8 * 1024 ** 3,
      systemFreeBytes: 4 * 1024 ** 3
    },
    storage: {
      cacheDir: 'C:\\data\\content_cache',
      cacheFiles: 3,
      cacheBytes: 2 * 1024 ** 3,
      orphanFiles: 1,
      orphanBytes: 1024 * 1024,
      diskFreeBytes: 50 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      dbBytes: 4096,
      itemsTotal: 4,
      itemsReady: 3,
      itemsFailed: 1,
      pendingPlaybackLogs: 12
    },
    sync: { state: 'active', detail: 'Sinkronisasi terakhir berhasil' },
    settings: {
      keepScreenOn: true,
      customCacheDir: null,
      defaultCacheDir: 'C:\\data\\content_cache',
      cacheDirFallbackReason: null
    },
    ...overrides
  }
}

type Api = {
  [
    K in
      | 'getSettingsOverview'
      | 'chooseCacheDir'
      | 'previewCacheDir'
      | 'changeCacheDir'
      | 'cleanCache'
      | 'verifyCache'
      | 'forceSync'
      | 'setKeepScreenOn'
      | 'releaseDevice'
  ]: ReturnType<typeof vi.fn>
}

function makeApi(data: SettingsOverviewDto = overview()): Api {
  return {
    getSettingsOverview: vi.fn(async () => data),
    chooseCacheDir: vi.fn(async () => null),
    previewCacheDir: vi.fn(async () => ({
      ok: true,
      reason: null,
      isNew: true,
      existingCacheFiles: 0,
      currentFiles: 3,
      currentBytes: 2 * 1024 ** 3
    })),
    changeCacheDir: vi.fn(async () => ({ ok: true, message: 'Folder cache sekarang D:\\baru.' })),
    cleanCache: vi.fn(async () => ({ ok: true, message: '1 file dihapus.' })),
    verifyCache: vi.fn(async () => ({ ok: true, message: '3 file diperiksa, semuanya baik.' })),
    forceSync: vi.fn(async () => ({ ok: true, message: 'Playlist sudah yang terbaru.' })),
    setKeepScreenOn: vi.fn(async () => undefined),
    releaseDevice: vi.fn(async () => ({ ok: true, message: 'Device dilepas dari CMS.' }))
  }
}

let container: HTMLDivElement
let root: Root

async function render(api: Api, onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  ;(window as unknown as { api: unknown }).api = api
  await act(async () => {
    root.render(<SettingsOverlay onClose={onClose} />)
  })
  return onClose
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  if (!found) throw new Error(`tombol "${text}" tidak ditemukan`)
  return found
}

const hasButton = (text: string): boolean =>
  [...container.querySelectorAll('button')].some((b) => b.textContent?.includes(text))

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
  await flush()
}

async function typePath(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('.settings-path input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('SettingsOverlay', () => {
  it('shows device, system, storage and folder information', async () => {
    await render(makeApi())
    const text = container.textContent ?? ''
    expect(text).toContain('Terdaftar')
    expect(text).toContain('Lobby')
    expect(text).toContain('abcd1234')
    expect(text).toContain('1.2.3 (Electron 39.0.0)')
    expect(text).toContain('https://cms.example.test/')
    expect(text).toContain('Sinkronisasi terakhir berhasil')
    expect(text).toContain('3 file, 2.0 GB')
    expect(text).toContain('50.0 GB dari 100.0 GB')
    expect(text).toContain('4 item (3 siap, 1 gagal)')
    expect(text).toContain('C:\\data\\content_cache')
    expect(text).toContain('(bawaan)')
    expect(container.querySelector('[aria-label="Disk terpakai 50%"]')).not.toBeNull()
  })

  it('shows a readable error when the overview cannot be loaded', async () => {
    const api = makeApi()
    api.getSettingsOverview.mockRejectedValue(new Error('IPC gagal'))
    await render(api)
    expect(container.textContent).toContain('Gagal memuat data: IPC gagal')
  })

  it('closes with the close button', async () => {
    const onClose = await render(makeApi())
    await click(button('Tutup'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toggles keep-screen-on through the API', async () => {
    const api = makeApi()
    await render(api)
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.checked).toBe(true)
    await click(checkbox)
    expect(api.setKeepScreenOn).toHaveBeenCalledWith(false)
  })

  it('runs the manual actions and shows their result', async () => {
    const api = makeApi()
    await render(api)

    await click(button('Sync ulang paksa'))
    expect(api.forceSync).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Playlist sudah yang terbaru.')

    await click(button('Bersihkan cache sekarang'))
    expect(container.textContent).toContain('1 file dihapus.')

    await click(button('Verifikasi file cache'))
    expect(container.textContent).toContain('3 file diperiksa, semuanya baik.')
  })

  it('shows failures of actions as errors, even when the API throws', async () => {
    const api = makeApi()
    api.cleanCache.mockRejectedValue(new Error('IPC putus'))
    await render(api)
    await click(button('Bersihkan cache sekarang'))
    expect(container.querySelector('.error')?.textContent).toContain('IPC putus')
  })

  it('ignores a second action while one is running and disables the buttons', async () => {
    const api = makeApi()
    let finish!: (value: { ok: boolean; message: string }) => void
    api.forceSync.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    await render(api)

    await click(button('Sync ulang paksa'))
    expect(button('Menyinkronkan').disabled).toBe(true)
    expect(button('Bersihkan cache sekarang').disabled).toBe(true)
    await click(button('Menyinkronkan'))
    expect(api.forceSync).toHaveBeenCalledTimes(1)

    await act(async () => finish({ ok: true, message: 'selesai' }))
    await flush()
    expect(container.textContent).toContain('selesai')
    expect(button('Sync ulang paksa').disabled).toBe(false)
  })
})

describe('SettingsOverlay cache folder', () => {
  it('validates the typed folder, then moves the cache when applied', async () => {
    const api = makeApi()
    await render(api)

    await typePath('  D:\\SosmedSignCache  ')
    await click(button('Periksa'))
    expect(api.previewCacheDir).toHaveBeenCalledWith('D:\\SosmedSignCache')
    expect(container.textContent).toContain('Folder baru/kosong dan bisa dipakai.')
    expect(container.textContent).toContain('Pindahkan 3 file cache saat ini (2.0 GB)')

    await click(button('Terapkan folder ini'))
    expect(api.changeCacheDir).toHaveBeenCalledWith('D:\\SosmedSignCache', 'move')
    expect(container.textContent).toContain('Folder cache sekarang D:\\baru.')
    expect(hasButton('Terapkan folder ini')).toBe(false) // pratinjau ditutup setelah berhasil
    expect(container.querySelector<HTMLInputElement>('.settings-path input')!.value).toBe('')
  })

  it('supports starting empty instead of moving files', async () => {
    const api = makeApi()
    await render(api)
    await typePath('D:\\SosmedSignCache')
    await click(button('Periksa'))
    await click(
      container.querySelector<HTMLInputElement>(
        'input[value=""][type="radio"], input[name="cache-mode"]:not(:checked)'
      )!
    )
    await click(button('Terapkan folder ini'))
    expect(api.changeCacheDir).toHaveBeenCalledWith('D:\\SosmedSignCache', 'fresh')
  })

  it('shows why a folder is rejected and offers no apply button', async () => {
    const api = makeApi()
    api.previewCacheDir.mockResolvedValue({
      ok: false,
      reason: 'Tidak boleh memakai root drive sebagai folder cache.',
      isNew: false,
      existingCacheFiles: 0,
      currentFiles: 0,
      currentBytes: 0
    })
    await render(api)
    await typePath('C:\\')
    await click(button('Periksa'))
    expect(container.querySelector('.error')?.textContent).toContain('root drive')
    expect(hasButton('Terapkan folder ini')).toBe(false)
  })

  it('fills the path from the folder picker and previews it', async () => {
    const api = makeApi()
    api.chooseCacheDir.mockResolvedValue('E:\\Konten')
    await render(api)
    await click(button('Pilih folder'))
    expect(api.previewCacheDir).toHaveBeenCalledWith('E:\\Konten')
    expect(container.querySelector<HTMLInputElement>('.settings-path input')!.value).toBe(
      'E:\\Konten'
    )
  })

  it('does nothing when the picker is cancelled', async () => {
    const api = makeApi()
    await render(api)
    await click(button('Pilih folder'))
    expect(api.previewCacheDir).not.toHaveBeenCalled()
  })

  it('warns about a fallback and can return to the default folder', async () => {
    const api = makeApi(
      overview({
        settings: {
          keepScreenOn: true,
          customCacheDir: 'E:\\Konten',
          defaultCacheDir: 'C:\\data\\content_cache',
          cacheDirFallbackReason: 'drive tidak ditemukan'
        }
      })
    )
    await render(api)
    expect(container.querySelector('.notice')?.textContent).toContain('drive tidak ditemukan')
    expect(container.textContent).toContain('(khusus)')
    await click(button('Kembalikan ke folder bawaan'))
    expect(api.changeCacheDir).toHaveBeenCalledWith('C:\\data\\content_cache', 'move')
  })
})

describe('SettingsOverlay release', () => {
  it('asks for confirmation, can be cancelled, and closes the menu after a successful release', async () => {
    const api = makeApi()
    const onClose = await render(api)

    await click(button('Lepaskan device'))
    expect(container.textContent).toContain('Yakin?')
    await click(button('Batal'))
    expect(hasButton('Ya, lepaskan')).toBe(false)
    expect(api.releaseDevice).not.toHaveBeenCalled()

    await click(button('Lepaskan device'))
    await click(button('Ya, lepaskan'))
    expect(api.releaseDevice).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the menu open and shows the reason when the release fails', async () => {
    const api = makeApi()
    api.releaseDevice.mockResolvedValue({ ok: false, message: 'Device masih punya booking aktif.' })
    const onClose = await render(api)
    await click(button('Lepaskan device'))
    await click(button('Ya, lepaskan'))
    expect(container.querySelector('.error')?.textContent).toContain('booking aktif')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('hides the release button for an unregistered device', async () => {
    await render(
      makeApi(
        overview({
          device: {
            registered: false,
            deviceCode: 'abcd1234-ffff',
            deviceName: null,
            venueId: null
          }
        })
      )
    )
    expect(container.textContent).toContain('Belum terdaftar')
    expect(hasButton('Lepaskan device')).toBe(false)
  })
})
