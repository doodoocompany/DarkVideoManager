import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HighlightRepository } from './repositories/HighlightRepository'
import { PlayHistoryRepository } from './repositories/PlayHistoryRepository'
import { SettingsRepository } from './repositories/SettingsRepository'
import { SubtitleRepository } from './repositories/SubtitleRepository'
import { ThumbnailRepository } from './repositories/ThumbnailRepository'
import { VideoRepository } from './repositories/VideoRepository'
import { closeAllDatabases, closeDatabase, isLibraryReadOnly, openDatabase } from './connection'
import { getSchemaVersion, runMigrations } from './migrator'

let db: SqliteDatabase
let temporaryDirectory: string | undefined

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db, ':memory:')
})

afterEach(() => {
  db?.close()
  closeAllDatabases()
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

function insertVideo(id = 'video-1'): void {
  new VideoRepository(db).insert({
    id,
    filePath: `/videos/${id}.mp4`,
    fileName: `${id}.mp4`,
    rating: 0,
    memo: '',
    resumePosSec: 0,
  })
}

describe('SQLite migrations and connection', () => {
  it('applies contiguous migrations and enables required tables', () => {
    expect(getSchemaVersion(db)).toBe(6)
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'highlights'")
        .get(),
    ).toBeTruthy()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('checkpoints committed WAL data into the migration backup', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'dark-video-manager-wal-'))
    const dbPath = join(temporaryDirectory, 'old.db')
    const old = new Database(dbPath)
    try {
      old.pragma('journal_mode = WAL')
      old.pragma('wal_autocheckpoint = 0')
      old.exec(
        readFileSync(join(process.cwd(), 'electron/main/db/migrations/001_init.sql'), 'utf8'),
      )
      old.exec(
        readFileSync(join(process.cwd(), 'electron/main/db/migrations/002_highlights.sql'), 'utf8'),
      )
      old.exec('INSERT INTO schema_version(version) VALUES(1),(2)')
      old.pragma('wal_checkpoint(TRUNCATE)')
      old
        .prepare('INSERT INTO videos(id,file_path,file_name,memo) VALUES(?,?,?,?)')
        .run('wal-video', '/wal.mp4', 'wal.mp4', 'latest committed memo')
      runMigrations(old, dbPath)
      expect(getSchemaVersion(old)).toBe(6)
      const backupFile = readdirSync(temporaryDirectory).find((name) =>
        name.startsWith('old.db.bak.'),
      )!
      const backup = new Database(join(temporaryDirectory, backupFile), { readonly: true })
      try {
        expect(backup.prepare('SELECT memo FROM videos WHERE id = ?').get('wal-video')).toEqual({
          memo: 'latest committed memo',
        })
        expect(getSchemaVersion(backup)).toBe(2)
      } finally {
        backup.close()
      }
    } finally {
      old.close()
    }
  })

  it('holds a writer lock and opens a second process view read-only', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'dark-video-manager-'))
    const dbPath = join(temporaryDirectory, 'library.db')
    const primary = openDatabase('writer', dbPath)
    expect(primary.pragma('query_only', { simple: true })).toBe(0)
    const secondary = openDatabase('reader', dbPath)

    expect(isLibraryReadOnly('writer')).toBe(false)
    expect(isLibraryReadOnly('reader')).toBe(true)
    expect(secondary.pragma('query_only', { simple: true })).toBe(1)
    expect(existsSync(`${dbPath}.lock`)).toBe(true)

    closeDatabase('reader')
    closeDatabase('writer')
    expect(existsSync(`${dbPath}.lock`)).toBe(false)
  })
})

describe('repositories', () => {
  it('stores and reads half-star ratings without rounding', () => {
    insertVideo()
    const repository = new VideoRepository(db)
    for (const rating of [0.5, 3.5, 4.5, 5, 0]) {
      repository.updateMeta('video-1', { rating })
      expect(new VideoRepository(db).findById('video-1')?.rating).toBe(rating)
      expect(repository.search({}).videos[0].rating).toBe(rating)
    }
  })

  it('inserts, searches, updates, and removes videos without erasing their records', () => {
    const repository = new VideoRepository(db)
    insertVideo()

    expect(repository.findByPath('/videos/video-1.mp4')?.id).toBe('video-1')
    expect(repository.search({ q: 'VIDEO-1', page: 1, pageSize: 10 }).total).toBe(1)
    repository.updateMeta('video-1', { title: 'A sample', rating: 4 })
    expect(repository.findById('video-1')).toMatchObject({ title: 'A sample', rating: 4 })
    repository.delete('video-1')
    expect(repository.count()).toBe(0)
    expect(repository.findByPath('/videos/video-1.mp4')).toMatchObject({
      id: 'video-1',
      removalMode: 'remove',
      rating: 4,
    })
    expect(repository.listAll()).toEqual([])
    expect(repository.search({ removed: true }).videos).toHaveLength(1)
    repository.restore('video-1')
    expect(repository.search({}).videos).toHaveLength(1)
  })

  it('maintains one primary thumbnail and validates video ownership', () => {
    insertVideo()
    const repository = new ThumbnailRepository(db)
    repository.insert({
      id: 'thumb-a',
      videoId: 'video-1',
      filePath: '/a.jpg',
      timeSec: 1,
      isPrimary: true,
    })
    repository.insert({
      id: 'thumb-b',
      videoId: 'video-1',
      filePath: '/b.jpg',
      timeSec: 2,
      isPrimary: true,
    })

    expect(repository.findByVideoId('video-1').map((thumbnail) => thumbnail.isPrimary)).toEqual([
      false,
      true,
    ])
    expect(() => repository.setPrimary('thumb-b', 'other-video')).toThrow(
      '썸네일을 찾을 수 없습니다.',
    )
  })

  it('persists a changed primary thumbnail in the library after reopening the database', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'dark-video-manager-thumbnail-'))
    const dbPath = join(temporaryDirectory, 'library.db')
    db.close()
    db = new Database(dbPath)
    runMigrations(db, dbPath)
    insertVideo()
    const repository = new ThumbnailRepository(db)
    for (const index of [1, 2]) {
      repository.insert({
        id: `thumb-${index}`,
        videoId: 'video-1',
        filePath: `/thumb-${index}.jpg`,
        timeSec: index,
        isPrimary: index === 1,
      })
    }
    repository.setPrimary('thumb-2', 'video-1')
    db.close()
    db = new Database(dbPath)
    expect(new ThumbnailRepository(db).findByVideoId('video-1').map((item) => item.isPrimary)).toEqual([
      false,
      true,
    ])
    expect(new VideoRepository(db).findById('video-1')?.primaryThumbnailPath).toBe('/thumb-2.jpg')
  })

  it('preserves substring/wildcard matching, removed filters and page hydration', () => {
    const repository = new VideoRepository(db)
    for (const id of ['c', 'a', 'b', 'removed']) {
      repository.insert({
        id,
        filePath: `/videos/${id}.mp4`,
        fileName: 'Same Clip.mp4',
        title: id === 'b' ? undefined : 'Title',
        rating: 4,
        memo: '',
        tags: '여행, Tag_42',
        resumePosSec: 0,
        durationSec: id === 'b' ? undefined : 20,
      })
    }
    repository.markRemoved('removed', 'remove')
    new ThumbnailRepository(db).insert({
      id: 'capture',
      videoId: 'a',
      filePath: '/capture.jpg',
      timeSec: 2,
      isPrimary: true,
    })
    new SubtitleRepository(db).insert({
      id: 'caption',
      videoId: 'a',
      filePath: '/caption.srt',
      type: 'srt',
      isEmbedded: false,
    })
    const first = repository.search({
      q: 'CLIP',
      sortBy: 'fileName',
      sortDir: 'asc',
      page: 1,
      pageSize: 1,
    })
    expect(first.total).toBe(3)
    expect(first.videos).toMatchObject([
      { id: 'a', primaryThumbnailPath: '/capture.jpg', hasSubtitles: true },
    ])
    expect(
      repository.search({ q: '여행', sortBy: 'fileName', sortDir: 'asc', page: 2, pageSize: 1 })
        .videos[0].id,
    ).toBe('b')
    expect(repository.search({ q: 'tag_4%', rating: 4 }).total).toBe(3)
    expect(repository.search({ q: 'tag_4%', rating: 5 }).total).toBe(0)
    expect(repository.search({ q: 'TAG', removed: true }).videos.map((video) => video.id)).toEqual([
      'removed',
    ])
    expect(repository.search({ q: 'not present' })).toMatchObject({ total: 0, videos: [] })
    expect(repository.search({ q: 'CLIP', page: 99, pageSize: 1 })).toMatchObject({
      total: 3,
      videos: [],
    })
    for (const sortDir of ['asc', 'desc'] as const) {
      // Null duration remains last and ties always use the same ID order in either direction.
      expect(
        repository.search({ sortBy: 'durationSec', sortDir }).videos.map((video) => video.id),
      ).toEqual(['a', 'c', 'b'])
    }
  })

  it('uses the partial ordering index for the ordinary library without a full sort', () => {
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM videos WHERE removal_mode IS NULL ORDER BY created_at DESC NULLS LAST, id ASC LIMIT 50 OFFSET 100',
      )
      .all() as Array<{ detail: string }>
    expect(plan.some((row) => row.detail.includes('idx_videos_active_created'))).toBe(true)
    expect(plan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false)
  })

  it('updates playback history and applies the play-count trigger', () => {
    insertVideo()
    const repository = new PlayHistoryRepository(db)
    repository.insert({
      id: 'play-1',
      videoId: 'video-1',
      startedAt: '2026-01-01T00:00:00Z',
      posStartSec: 2,
    })
    repository.update('play-1', '2026-01-01T00:01:00Z', 8, 6)

    expect(repository.findByVideoId('video-1')).toMatchObject([
      { id: 'play-1', endedAt: '2026-01-01T00:01:00Z', posEndSec: 8, durationWatchedSec: 6 },
    ])
    expect(
      db.prepare('SELECT play_count, resume_pos_sec FROM videos WHERE id = ?').get('video-1'),
    ).toEqual({
      play_count: 1,
      resume_pos_sec: 8,
    })
  })

  it('persists highlights and subtitles with video ownership', () => {
    insertVideo()
    const highlights = new HighlightRepository(db)
    highlights.insert({
      id: 'highlight-1',
      videoId: 'video-1',
      timeStart: 3,
      label: 'Key moment',
      color: 'yellow',
      createdAt: '2026-01-01T00:00:00Z',
    })
    highlights.update('highlight-1', { timeEnd: 5, color: 'red' })

    const subtitles = new SubtitleRepository(db)
    subtitles.insert({
      id: 'subtitle-1',
      videoId: 'video-1',
      filePath: '/video.srt',
      lang: 'ko',
      type: 'srt',
      isEmbedded: false,
    })

    expect(highlights.findByVideoId('video-1')).toMatchObject([
      { timeStart: 3, timeEnd: 5, color: 'red' },
    ])
    expect(subtitles.findByVideoId('video-1')).toMatchObject([
      { filePath: '/video.srt', lang: 'ko', type: 'srt' },
    ])
  })

  it('round-trips JSON settings and falls back for invalid stored JSON', () => {
    const repository = new SettingsRepository(db)
    repository.set('layout', { columns: 4 })
    expect(repository.get('layout', { columns: 1 })).toEqual({ columns: 4 })
    db.prepare("UPDATE settings SET value = 'not-json' WHERE key = 'layout'").run()
    expect(repository.get('layout', { columns: 1 })).toEqual({ columns: 1 })
    repository.delete('layout')
    expect(repository.get('layout', 'default')).toBe('default')
  })
})
