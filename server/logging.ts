import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { LOG_DIR } from './config.ts'

const MAX_BYTES = 1024 * 1024
const KEEP = 3

/** Mirrors console output into a small rotating log file outside iCloud. */
export function installLogging(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const file = path.join(LOG_DIR, 'server.log')

  const rotate = (): void => {
    try {
      if (fs.statSync(file).size < MAX_BYTES) return
    } catch {
      return
    }
    for (let i = KEEP - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`)
      } catch {}
    }
    try {
      fs.renameSync(file, `${file}.1`)
    } catch {}
  }

  const write = (level: string, args: unknown[]): void => {
    try {
      rotate()
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`)
    } catch {}
  }

  const log = console.log.bind(console)
  const error = console.error.bind(console)
  console.log = (...args: unknown[]) => {
    log(...args)
    write('INFO ', args)
  }
  console.error = (...args: unknown[]) => {
    error(...args)
    write('ERROR', args)
  }
}
