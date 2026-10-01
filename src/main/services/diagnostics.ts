import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { DIAGNOSTICS_MAX_ENTRIES } from '../config'

const MAX_LOG_FILE_BYTES = 1024 * 1024 // 1 MB, lalu dirotasi ke .1

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function timeStamp(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Ring buffer log diagnostik (120 entri, format "HH:mm:ss  pesan") + file log berotasi.
 * JANGAN PERNAH menulis kredensial (api_token, kode aktivasi penuh) ke sini.
 */
export class Diagnostics {
  private entries: string[] = []
  private readonly logFile: string | null

  constructor(
    logDir: string | null,
    private readonly now: () => Date = () => new Date()
  ) {
    if (logDir) {
      mkdirSync(logDir, { recursive: true })
      this.logFile = join(logDir, 'player.log')
    } else {
      this.logFile = null
    }
  }

  log(message: string): void {
    const d = this.now()
    const line = `${timeStamp(d)}  ${message}`
    this.entries.push(line)
    if (this.entries.length > DIAGNOSTICS_MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - DIAGNOSTICS_MAX_ENTRIES)
    }
    this.writeToFile(`${d.toISOString()}  ${message}\n`)
  }

  snapshot(): string[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries = []
  }

  private writeToFile(text: string): void {
    if (!this.logFile) return
    try {
      if (existsSync(this.logFile) && statSync(this.logFile).size > MAX_LOG_FILE_BYTES) {
        const rotated = `${this.logFile}.1`
        if (existsSync(rotated)) unlinkSync(rotated)
        renameSync(this.logFile, rotated)
      }
      appendFileSync(this.logFile, text, 'utf8')
    } catch {
      // Logging tidak boleh pernah mengganggu playback.
    }
  }
}
