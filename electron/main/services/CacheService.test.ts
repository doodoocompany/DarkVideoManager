import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userData: '',
  limitGb: undefined as number | undefined,
  ensureProxy: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))
vi.mock('../infra/config', () => ({
  loadConfig: () => ({ libraries: [], cacheLimitGb: state.limitGb }),
}))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock('../ffmpeg/playback.js', () => ({
  needsPlaybackProxy: () => true,
}))
vi.mock('./PlaybackConversionService', () => ({ enqueuePlaybackConversion: state.ensureProxy }))
vi.mock('../db/connection', () => ({ getDatabase: () => ({}) }))
vi.mock('../db/repositories/VideoRepository', () => ({
  VideoRepository: class {
    findById(id: string) {
      return { id, filePath: path.join(state.userData, 'synthetic.avi') }
    }
  },
}))
vi.mock('./NativePlayerService', () => ({ findNativePlayer: vi.fn(), openInNativePlayer: vi.fn() }))
vi.mock('./MpvSessionService.js', () => ({ openInMpv: vi.fn(), seekMpvSession: vi.fn() }))

import {
  beginPlaybackCacheLease,
  cleanPlaybackCache,
  getCacheInfo,
  protectPlaybackCache,
  purgeVideoPlaybackCache,
  releasePlaybackCache,
  trimPlaybackCache,
} from './CacheService'
import { getPlaybackSource } from './VideoService'

let fixture: string
let library: string

function write(relative: string, content = 'file', time?: number): string {
  const filePath = path.join(state.userData, relative)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  if (time !== undefined) fs.utimesSync(filePath, time, time)
  return filePath
}

function proxy(name: string, content = 'file', time?: number): string {
  return write('playback-proxies/library/' + name, content, time)
}

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(tmpdir(), 'dvm-cache-test-'))
  state.userData = path.join(fixture, 'user-data')
  state.limitGb = undefined
  state.ensureProxy.mockReset()
  library = path.join(state.userData, 'playback-proxies/library')
  fs.mkdirSync(library, { recursive: true })
  fs.writeFileSync(path.join(state.userData, 'synthetic.avi'), 'source media')
})

afterEach(() => {
  for (const id of ['video', 'video:generation', 'playing', 'second'])
    releasePlaybackCache('library', id)
  vi.restoreAllMocks()
  const resolved = path.resolve(fixture)
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith('dvm-cache-test-')
  ) {
    throw new Error('Unsafe test cleanup path')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
})

describe('playback cache safety and eviction', () => {
  it('keeps an existing playback pin when refreshing its source fails', async () => {
    const video = proxy('video.v3.mp4', 'playing proxy')
    const playing = beginPlaybackCacheLease('library', 'video')
    playing(video)
    state.ensureProxy.mockRejectedValueOnce(new Error('original drive disconnected'))
    await expect(getPlaybackSource('library', 'video')).rejects.toThrow('drive disconnected')
    expect((await cleanPlaybackCache()).removedFiles).toBe(0)
    expect((await getCacheInfo()).protectedBytes).toBe(13)
    expect(fs.existsSync(video)).toBe(true)
    expect(playing.release()).toBe(true)
    expect((await cleanPlaybackCache()).removedFiles).toBe(1)
  })

  it('does not restore the old playback pin if the player ends before source refresh fails', async () => {
    const video = proxy('video.v3.mp4')
    const playing = beginPlaybackCacheLease('library', 'video')
    playing(video)
    let fail!: (error: Error) => void
    state.ensureProxy.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    const request = getPlaybackSource('library', 'video')
    const rejected = expect(request).rejects.toThrow('conversion failed')
    expect(releasePlaybackCache('library', 'video')).toBe(true)
    fail(new Error('conversion failed'))
    await rejected
    expect((await getCacheInfo()).protectedBytes).toBe(0)
    expect(playing(video)).toBe(false)
    expect((await cleanPlaybackCache()).removedFiles).toBe(1)
  })

  it.each(['older-first', 'newer-first'])(
    'rolls back overlapping failures in %s order to the last valid owner',
    async (order) => {
      const video = proxy('video.v3.mp4')
      const playing = beginPlaybackCacheLease('library', 'video')
      playing(video)
      const older = beginPlaybackCacheLease('library', 'video')
      const newer = beginPlaybackCacheLease('library', 'video')
      if (order === 'older-first') {
        expect(older.rollback()).toBe(false)
        expect(newer.rollback()).toBe(true)
      } else {
        expect(newer.rollback()).toBe(true)
        expect(older.rollback()).toBe(true)
      }
      expect((await cleanPlaybackCache()).removedFiles).toBe(0)
      expect(playing.release()).toBe(true)
      expect((await cleanPlaybackCache()).removedFiles).toBe(1)
    },
  )

  it('does not restore a failed pending reservation or overwrite a newer successful owner', async () => {
    const video = proxy('video.v3.mp4')
    const first = beginPlaybackCacheLease('library', 'video')
    const second = beginPlaybackCacheLease('library', 'video')
    first.rollback()
    second.rollback()
    expect((await getCacheInfo()).protectedBytes).toBe(0)
    const oldRequest = beginPlaybackCacheLease('library', 'video')
    const latest = beginPlaybackCacheLease('library', 'video')
    latest(video)
    expect(oldRequest.rollback()).toBe(false)
    expect((await cleanPlaybackCache()).removedFiles).toBe(0)
    latest.release()
    expect((await cleanPlaybackCache()).removedFiles).toBe(1)
  })

  it('counts only managed cache files, protects output/fingerprint/temp together, and leaves media data alone', async () => {
    const video = proxy('video.v3.mp4', '12345')
    const fingerprint = proxy('video.v3.mp4.source.json', '123')
    const temporary = proxy('video.v3.mp4.tmp', '12')
    const stale = proxy('orphan.v1.mp4.tmp', '1234')
    const externalFiles = [
      'media/original.avi',
      'thumbnails/library/one.jpg',
      'captures/one.jpg',
      'libs/library.db',
    ].map((name) => write(name, 'keep'))
    protectPlaybackCache('library', 'video', video)
    expect(await getCacheInfo()).toEqual({
      usedBytes: 14,
      protectedBytes: 10,
      fileCount: 4,
      limitBytes: 10 * 1024 ** 3,
    })
    expect(await cleanPlaybackCache()).toMatchObject({
      removedBytes: 4,
      removedFiles: 1,
      info: { usedBytes: 10, protectedBytes: 10 },
    })
    expect(fs.existsSync(stale)).toBe(false)
    expect([video, fingerprint, temporary, ...externalFiles].every(fs.existsSync)).toBe(true)
    expect(releasePlaybackCache('library', 'video')).toBe(true)
    expect(releasePlaybackCache('library', 'video')).toBe(false)
    expect(await cleanPlaybackCache()).toMatchObject({
      removedFiles: 3,
      removedBytes: 10,
      info: { fileCount: 0 },
    })
    expect(fs.existsSync(library)).toBe(true)
    expect(externalFiles.every(fs.existsSync)).toBe(true)
  })

  it('evicts least recently used groups first and allows protected bytes to exceed the cap', async () => {
    state.limitGb = 12 / 1024 ** 3
    const oldest = proxy('old.v1.mp4', '123456', 100)
    const metadata = proxy('old.v1.mp4.source.json', '12', 100)
    const recent = proxy('recent.v3.mp4', '123456', 200)
    const playing = proxy('playing.v3.mp4', '1234', 50)
    protectPlaybackCache('library', 'playing', playing)
    expect(await trimPlaybackCache()).toMatchObject({
      removedBytes: 8,
      removedFiles: 2,
      info: { usedBytes: 10, protectedBytes: 4 },
    })
    expect(fs.existsSync(oldest)).toBe(false)
    expect(fs.existsSync(metadata)).toBe(false)
    expect(fs.existsSync(recent)).toBe(true)
    state.limitGb = 2 / 1024 ** 3
    expect(await trimPlaybackCache()).toMatchObject({
      removedBytes: 6,
      info: { usedBytes: 4, protectedBytes: 4, limitBytes: 2 },
    })
    expect(fs.existsSync(playing)).toBe(true)
  })

  it('purges only exact video versions in the requested library and preserves active generations', async () => {
    const old = proxy('video.v1.mp4')
    const corrupt = proxy('video.v2.mp4.source.json')
    const temporary = proxy('video.v3.mp4.tmp')
    const differentVideo = proxy('video-extra.v3.mp4')
    const differentLibrary = write('playback-proxies/other/video.v1.mp4')
    protectPlaybackCache('library', 'video:generation', path.join(library, 'video.v3.mp4'))
    await purgeVideoPlaybackCache('library', 'video')
    expect([old, corrupt].every((file) => !fs.existsSync(file))).toBe(true)
    expect([temporary, differentVideo, differentLibrary].every(fs.existsSync)).toBe(true)
    releasePlaybackCache('library', 'video:generation')
    await purgeVideoPlaybackCache('library', 'video')
    expect(fs.existsSync(temporary)).toBe(false)
    await expect(purgeVideoPlaybackCache('../other', 'video')).rejects.toThrow('ID')
  })

  it('invalidates an early-closed playback lease without letting older requests unpin a newer one', async () => {
    const video = proxy('video.v3.mp4')
    const closed = beginPlaybackCacheLease('library', 'video')
    expect(releasePlaybackCache('library', 'video')).toBe(true)
    expect(closed(video)).toBe(false)
    expect((await getCacheInfo()).protectedBytes).toBe(0)
    const older = beginPlaybackCacheLease('library', 'video')
    expect(older(video)).toBe(true)
    const newer = beginPlaybackCacheLease('library', 'video')
    expect(older.release()).toBe(false)
    expect(older(video)).toBe(false)
    expect(newer(video)).toBe(true)
    expect((await cleanPlaybackCache()).removedFiles).toBe(0)
    expect(newer.release()).toBe(true)
    expect((await cleanPlaybackCache()).removedFiles).toBe(1)
  })

  it('keeps a pending playback reservation protected across the generation-to-player handoff', async () => {
    const player = beginPlaybackCacheLease('library', 'video')
    const output = proxy('video.v3.mp4')
    const generation = beginPlaybackCacheLease('library', 'video:generation')
    generation(output)
    generation.release()
    // No path has been handed to the player yet; it is still awaiting ensure.
    expect((await cleanPlaybackCache()).removedFiles).toBe(0)
    expect(player(output)).toBe(true)
    expect((await cleanPlaybackCache()).removedFiles).toBe(0)
    player.release()
    expect((await cleanPlaybackCache()).removedFiles).toBe(1)
  })

  it('rejects paths outside the managed root and never follows directory junctions', async () => {
    const outside = path.join(fixture, 'outside')
    fs.mkdirSync(outside)
    const original = path.join(outside, 'original.avi')
    fs.writeFileSync(original, 'untouched')
    const junction = path.join(state.userData, 'playback-proxies', 'linked')
    fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
    proxy('unprotected.v3.mp4')
    expect(() => protectPlaybackCache('library', 'video', original)).toThrow('캐시')
    expect(() =>
      protectPlaybackCache('linked', 'video', path.join(junction, 'original.avi')),
    ).toThrow('링크')
    expect(await getCacheInfo()).toMatchObject({ fileCount: 1, usedBytes: 4 })
    expect((await cleanPlaybackCache()).removedFiles).toBe(1)
    expect(fs.readFileSync(original, 'utf8')).toBe('untouched')
    expect(fs.lstatSync(junction).isSymbolicLink()).toBe(true)
  })

  it('refuses an entire cache root redirected to an external folder', async () => {
    const cacheRoot = path.dirname(library)
    fs.rmdirSync(library)
    fs.rmdirSync(cacheRoot)
    const outside = path.join(fixture, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'original.avi'), 'untouched')
    fs.symlinkSync(outside, cacheRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(cleanPlaybackCache()).rejects.toThrow('일반 폴더')
    expect(fs.readFileSync(path.join(outside, 'original.avi'), 'utf8')).toBe('untouched')
  })

  it('rechecks a pin that arrives after enumeration and serializes simultaneous cleanup requests', async () => {
    const file = proxy('video.v3.mp4', '12345')
    const unlink = vi.spyOn(fs, 'unlinkSync')
    const first = cleanPlaybackCache()
    const second = trimPlaybackCache()
    protectPlaybackCache('library', 'video', file)
    expect((await first).removedFiles).toBe(0)
    expect((await second).removedFiles).toBe(0)
    expect(unlink).not.toHaveBeenCalled()
    releasePlaybackCache('library', 'video')
    const results = await Promise.all([cleanPlaybackCache(), cleanPlaybackCache()])
    expect(results.reduce((sum, result) => sum + result.removedFiles, 0)).toBe(1)
  })

  it('handles a new installation and yields while scanning a large cache', async () => {
    fs.rmdirSync(library)
    fs.rmdirSync(path.dirname(library))
    expect(await getCacheInfo()).toMatchObject({ fileCount: 0, usedBytes: 0 })
    for (let index = 0; index < 200; index++) proxy('video-' + index + '.v3.mp4')
    let ticked = false
    const pending = getCacheInfo()
    setImmediate(() => {
      ticked = true
    })
    expect((await pending).fileCount).toBe(200)
    expect(ticked).toBe(true)
  })
})
