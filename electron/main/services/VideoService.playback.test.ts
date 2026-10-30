import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  codec: undefined as string | undefined,
  ensureProxy: vi.fn(),
  access: vi.fn(),
  findPlayer: vi.fn(),
  pin: Object.assign(vi.fn(), { rollback: vi.fn() }),
}))
vi.mock('electron', () => ({ shell: {} }))
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  accessSync: state.access,
}))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock('../infra/paths', () => ({ getPlaybackProxyDir: () => 'proxy-directory' }))
vi.mock('../db/connection', () => ({ getDatabase: () => ({}) }))
vi.mock('../db/repositories/VideoRepository', () => ({
  VideoRepository: class {
    findById(id: string) {
      return { id, filePath: 'movie.mp4', codec: state.codec }
    }
  },
}))
vi.mock('../ffmpeg/playback.js', async () => {
  const { needsCompatiblePlayback } = await import('@shared/playback')
  return { needsPlaybackProxy: needsCompatiblePlayback, ensurePlaybackProxy: state.ensureProxy }
})
vi.mock('./PlaybackConversionService', () => ({ enqueuePlaybackConversion: state.ensureProxy }))
vi.mock('./NativePlayerService', () => ({
  findNativePlayer: state.findPlayer,
  openInNativePlayer: vi.fn(),
  getNativePlayerLaunchGeneration: () => 0,
  assertNativePlayerLaunchGeneration: vi.fn(),
}))
vi.mock('./MpvSessionService.js', () => ({ openInMpv: vi.fn(), seekMpvSession: vi.fn() }))
vi.mock('./PlaybackService', () => ({ endPlayback: vi.fn() }))
vi.mock('./CacheService', () => ({
  beginPlaybackCacheLease: () => state.pin,
  purgeVideoPlaybackCache: vi.fn(),
  trimPlaybackCache: vi.fn().mockResolvedValue(undefined),
}))

import { getPlaybackSource, openVideoInNativePlayer } from './VideoService'
import type { WebContents } from 'electron'

beforeEach(() => {
  vi.clearAllMocks()
  state.codec = undefined
  state.access.mockReset()
  state.ensureProxy.mockResolvedValue('proxy-directory/video.v3.mp4')
})

describe('playback source selection', () => {
  it.each(['h264', 'mpeg4'])(
    'reports a missing source before playing or converting %s',
    async (codec) => {
      state.codec = codec
      state.access.mockImplementation(() => {
        throw Object.assign(new Error('missing drive'), { code: 'ENOENT' })
      })
      await expect(getPlaybackSource('library', 'video')).rejects.toThrow(
        '드라이브 연결과 파일 위치',
      )
      expect(state.ensureProxy).not.toHaveBeenCalled()
      expect(state.pin).not.toHaveBeenCalled()
    },
  )

  it('reports access permissions separately and succeeds after the source becomes accessible', async () => {
    state.access.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    await expect(getPlaybackSource('library', 'video')).rejects.toThrow('읽을 권한이 없습니다')
    expect(await getPlaybackSource('library', 'video')).toBe('movie.mp4')
  })

  it('does not launch an external player for a missing source', async () => {
    state.access.mockImplementation(() => {
      throw Object.assign(new Error('missing drive'), { code: 'ENOENT' })
    })
    await expect(openVideoInNativePlayer('library', 'video', {} as WebContents)).rejects.toThrow(
      '원본 파일을 찾을 수 없습니다',
    )
    expect(state.findPlayer).not.toHaveBeenCalled()
  })

  it('uses a compatible proxy for an MP4 containing MPEG-4 Part 2 video', async () => {
    state.codec = 'mpeg4'
    expect(await getPlaybackSource('library', 'video')).toBe('proxy-directory/video.v3.mp4')
    expect(state.ensureProxy).toHaveBeenCalledWith('library', {
      id: 'video',
      filePath: 'movie.mp4',
      codec: 'mpeg4',
    })
    expect(state.pin).toHaveBeenCalledWith('proxy-directory/video.v3.mp4')
  })

  it.each(['h264', undefined, 'unknown'])(
    'keeps direct MP4 playback with codec %s',
    async (codec) => {
      state.codec = codec
      expect(await getPlaybackSource('library', 'video')).toBe('movie.mp4')
      expect(state.ensureProxy).not.toHaveBeenCalled()
      expect(state.pin).not.toHaveBeenCalled()
    },
  )
})
