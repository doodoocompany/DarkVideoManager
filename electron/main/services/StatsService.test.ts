import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAllDatabases, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { getStats } from './StatsService'

let db: Database
let sequence = 0
const now = new Date(2026, 9, 10, 12, 34, 56)
const local = (month: number, day: number, hour = 0, minute = 0, second = 0) =>
  new Date(2026, month - 1, day, hour, minute, second).toISOString()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  db = openDatabase('stats-test', ':memory:')
  runMigrations(db, ':memory:')
  sequence = 0
})

afterEach(() => {
  closeAllDatabases()
  vi.useRealTimers()
})

type VideoValues = {
  fileName?: string
  duration?: number | null
  size?: number | null
  width?: number | null
  height?: number | null
  container?: string | null
  rating?: number
  tags?: string
  count?: number
  time?: number
  createdAt?: string
  removed?: 'trash' | 'remove'
  title?: string
}

function video(id: string, values: VideoValues = {}): void {
  const fileName = values.fileName ?? `${id}.mp4`
  db.prepare(
    `INSERT INTO videos (id, file_path, file_name, duration_sec, size_bytes,
    width, height, container, rating, tags, play_count, play_time_sec, created_at, removal_mode, title)
    VALUES (@id, @filePath, @fileName, @duration, @size, @width, @height, @container,
      @rating, @tags, @count, @time, @createdAt, @removed, @title)`,
  ).run({
    id,
    fileName,
    filePath: `C:/videos/${fileName}`,
    duration: values.duration ?? null,
    size: values.size ?? null,
    width: values.width ?? null,
    height: values.height ?? null,
    container: values.container ?? null,
    rating: values.rating ?? 0,
    tags: values.tags ?? '',
    count: values.count ?? 0,
    time: values.time ?? 0,
    createdAt: values.createdAt ?? local(9, 1),
    removed: values.removed ?? null,
    title: values.title ?? null,
  })
}

function history(videoId: string, startedAt: string, duration: number | null): void {
  db.prepare(
    `INSERT INTO play_history (id, video_id, started_at, duration_watched_sec)
    VALUES (?, ?, ?, ?)`,
  ).run(`history-${sequence++}`, videoId, startedAt, duration)
}

function subtitle(
  videoId: string,
  path: string,
  lang: string | null = null,
  embedded = false,
): void {
  db.prepare(
    `INSERT INTO subtitles (id, video_id, file_path, lang, type, is_embedded)
    VALUES (?, ?, ?, ?, 'srt', ?)`,
  ).run(`subtitle-${sequence++}`, videoId, path, lang, Number(embedded))
}

function countMap(rows: Array<{ key: string; count: number }>): Record<string, number> {
  return Object.fromEntries(rows.map(({ key, count }) => [key, count]))
}

describe('library statistics', () => {
  it('returns complete zero-filled empty charts and validates the supported window', () => {
    const stats = getStats('stats-test', 7)
    expect(stats).toMatchObject({ totalVideos: 0, totalWatchedSec: 0, avgRating: 0, topVideos: [] })
    expect(stats.period).toEqual({
      days: 7,
      startDate: '2026-10-04',
      endDate: '2026-10-10',
      watchedSec: 0,
      previousWatchedSec: 0,
      sessionCount: 0,
      previousSessionCount: 0,
      uniqueVideos: 0,
      activeDays: 0,
      averageSessionSec: 0,
      longestStreak: 0,
      addedVideos: 0,
    })
    expect(stats.dailyStats).toHaveLength(7)
    expect(stats.dailyStats[0]).toEqual({
      date: '2026-10-04',
      watchedSec: 0,
      videoCount: 0,
      sessionCount: 0,
    })
    expect(stats.weekdayStats).toHaveLength(7)
    expect(stats.hourlyStats).toHaveLength(24)
    expect(stats.weekdayStats[0]).toEqual({ weekday: 0, watchedSec: 0, sessionCount: 0 })
    expect(stats.hourlyStats[23]).toEqual({ hour: 23, watchedSec: 0, sessionCount: 0 })
    expect(getStats('stats-test', 365).dailyStats).toHaveLength(365)
    for (const days of [0, -1, 366, 7.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => getStats('stats-test', days)).toThrow('1~365일')
    }
    expect(() => getStats('closed-library')).toThrow('열려 있지 않습니다')
  })

  it('uses inclusive local dates, previous N days, positive sessions, and excludes future records', () => {
    video('a', { title: '영상 A', createdAt: local(10, 4) })
    video('b')
    video('removed', { removed: 'trash', createdAt: local(10, 9) })
    video('new-today', { createdAt: now.toISOString() })
    video('future', { createdAt: new Date(now.getTime() + 1).toISOString() })
    history('a', local(10, 4), 10)
    history('a', local(10, 4, 23, 59, 59), 20)
    history('a', local(10, 5, 9), 30)
    history('a', local(10, 6, 10), 40)
    history('a', local(10, 8, 8), 50)
    history('a', now.toISOString(), 60)
    history('b', local(10, 6, 11), 20)
    history('removed', local(10, 9, 18), 90)
    history('a', local(9, 27), 5)
    history('a', local(10, 3, 23, 59, 59), 15)
    history('a', local(9, 26, 23, 59, 59), 30)
    history('a', new Date(now.getTime() + 1).toISOString(), 10_000)
    history('a', local(10, 11), 10_000)
    history('a', local(10, 7), 0)
    history('a', local(10, 7), null)
    history('a', local(10, 7), -10)
    const stats = getStats('stats-test', 7)
    expect(stats.totalWatchedSec).toBe(370)
    expect(stats.period).toEqual({
      days: 7,
      startDate: '2026-10-04',
      endDate: '2026-10-10',
      watchedSec: 320,
      previousWatchedSec: 20,
      sessionCount: 8,
      previousSessionCount: 2,
      uniqueVideos: 3,
      activeDays: 6,
      averageSessionSec: 40,
      longestStreak: 3,
      addedVideos: 2,
    })
    expect(stats.dailyStats.map((day) => day.watchedSec)).toEqual([30, 30, 60, 0, 50, 90, 60])
    expect(stats.dailyStats[0].videoCount).toBe(1)
    expect(stats.dailyStats[2]).toMatchObject({ videoCount: 2, sessionCount: 2 })
    expect(stats.weekdayStats[0]).toEqual({ weekday: 0, watchedSec: 30, sessionCount: 2 })
    expect(stats.hourlyStats[0]).toEqual({ hour: 0, watchedSec: 10, sessionCount: 1 })
    expect(stats.hourlyStats[23]).toEqual({ hour: 23, watchedSec: 20, sessionCount: 1 })
    expect(stats.topVideos).toEqual([
      { id: 'a', fileName: 'a.mp4', title: '영상 A', watchedSec: 210, sessionCount: 6 },
      { id: 'b', fileName: 'b.mp4', title: undefined, watchedSec: 20, sessionCount: 1 },
    ])
    expect(getStats('stats-test', 1).period).toMatchObject({
      startDate: '2026-10-10',
      watchedSec: 60,
      previousWatchedSec: 90,
      sessionCount: 1,
    })
  })

  it('retains removed-video history without counting the video in current holdings or rankings', () => {
    video('removed', {
      removed: 'remove',
      duration: 100,
      size: 400,
      rating: 5,
      tags: '삭제',
      createdAt: local(10, 10),
    })
    history('removed', local(10, 10), 90)
    subtitle('removed', 'C:/videos/removed.ai.ko.srt')
    db.prepare('INSERT INTO highlights (id, video_id, time_start) VALUES (?, ?, 0)').run(
      'h',
      'removed',
    )
    const stats = getStats('stats-test')
    expect(stats).toMatchObject({
      totalVideos: 0,
      totalWatchedSec: 90,
      avgRating: 0,
      topVideos: [],
    })
    expect(stats.period).toMatchObject({
      watchedSec: 90,
      sessionCount: 1,
      uniqueVideos: 1,
      addedVideos: 0,
    })
    expect(Object.values(stats.library).every((value) => value === 0)).toBe(true)
    expect(stats.distributions.tags).toEqual([])
    expect(stats.distributions.ratings.every((entry) => entry.count === 0)).toBe(true)
  })

  it('classifies portrait resolutions, duration boundaries, unknown metadata, and imported playback', () => {
    video('sd', { width: 792, height: 592, duration: 299, size: 10, rating: 5, count: 7 })
    video('hd', { width: 720, height: 1280, duration: 300, size: 20, rating: 3, time: 10 })
    video('fhd', { width: 1920, height: 1080, duration: 1200, size: 30 })
    video('qhd', { width: 1440, height: 2560, duration: 3600, size: 40 })
    video('4k', { width: 2160, height: 3840, duration: 3601, size: 50 })
    video('partial', { width: 1920, height: null, duration: 0, size: 0 })
    video('negative', { width: -100, height: 1080, duration: -1, size: -1 })
    video('missing')
    history('fhd', local(10, 10), 5)
    // A genuine history still identifies a watched video if old metadata was not populated.
    db.prepare("UPDATE videos SET play_count = 0, play_time_sec = 0 WHERE id = 'fhd'").run()
    const stats = getStats('stats-test')
    expect(stats.avgRating).toBe(4)
    expect(stats.totalWatchedSec).toBe(5)
    expect(stats.library).toMatchObject({
      ratedVideos: 2,
      watchedVideos: 3,
      unwatchedVideos: 5,
      totalSizeBytes: 150,
      totalDurationSec: 9000,
      sizeUnknownVideos: 3,
      durationUnknownVideos: 3,
    })
    expect(countMap(stats.distributions.resolutions)).toEqual({
      sd: 1,
      '720p': 1,
      '1080p': 1,
      '1440p': 1,
      '4k': 1,
      unknown: 3,
    })
    expect(countMap(stats.distributions.durations)).toEqual({
      under5: 1,
      '5to20': 1,
      '20to60': 1,
      '60plus': 2,
      unknown: 3,
    })
    expect(countMap(stats.distributions.ratings)).toEqual({
      0: 6,
      0.5: 0,
      1: 0,
      1.5: 0,
      2: 0,
      2.5: 0,
      3: 1,
      3.5: 0,
      4: 0,
      4.5: 0,
      5: 1,
    })
  })

  it('includes half-star ratings in the distribution and average', () => {
    video('half', { rating: 0.5 })
    video('four-half', { rating: 4.5 })
    video('whole', { rating: 4 })
    video('unrated')
    const stats = getStats('stats-test')
    expect(stats.avgRating).toBe(3)
    expect(stats.library.ratedVideos).toBe(3)
    expect(stats.distributions.ratings).toContainEqual({ key: '0.5', label: '0.5점', count: 1 })
    expect(stats.distributions.ratings).toContainEqual({ key: '4.5', label: '4.5점', count: 1 })
    expect(stats.distributions.ratings.reduce((total, bucket) => total + bucket.count, 0)).toBe(4)
  })

  it('counts unique subtitle coverage and only actual generated-sidecar naming patterns', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'named.ai']) video(id)
    subtitle('a', 'C:\\videos\\a.ai.srt')
    subtitle('a', 'C:/videos/a.ai.2.ko.srt')
    subtitle('a', 'C:/videos/a.ai.3.ko.srt')
    subtitle('b', 'embedded:stream2', 'ko-KR', true)
    subtitle('c', 'C:/videos/c.ko.srt')
    subtitle('d', 'C:/videos/other.ai.srt')
    subtitle('e', 'C:/videos/e.ai.0.srt')
    subtitle('f', 'C:/videos/f.srt', 'kor')
    subtitle('named.ai', 'C:/videos/named.ai.srt')
    db.prepare('INSERT INTO highlights (id, video_id, time_start) VALUES (?, ?, 0)').run('h1', 'a')
    db.prepare('INSERT INTO highlights (id, video_id, time_start) VALUES (?, ?, 0)').run('h2', 'a')
    db.prepare('INSERT INTO highlights (id, video_id, time_start) VALUES (?, ?, 0)').run('h3', 'b')
    expect(getStats('stats-test').library).toMatchObject({
      subtitleVideos: 7,
      koreanSubtitleVideos: 4,
      generatedSubtitleVideos: 1,
      highlightedVideos: 2,
      highlightCount: 3,
    })
  })

  it('groups format tails, prefers extensions over ffprobe families, and deduplicates per-video tags', () => {
    const extensions = ['mp4', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'mpeg', 'flv']
    extensions.forEach((extension, index) =>
      video(`v${index}`, {
        fileName: `v${index}.${extension}`,
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        tags: index === 0 ? ' 여행, 여행,음악, , ' : index === 1 ? '음악' : '',
      }),
    )
    video('fallback', { fileName: 'no-extension', container: 'matroska,webm' })
    video('unknown', { fileName: 'no-format', tags: ' , ' })
    const stats = getStats('stats-test')
    expect(stats.distributions.formats[0]).toEqual({ key: 'mp4', label: 'MP4', count: 2 })
    expect(stats.distributions.formats.find((entry) => entry.key === 'other')?.count).toBe(3)
    expect(stats.distributions.formats.find((entry) => entry.key === 'unknown')?.count).toBe(1)
    expect(stats.distributions.formats.reduce((sum, entry) => sum + entry.count, 0)).toBe(11)
    expect(stats.distributions.tags).toEqual([
      { key: '음악', label: '음악', count: 2 },
      { key: '여행', label: '여행', count: 1 },
    ])
    expect(stats.library.taggedVideos).toBe(2)
  })

  it('ranks only positive plays in the selected window, breaks ties predictably, and limits to ten', () => {
    for (let index = 0; index < 12; index++) {
      const id = `video-${String(index).padStart(2, '0')}`
      video(id)
      history(id, local(10, 10), 10)
    }
    video('old')
    history('old', local(9, 1), 100_000)
    video('never-watched')
    history('never-watched', local(10, 10), 0)
    const stats = getStats('stats-test', 7)
    expect(stats.topVideos).toHaveLength(10)
    expect(stats.topVideos[0].id).toBe('video-00')
    expect(stats.topVideos[9].id).toBe('video-09')
    expect(stats.period).toMatchObject({ watchedSec: 120, sessionCount: 12, uniqueVideos: 12 })
  })

  it('keeps statistics scoped to the requested library database', () => {
    const other = openDatabase('other-library', ':memory:')
    runMigrations(other, ':memory:')
    other
      .prepare(
        "INSERT INTO videos (id, file_path, file_name) VALUES ('other', 'other.mp4', 'other.mp4')",
      )
      .run()
    other
      .prepare(
        'INSERT INTO play_history (id, video_id, started_at, duration_watched_sec) VALUES (?, ?, ?, ?)',
      )
      .run('other-history', 'other', now.toISOString(), 500)
    expect(getStats('stats-test').totalVideos).toBe(0)
    expect(getStats('stats-test').totalWatchedSec).toBe(0)
    expect(getStats('other-library').totalWatchedSec).toBe(500)
  })
})
