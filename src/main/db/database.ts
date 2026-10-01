import Database from 'better-sqlite3'
import { migrate } from './migrations'

export type Db = Database.Database

/** Membuka (dan memigrasi) database lokal player. Dipanggil sekali di main process. */
export function openDatabase(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
