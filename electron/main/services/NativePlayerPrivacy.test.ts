import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import childProcess, { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { NativePlayerInfo } from '@shared/types'

const state = vi.hoisted(() => ({ selected: null as NativePlayerInfo | null, videoPath: '' }))
vi.mock('electron', () => ({ shell: {} }))
vi.mock('../infra/config', () => ({
  loadConfig: () => ({ libraries: [], nativePlayer: state.selected }),
}))
vi.mock('../infra/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
}))
vi.mock('../db/connection', () => ({ getDatabase: () => ({}) }))
vi.mock('../db/repositories/VideoRepository', () => ({
  VideoRepository: class {
    findById(id: string) {
      return { id, filePath: state.videoPath }
    }
  },
}))
vi.mock('../ffmpeg/playback.js', () => ({ needsPlaybackProxy: vi.fn() }))
vi.mock('./PlaybackConversionService', () => ({ enqueuePlaybackConversion: vi.fn() }))
vi.mock('./CacheService', () => ({
  beginPlaybackCacheLease: vi.fn(),
  purgeVideoPlaybackCache: vi.fn(),
  trimPlaybackCache: vi.fn(),
}))
vi.mock('./PlaybackService', () => ({ endPlayback: vi.fn() }))
vi.mock('./MpvSessionService.js', () => ({ openInMpv: vi.fn(), seekMpvSession: vi.fn() }))

import { closeManagedNativePlayers, openInNativePlayer } from './NativePlayerService'
import { openVideoInNativePlayer } from './VideoService'
import { openInMpv } from './MpvSessionService.js'

beforeEach(() => {
  state.videoPath = path.join(tmpdir(), `dvm-native-privacy-${randomUUID()}.mp4`)
  fs.writeFileSync(state.videoPath, 'synthetic video')
  state.selected = {
    name: 'vlc',
    path: path.resolve('synthetic-native-player' + (process.platform === 'win32' ? '.exe' : '')),
  }
  vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as fs.Stats)
  vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined)
  vi.spyOn(fs.promises, 'realpath').mockImplementation(async (file) => String(file))
})

afterEach(() => {
  closeManagedNativePlayers()
  fs.unlinkSync(state.videoPath)
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function deferValidation() {
  let resolve!: (value: fs.Stats) => void
  vi.mocked(fs.promises.stat).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  return () => resolve({ isFile: () => true } as fs.Stats)
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(),
    unref: vi.fn(),
  })
  child.kill.mockImplementation(() => {
    child.killed = true
    child.emit('exit', null, 'SIGTERM')
    return true
  })
  vi.spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as ChildProcess)
  return child
}

describe('emergency exit cancels pending native launches', () => {
  it('does not spawn a direct player after executable validation finishes late', async () => {
    const finishValidation = deferValidation()
    const spawn = vi.spyOn(childProcess, 'spawn')
    const pending = openInNativePlayer('synthetic-video.mp4', {}, state.selected!)
    const rejected = expect(pending).rejects.toThrow('실행이 취소')
    closeManagedNativePlayers()
    finishValidation()
    await rejected
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['mpv', 'vlc'] as const)(
    'cancels a %s request still discovering its executable',
    async (name) => {
      state.selected!.name = name
      const finishValidation = deferValidation()
      const spawn = vi.spyOn(childProcess, 'spawn')
      const pending = openVideoInNativePlayer('library', 'video', {} as WebContents)
      const rejected = expect(pending).rejects.toThrow('실행이 취소')
      closeManagedNativePlayers()
      finishValidation()
      await rejected
      expect(openInMpv).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    },
  )

  it('allows a fresh user launch after the emergency exit', async () => {
    vi.useFakeTimers()
    closeManagedNativePlayers()
    const child = fakeChild()
    const pending = openInNativePlayer('synthetic-video.mp4', {}, state.selected!)
    await vi.advanceTimersByTimeAsync(0)
    expect(childProcess.spawn).toHaveBeenCalledOnce()
    child.emit('spawn')
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toEqual(state.selected)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('stops a spawned child and rejects its pending startup during emergency exit', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const pending = openInNativePlayer('synthetic-video.mp4', {}, state.selected!)
    const rejected = expect(pending).rejects.toThrow('신호로 종료')
    await vi.advanceTimersByTimeAsync(0)
    child.emit('spawn')
    closeManagedNativePlayers()
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.unref).not.toHaveBeenCalled()
  })
})
