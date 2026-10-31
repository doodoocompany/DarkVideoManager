import type { Database } from 'better-sqlite3'
import type { DailyStats, LibraryStats, StatsDistribution } from '@shared/types'
import { getDatabase } from '../db/connection'

interface VideoRow {
  id: string
  file_path: string
  file_name: string
  duration_sec: number | null
  size_bytes: number | null
  width: number | null
  height: number | null
  container: string | null
  rating: number
  tags: string | null
  play_count: number
  play_time_sec: number
  has_history: number
  highlight_count: number
}

interface SubtitleRow {
  video_id: string
  file_path: string
  lang: string | null
  is_embedded: number
}

interface HistorySummary {
  watched_sec: number
  session_count: number
  unique_videos: number
}

function dateLabel(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function daysBefore(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() - days)
  return result
}

function positive(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function buckets(definitions: Array<[string, string]>): StatsDistribution[] {
  return definitions.map(([key, label]) => ({ key, label, count: 0 }))
}

function increment(distribution: StatsDistribution[], key: string): void {
  const bucket = distribution.find((entry) => entry.key === key)
  if (bucket) bucket.count++
}

function formatKey(video: VideoRow): string {
  const extension = /\.([a-z0-9]{1,10})$/i.exec(video.file_name)?.[1]
  // ffprobe reports format families; the actual extension is a clearer label.
  const format = extension ?? video.container?.split(',')[0]?.trim()
  return format ? format.toLowerCase() : 'unknown'
}

function fileStem(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\.[^/.]+$/, '')
    .toLowerCase()
}

function isGeneratedSubtitle(subtitle: SubtitleRow, video: VideoRow): boolean {
  if (subtitle.is_embedded || !/\.(srt|vtt|ass|smi)$/i.test(subtitle.file_path)) return false
  const stem = fileStem(subtitle.file_path)
  const originalStem = stem.replace(/\.ai(?:\.[1-9]\d*)?(?:\.ko)?$/i, '')
  return originalStem !== stem && originalStem === fileStem(video.file_path)
}

function collectLibrary(
  db: Database,
  now: string,
): Pick<LibraryStats, 'totalVideos' | 'avgRating' | 'library' | 'distributions'> {
  const videos = db
    .prepare(
      `
    SELECT v.id, v.file_path, v.file_name, v.duration_sec, v.size_bytes,
           v.width, v.height, v.container, v.rating, v.tags, v.play_count, v.play_time_sec,
           EXISTS (SELECT 1 FROM play_history ph WHERE ph.video_id = v.id
             AND ph.duration_watched_sec > 0 AND julianday(ph.started_at) <= julianday(?)) AS has_history,
           (SELECT COUNT(*) FROM highlights h WHERE h.video_id = v.id) AS highlight_count
    FROM videos v WHERE v.removal_mode IS NULL
  `,
    )
    .all(now) as VideoRow[]
  const subtitles = db
    .prepare(
      `
    SELECT s.video_id, s.file_path, s.lang, s.is_embedded
    FROM subtitles s JOIN videos v ON v.id = s.video_id WHERE v.removal_mode IS NULL
  `,
    )
    .all() as SubtitleRow[]
  const library: LibraryStats['library'] = {
    totalDurationSec: 0,
    totalSizeBytes: 0,
    durationUnknownVideos: 0,
    sizeUnknownVideos: 0,
    watchedVideos: 0,
    unwatchedVideos: 0,
    ratedVideos: 0,
    subtitleVideos: 0,
    koreanSubtitleVideos: 0,
    generatedSubtitleVideos: 0,
    highlightedVideos: 0,
    highlightCount: 0,
    taggedVideos: 0,
  }
  const ratings = buckets(
    Array.from({ length: 11 }, (_, index) => {
      const rating = index / 2
      return [String(rating), rating ? `${rating}점` : '미평가']
    }),
  )
  const resolutions = buckets([
    ['sd', 'SD'],
    ['720p', 'HD · 720p'],
    ['1080p', 'FHD · 1080p'],
    ['1440p', 'QHD · 1440p'],
    ['4k', '4K 이상'],
    ['unknown', '미확인'],
  ])
  const durations = buckets([
    ['under5', '5분 미만'],
    ['5to20', '5~20분'],
    ['20to60', '20~60분'],
    ['60plus', '60분 이상'],
    ['unknown', '미확인'],
  ])
  const formatCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>()
  let ratingTotal = 0
  for (const video of videos) {
    const duration = positive(video.duration_sec)
    const size = positive(video.size_bytes)
    library.totalDurationSec += duration
    library.totalSizeBytes += size
    if (!duration) library.durationUnknownVideos++
    if (!size) library.sizeUnknownVideos++
    if (video.play_count > 0 || video.play_time_sec > 0 || video.has_history)
      library.watchedVideos++
    else library.unwatchedVideos++
    if (video.rating > 0) {
      library.ratedVideos++
      ratingTotal += video.rating
    }
    increment(ratings, String(video.rating))
    const edge = Math.min(positive(video.width), positive(video.height))
    increment(
      resolutions,
      !edge
        ? 'unknown'
        : edge < 720
          ? 'sd'
          : edge < 1080
            ? '720p'
            : edge < 1440
              ? '1080p'
              : edge < 2160
                ? '1440p'
                : '4k',
    )
    increment(
      durations,
      !duration
        ? 'unknown'
        : duration < 300
          ? 'under5'
          : duration < 1200
            ? '5to20'
            : duration < 3600
              ? '20to60'
              : '60plus',
    )
    const format = formatKey(video)
    formatCounts.set(format, (formatCounts.get(format) ?? 0) + 1)
    const tags = new Set(
      (video.tags ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    )
    if (tags.size) library.taggedVideos++
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    library.highlightCount += video.highlight_count
    if (video.highlight_count > 0) library.highlightedVideos++
  }
  const videoById = new Map(videos.map((video) => [video.id, video]))
  const subtitleIds = new Set<string>()
  const koreanIds = new Set<string>()
  const generatedIds = new Set<string>()
  for (const subtitle of subtitles) {
    subtitleIds.add(subtitle.video_id)
    if (
      /^(ko|kor)([-_].*)?$/i.test(subtitle.lang?.trim() ?? '') ||
      /\.(ko|kor)\.(srt|vtt|ass|smi)$/i.test(subtitle.file_path)
    )
      koreanIds.add(subtitle.video_id)
    const video = videoById.get(subtitle.video_id)
    if (video && isGeneratedSubtitle(subtitle, video)) generatedIds.add(video.id)
  }
  library.subtitleVideos = subtitleIds.size
  library.koreanSubtitleVideos = koreanIds.size
  library.generatedSubtitleVideos = generatedIds.size
  const sortedFormats = [...formatCounts]
    .filter(([key]) => key !== 'unknown')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const formats = sortedFormats
    .slice(0, 6)
    .map(([key, count]) => ({ key, label: key.toUpperCase(), count }))
  const otherFormats = sortedFormats.slice(6).reduce((sum, [, count]) => sum + count, 0)
  if (otherFormats) formats.push({ key: 'other', label: '기타', count: otherFormats })
  formats.push({ key: 'unknown', label: '미확인', count: formatCounts.get('unknown') ?? 0 })
  const tags = [...tagCounts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([key, count]) => ({ key, label: key, count }))
  return {
    totalVideos: videos.length,
    avgRating: library.ratedVideos ? ratingTotal / library.ratedVideos : 0,
    library,
    distributions: { ratings, resolutions, formats, durations, tags },
  }
}

// Retained history includes removed videos. Each session belongs to its local
// start time: the stored row cannot reconstruct duration across midnight/hours.
const historyFrom = `FROM play_history ph JOIN videos v ON v.id = ph.video_id
  WHERE ph.duration_watched_sec > 0
    AND julianday(ph.started_at) >= julianday(@start)
    AND julianday(ph.started_at) <= julianday(@now)`

export function getStats(libraryId: string, days = 30): LibraryStats {
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error('통계 기간은 1~365일 사이의 정수여야 합니다')
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = daysBefore(today, days - 1)
  const previousStart = daysBefore(start, days)
  const bounds = { start: start.toISOString(), now: now.toISOString() }

  return db.transaction(() => {
    const current = db
      .prepare(
        `SELECT COALESCE(SUM(ph.duration_watched_sec), 0) AS watched_sec,
      COUNT(*) AS session_count, COUNT(DISTINCT ph.video_id) AS unique_videos ${historyFrom}`,
      )
      .get(bounds) as HistorySummary
    const previous = db
      .prepare(
        `SELECT COALESCE(SUM(ph.duration_watched_sec), 0) AS watched_sec,
      COUNT(*) AS session_count ${historyFrom} AND julianday(ph.started_at) < julianday(@end)`,
      )
      .get({
        start: previousStart.toISOString(),
        now: bounds.now,
        end: bounds.start,
      }) as HistorySummary
    const total = db
      .prepare(
        `SELECT COALESCE(SUM(ph.duration_watched_sec), 0) AS watched_sec
      FROM play_history ph JOIN videos v ON v.id = ph.video_id
      WHERE ph.duration_watched_sec > 0 AND julianday(ph.started_at) <= julianday(?)`,
      )
      .get(bounds.now) as { watched_sec: number }
    const dailyRows = db
      .prepare(
        `SELECT date(ph.started_at, 'localtime') AS date,
      SUM(ph.duration_watched_sec) AS watched_sec, COUNT(DISTINCT ph.video_id) AS video_count,
      COUNT(*) AS session_count ${historyFrom} GROUP BY date(ph.started_at, 'localtime')`,
      )
      .all(bounds) as Array<{
      date: string
      watched_sec: number
      video_count: number
      session_count: number
    }>
    const dailyByDate = new Map(dailyRows.map((row) => [row.date, row]))
    const dailyStats: DailyStats[] = Array.from({ length: days }, (_, index) => {
      const date = dateLabel(daysBefore(start, -index))
      const row = dailyByDate.get(date)
      return {
        date,
        watchedSec: row?.watched_sec ?? 0,
        videoCount: row?.video_count ?? 0,
        sessionCount: row?.session_count ?? 0,
      }
    })
    const timeRows = db
      .prepare(
        `SELECT CAST(strftime('%w', ph.started_at, 'localtime') AS INTEGER) AS weekday,
      CAST(strftime('%H', ph.started_at, 'localtime') AS INTEGER) AS hour,
      SUM(ph.duration_watched_sec) AS watched_sec, COUNT(*) AS session_count
      ${historyFrom} GROUP BY weekday, hour`,
      )
      .all(bounds) as Array<{
      weekday: number
      hour: number
      watched_sec: number
      session_count: number
    }>
    const weekdayStats = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      watchedSec: 0,
      sessionCount: 0,
    }))
    const hourlyStats = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      watchedSec: 0,
      sessionCount: 0,
    }))
    for (const row of timeRows) {
      weekdayStats[row.weekday].watchedSec += row.watched_sec
      weekdayStats[row.weekday].sessionCount += row.session_count
      hourlyStats[row.hour].watchedSec += row.watched_sec
      hourlyStats[row.hour].sessionCount += row.session_count
    }
    const topVideos = (
      db
        .prepare(
          `SELECT v.id, v.file_name, v.title,
      SUM(ph.duration_watched_sec) AS watched_sec, COUNT(*) AS session_count ${historyFrom}
      AND v.removal_mode IS NULL GROUP BY v.id ORDER BY watched_sec DESC, v.id ASC LIMIT 10`,
        )
        .all(bounds) as Array<{
        id: string
        file_name: string
        title: string | null
        watched_sec: number
        session_count: number
      }>
    ).map((row) => ({
      id: row.id,
      fileName: row.file_name,
      title: row.title ?? undefined,
      watchedSec: row.watched_sec,
      sessionCount: row.session_count,
    }))
    const { count: addedVideos } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM videos
      WHERE removal_mode IS NULL AND julianday(created_at) >= julianday(@start)
        AND julianday(created_at) <= julianday(@now)`,
      )
      .get(bounds) as { count: number }
    let activeDays = 0
    let longestStreak = 0
    let streak = 0
    for (const day of dailyStats) {
      if (day.sessionCount > 0) {
        activeDays++
        longestStreak = Math.max(longestStreak, ++streak)
      } else streak = 0
    }
    return {
      ...collectLibrary(db, bounds.now),
      totalWatchedSec: total.watched_sec,
      period: {
        days,
        startDate: dateLabel(start),
        endDate: dateLabel(today),
        watchedSec: current.watched_sec,
        previousWatchedSec: previous.watched_sec,
        sessionCount: current.session_count,
        previousSessionCount: previous.session_count,
        uniqueVideos: current.unique_videos,
        activeDays,
        averageSessionSec: current.session_count ? current.watched_sec / current.session_count : 0,
        longestStreak,
        addedVideos,
      },
      dailyStats,
      weekdayStats,
      hourlyStats,
      topVideos,
    }
  })()
}
