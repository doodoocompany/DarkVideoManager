import { shell, type WebContents } from 'electron'
import { lstat } from 'fs/promises'
import { accessSync, constants } from 'fs'
import type { Database } from 'better-sqlite3'
import { needsPlaybackProxy } from '../ffmpeg/playback.js'
import { enqueuePlaybackConversion } from './PlaybackConversionService'
import {
  assertNativePlayerLaunchGeneration,
  findNativePlayer,
  getNativePlayerLaunchGeneration,
  openInNativePlayer,
} from './NativePlayerService'
import { openInMpv, seekMpvSession } from './MpvSessionService.js'
import type { NativePlayerOptions, NativePlayerInfo } from '@shared/types'
import { endPlayback } from './PlaybackService'
import { getDatabase } from '../db/connection'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { SearchQuery, SearchResult, Video, VideoMeta, VideoMetadataOptions } from '@shared/types'
import { purgeVideoPlaybackCache, beginPlaybackCacheLease, trimPlaybackCache } from './CacheService'
import { createLogger } from '../infra/logger'
import { acquireSourceFile } from './SourceFileUsage'

const log = createLogger('VideoService')

export function searchVideos(libraryId: string, query: SearchQuery): SearchResult {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  return new VideoRepository(db).search(query)
}

export function getVideoMetadataOptions(libraryId: string, removed = false): VideoMetadataOptions {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  return new VideoRepository(db).metadataOptions(removed)
}

export function getVideo(libraryId: string, videoId: string): Video | null {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  return new VideoRepository(db).findById(videoId)
}

export function updateVideoMeta(libraryId: string, videoId: string, meta: VideoMeta): void {
  const db = getDatabase(libraryId)
  if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
  new VideoRepository(db).updateMeta(videoId, meta)
}

const pendingRemovals = new Set<string>()

function assertWritable(db: Database): void {
  if (db.readonly || db.pragma('query_only', { simple: true }))
    throw new Error('Library is read-only')
}

async function assertVideoFile(filePath: string): Promise<void> {
  const info = await lstat(filePath)
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error('The selected path is not a file')
}

function assertReadableVideo(filePath: string): void {
  try {
    accessSync(filePath, constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(
        '영상 원본 파일을 찾을 수 없습니다. 외장 드라이브 또는 네트워크 드라이브 연결과 파일 위치를 확인한 뒤 다시 시도해 주세요.',
        { cause: error },
      )
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error('영상 원본 파일을 읽을 권한이 없습니다. 파일 접근 권한을 확인해 주세요.', {
        cause: error,
      })
    }
    throw error
  }
}

export async function deleteVideo(
  libraryId: string,
  videoId: string,
  mode: 'trash' | 'remove' = 'trash',
): Promise<void> {
  if (mode !== 'trash' && mode !== 'remove') throw new Error('Invalid removal mode')
  const key = JSON.stringify([libraryId, videoId])
  if (pendingRemovals.has(key)) throw new Error('영상 제거 또는 복원이 진행 중입니다')
  pendingRemovals.add(key)
  try {
    const db = getDatabase(libraryId)
    if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
    // Check before filesystem operations. A failed trash operation leaves every DB row intact.
    assertWritable(db)
    const repository = new VideoRepository(db)
    const video = repository.findById(videoId)
    if (!video) throw new Error('Video not found')
    if (video.removalMode) return
    if (mode === 'trash') {
      await assertVideoFile(video.filePath)
      await shell.trashItem(video.filePath)
    }
    try {
      repository.markRemoved(videoId, mode)
    } catch (error) {
      if (mode === 'trash') {
        throw new Error(
          '파일은 휴지통으로 이동했지만 목록 상태를 저장하지 못했습니다. 메타데이터는 보존되어 있습니다. ' +
            (error as Error).message,
          { cause: error },
        )
      }
      throw error
    }
    void purgeVideoPlaybackCache(libraryId, videoId).catch((error) =>
      log.warn({ error }, '제거한 영상의 캐시 정리 실패'),
    )
  } finally {
    pendingRemovals.delete(key)
  }
}

export async function restoreVideo(libraryId: string, videoId: string): Promise<void> {
  const key = JSON.stringify([libraryId, videoId])
  if (pendingRemovals.has(key)) throw new Error('영상 제거 또는 복원이 진행 중입니다')
  pendingRemovals.add(key)
  try {
    const db = getDatabase(libraryId)
    if (!db) throw new Error('라이브러리가 열려 있지 않습니다')
    assertWritable(db)
    const repository = new VideoRepository(db)
    const video = repository.findById(videoId)
    if (!video) throw new Error('Video not found')
    await assertVideoFile(video.filePath)
    repository.restore(videoId)
  } finally {
    pendingRemovals.delete(key)
  }
}

export async function getPlaybackSource(libraryId: string, videoId: string): Promise<string> {
  const video = getVideo(libraryId, videoId)
  if (!video) throw new Error('Video not found')
  if (video.removalMode) throw new Error('제거한 항목은 목록 복구 후 재생할 수 있습니다.')
  assertReadableVideo(video.filePath)
  if (!needsPlaybackProxy(video.filePath, video.codec)) return video.filePath
  const lease = beginPlaybackCacheLease(libraryId, videoId)
  try {
    const source = await enqueuePlaybackConversion(libraryId, video)
    lease(source)
    void trimPlaybackCache().catch((error) => log.warn({ error }, '재생 캐시 정리 실패'))
    return source
  } catch (error) {
    lease.rollback()
    throw error
  }
}
export function getNativePlayerInfo(): Promise<NativePlayerInfo | null> {
  return findNativePlayer()
}
export async function openVideoInNativePlayer(
  libraryId: string,
  videoId: string,
  webContents: WebContents,
  options: NativePlayerOptions = {},
): Promise<NativePlayerInfo> {
  const generation = getNativePlayerLaunchGeneration()
  const video = getVideo(libraryId, videoId)
  if (!video) throw new Error('Video not found')
  if (video.removalMode) throw new Error('제거한 항목은 목록 복구 후 재생할 수 있습니다.')
  assertReadableVideo(video.filePath)
  const release = acquireSourceFile(video.filePath)
  try {
    const player = await findNativePlayer()
    assertNativePlayerLaunchGeneration(generation)
    if (!player) throw new Error('No native player found. Install mpv, ffplay, or VLC.')
    if (player.name === 'mpv') {
      await openInMpv(
        player.path,
        libraryId,
        video,
        options.startTimeSec ?? 0,
        options.width,
        options.height,
        options.x,
        options.y,
        webContents,
        options.playbackRate,
      )
      return player
    }
    const opened = await openInNativePlayer(video.filePath, options, player)
    endPlayback(libraryId, videoId, options.startTimeSec ?? video.resumePosSec)
    return opened
  } finally {
    release()
  }
}
export async function seekActivePlayback(
  libraryId: string,
  videoId: string,
  timeSec: number,
): Promise<boolean> {
  return seekMpvSession(libraryId, videoId, timeSec)
}
