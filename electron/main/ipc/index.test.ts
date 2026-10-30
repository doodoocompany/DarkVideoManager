import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { IPC, INVOKE_CHANNELS } from '@shared/ipc'
import { registerAllHandlers } from './index'
import { drainLibraryWork, withLibraryWork } from '../services/LibraryWorkService'
import { secureWindow } from '../infra/windowSecurity'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  previewNames: vi.fn(),
  applyNames: vi.fn(),
  findDuplicates: vi.fn(),
  showOpenDialog: vi.fn(),
  importCsvData: vi.fn(),
  closeLibrary: vi.fn(),
  deleteLibrary: vi.fn(),
  updateVideoMeta: vi.fn(),
  deleteVideo: vi.fn(),
  restoreVideo: vi.fn(),
  revealVideoSource: vi.fn(),
  createHighlight: vi.fn(),
  updateHighlight: vi.fn(),
  deleteHighlight: vi.fn(),
  setPrimaryThumbnail: vi.fn(),
  openVideoInNativePlayer: vi.fn(),
  captureThumbnailAtTime: vi.fn(),
  saveThumbnailImageCapture: vi.fn(),
  ensureThumbnailForVideo: vi.fn(),
  listThumbnailJobs: vi.fn(),
  cancelThumbnailJob: vi.fn(),
  refreshLibrary: vi.fn(),
  importFiles: vi.fn(),
  importFolders: vi.fn(),
  recordSeek: vi.fn(),
  listConversions: vi.fn(),
  pauseConversion: vi.fn(),
  resumeConversion: vi.fn(),
  removeConversion: vi.fn(),
  syncSidecarSubtitlesForVideo: vi.fn(),
  subtitleRows: vi.fn(),
  videoRow: vi.fn(),
  db: {},
  gpuInfoUpdated: undefined as (() => void) | undefined,
  getGPUFeatureStatus: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  app: {
    quit: vi.fn(),
    once: (event: string, listener: () => void) => {
      if (event === 'gpu-info-update') mocks.gpuInfoUpdated = listener
    },
    getGPUFeatureStatus: mocks.getGPUFeatureStatus,
  },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { fromWebContents: (sender: unknown) => ({ webContents: sender }) },
}))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn() }) }))
vi.mock('../infra/paths', () => ({ getThumbnailsDir: () => 'test-thumbnails' }))
vi.mock('../db/connection', () => ({ getDatabase: () => mocks.db }))
vi.mock('../db/repositories/SubtitleRepository', () => ({
  SubtitleRepository: class {
    findByVideoId = mocks.subtitleRows
  },
}))
vi.mock('../db/repositories/VideoRepository', () => ({
  VideoRepository: class {
    findById = mocks.videoRow
  },
}))
vi.mock('../services/DataImportService', () => ({
  previewCsvImport: vi.fn(),
  importCsvData: mocks.importCsvData,
}))
vi.mock('../services/LibraryMaintenanceService', () => ({
  previewFilenameCleanup: mocks.previewNames,
  applyFilenameCleanup: mocks.applyNames,
  findExactDuplicates: mocks.findDuplicates,
  cancelLibraryMaintenance: vi.fn(),
}))
vi.mock('../services/LibraryService', () => ({
  listLibraries: vi.fn(),
  openLibrary: vi.fn(),
  createLibrary: vi.fn(),
  closeLibrary: mocks.closeLibrary,
  deleteLibrary: mocks.deleteLibrary,
  importFolder: vi.fn(),
  importFiles: mocks.importFiles,
  importFolders: mocks.importFolders,
  refreshLibrary: mocks.refreshLibrary,
}))
vi.mock('../services/VideoService', () => ({
  searchVideos: vi.fn(),
  getVideoMetadataOptions: vi.fn(),
  getVideo: vi.fn(),
  updateVideoMeta: mocks.updateVideoMeta,
  deleteVideo: mocks.deleteVideo,
  restoreVideo: mocks.restoreVideo,
  getPlaybackSource: vi.fn(),
  getNativePlayerInfo: vi.fn(),
  openVideoInNativePlayer: mocks.openVideoInNativePlayer,
  seekActivePlayback: vi.fn(),
}))
vi.mock('../services/VideoSourceLocationService', () => ({
  revealVideoSource: mocks.revealVideoSource,
}))
vi.mock('../services/PlaybackService', () => ({
  startPlayback: vi.fn(),
  heartbeat: vi.fn(),
  endPlayback: vi.fn(),
  recordSeek: mocks.recordSeek,
}))
vi.mock('../services/PlaybackConversionService', () => ({
  listPlaybackConversionJobs: mocks.listConversions,
  pausePlaybackConversionJob: mocks.pauseConversion,
  resumePlaybackConversionJob: mocks.resumeConversion,
  removePlaybackConversionJob: mocks.removeConversion,
}))
vi.mock('../services/ThumbnailService', () => ({
  getThumbnailsForVideo: vi.fn(),
  setPrimaryThumbnail: mocks.setPrimaryThumbnail,
  ensureThumbnailForVideo: mocks.ensureThumbnailForVideo,
  captureThumbnailAtTime: mocks.captureThumbnailAtTime,
  saveThumbnailImageCapture: mocks.saveThumbnailImageCapture,
}))
vi.mock('../services/ThumbnailJobService', () => ({
  listThumbnailJobs: mocks.listThumbnailJobs,
  cancelThumbnailJob: mocks.cancelThumbnailJob,
}))
vi.mock('../services/HighlightService', () => ({
  listHighlights: vi.fn(),
  createHighlight: mocks.createHighlight,
  updateHighlight: mocks.updateHighlight,
  deleteHighlight: mocks.deleteHighlight,
}))
vi.mock('../services/StatsService', () => ({ getStats: vi.fn() }))
vi.mock('../services/SubtitleService', () => ({
  convertSmiToVtt: vi.fn(),
  convertSrtToVtt: vi.fn(),
  readFileSmart: vi.fn(),
  syncSidecarSubtitlesForVideo: mocks.syncSidecarSubtitlesForVideo,
}))

const rendererUrl = 'file:///C:/DarkVideoManager/out/renderer/index.html'
const senderFrame = { url: rendererUrl }
const sender = {
  id: 1,
  mainFrame: senderFrame,
  isDestroyed: () => false,
  once: vi.fn(),
  on: vi.fn(),
  setWindowOpenHandler: vi.fn(),
  session: {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  },
}
const event = { sender, senderFrame } as unknown as IpcMainInvokeEvent

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const entry = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!entry) throw new Error(`Missing handler: ${channel}`)
  return entry[1](event, ...args)
}

beforeEach(() => {
  vi.clearAllMocks()
  senderFrame.url = rendererUrl
  secureWindow({ webContents: sender } as unknown as BrowserWindow, rendererUrl)
  registerAllHandlers()
})

describe('IPC dispatch', () => {
  it('passes half-star ratings through to metadata storage', async () => {
    expect(await invoke(IPC.VIDEOS.UPDATE_META, 'lib', 'video', { rating: 4.5 })).toMatchObject({
      ok: true,
    })
    expect(mocks.updateVideoMeta).toHaveBeenCalledWith('lib', 'video', { rating: 4.5 })
  })

  it('selects multiple folders and drive roots and imports them in one operation', async () => {
    const folderPaths = ['D:/', 'E:/Movies']
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: folderPaths })
    expect(await invoke(IPC.LIBRARY.SELECT_FOLDERS)).toEqual({ ok: true, value: folderPaths })
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ properties: ['openDirectory', 'multiSelections'] }),
    )
    mocks.importFolders.mockResolvedValue({ added: 2, skipped: 0, removed: 0, errors: [] })
    expect(await invoke(IPC.LIBRARY.IMPORT_FOLDERS, 'lib', folderPaths)).toMatchObject({
      ok: true,
      value: { added: 2 },
    })
    expect(mocks.importFolders).toHaveBeenCalledExactlyOnceWith(
      'lib',
      folderPaths,
      expect.anything(),
    )
    for (const paths of [[], [''], Array(101).fill('D:/'), 'D:/'])
      expect(await invoke(IPC.LIBRARY.IMPORT_FOLDERS, 'lib', paths)).toMatchObject({ ok: false })
    expect(mocks.importFolders).toHaveBeenCalledTimes(1)
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke(IPC.LIBRARY.SELECT_FOLDERS)).toEqual({ ok: true, value: null })
  })
  it('allows thumbnail status and per-video cancellation during an import', async () => {
    mocks.listThumbnailJobs.mockReturnValue([{ videoId: 'video', phase: 'running' }])
    mocks.cancelThumbnailJob.mockReturnValue(true)
    await withLibraryWork('lib', async () => {
      expect(await invoke(IPC.THUMBNAILS.LIST_JOBS, 'lib')).toEqual({
        ok: true,
        value: [{ videoId: 'video', phase: 'running' }],
      })
      expect(await invoke(IPC.THUMBNAILS.CANCEL_FOR_VIDEO, 'lib', 'video')).toEqual({
        ok: true,
        value: true,
      })
    })
    expect(mocks.cancelThumbnailJob).toHaveBeenCalledWith('lib', 'video')
    expect(await invoke(IPC.THUMBNAILS.CANCEL_FOR_VIDEO, 'lib', '')).toMatchObject({ ok: false })
    expect(mocks.cancelThumbnailJob).toHaveBeenCalledTimes(1)
  })

  it('allows another video to queue thumbnails while protecting the active video', async () => {
    await withLibraryWork(
      'lib',
      async () => {
        expect(await invoke(IPC.THUMBNAILS.ENSURE_FOR_VIDEO, 'lib', 'other')).toMatchObject({
          ok: true,
        })
        expect(await invoke(IPC.THUMBNAILS.ENSURE_FOR_VIDEO, 'lib', 'video')).toMatchObject({
          ok: false,
        })
        expect(await invoke(IPC.THUMBNAILS.SET_PRIMARY, 'lib', 'thumb', 'video')).toMatchObject({
          ok: false,
        })
        expect(mocks.ensureThumbnailForVideo).toHaveBeenCalledTimes(1)
        expect(mocks.setPrimaryThumbnail).not.toHaveBeenCalled()
      },
      'thumbnails',
      'video',
    )
  })

  it('selects video files and validates selected-file import arguments before dispatch', async () => {
    const filePaths = ['C:/videos/one.mp4', 'C:/videos/two.mkv']
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths })
    expect(await invoke(IPC.LIBRARY.SELECT_FILES)).toEqual({ ok: true, value: filePaths })
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        properties: ['openFile', 'multiSelections'],
        filters: [expect.objectContaining({ extensions: expect.arrayContaining(['mp4', 'mkv']) })],
      }),
    )
    mocks.importFiles.mockResolvedValue({ added: 2, skipped: 0, removed: 0, errors: [] })
    expect(await invoke(IPC.LIBRARY.IMPORT_FILES, 'lib', filePaths)).toMatchObject({
      ok: true,
      value: { added: 2 },
    })
    expect(mocks.importFiles).toHaveBeenCalledExactlyOnceWith('lib', filePaths, expect.anything())
    for (const invalid of [[], [''], ['one.mp4', 1], 'one.mp4', Array(1001).fill('one.mp4')]) {
      expect(await invoke(IPC.LIBRARY.IMPORT_FILES, 'lib', invalid)).toMatchObject({ ok: false })
    }
    expect(mocks.importFiles).toHaveBeenCalledTimes(1)
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke(IPC.LIBRARY.SELECT_FILES)).toEqual({ ok: true, value: null })
  })

  it('reveals an original source by library/video IDs and rejects renderer file paths', async () => {
    expect(await invoke(IPC.VIDEOS.REVEAL_SOURCE, 'other-library', 'video')).toEqual({
      ok: true,
      value: null,
    })
    expect(mocks.revealVideoSource).toHaveBeenCalledWith('other-library', 'video')
    for (const args of [
      ['other-library', 'video', 'C:/renderer-supplied.mp4'],
      [{ filePath: 'C:/renderer-supplied.mp4' }],
      ['', 'video'],
      ['other-library'],
    ]) {
      expect(await invoke(IPC.VIDEOS.REVEAL_SOURCE, ...args)).toMatchObject({ ok: false })
    }
    expect(mocks.revealVideoSource).toHaveBeenCalledTimes(1)
    mocks.revealVideoSource.mockRejectedValueOnce(new Error('원본 영상 파일을 찾을 수 없습니다.'))
    expect(await invoke(IPC.VIDEOS.REVEAL_SOURCE, 'other-library', 'video')).toEqual({
      ok: false,
      error: '원본 영상 파일을 찾을 수 없습니다.',
    })
  })

  it('accepts cleanup rules and server preview IDs while rejecting renderer target paths', async () => {
    expect(await invoke(IPC.MAINTENANCE.PREVIEW_NAMES, 'lib', { prefix: '[ad] ' })).toMatchObject({
      ok: true,
    })
    expect(mocks.previewNames).toHaveBeenCalledWith('lib', { prefix: '[ad] ' })
    for (const input of [
      { prefix: '../' },
      { prefix: '' },
      { prefix: '[ad]', target: 'C:/other.mp4' },
    ])
      expect(await invoke(IPC.MAINTENANCE.PREVIEW_NAMES, 'lib', input)).toMatchObject({ ok: false })
    expect(mocks.previewNames).toHaveBeenCalledTimes(1)
    const preview = 'dd270470-14f8-45ed-af6e-f3b2da7c86d3'
    expect(await invoke(IPC.MAINTENANCE.APPLY_NAMES, 'lib', preview, ['video'])).toMatchObject({
      ok: true,
    })
    expect(mocks.applyNames).toHaveBeenCalledWith('lib', preview, ['video'])
    expect(
      await invoke(IPC.MAINTENANCE.APPLY_NAMES, 'lib', preview, ['video', 'video']),
    ).toMatchObject({ ok: false })
    expect(
      await invoke(IPC.MAINTENANCE.APPLY_NAMES, 'lib', preview, [{ from: 'old', to: 'new' }]),
    ).toMatchObject({ ok: false })
    expect(mocks.applyNames).toHaveBeenCalledTimes(1)
    expect(await invoke(IPC.MAINTENANCE.FIND_DUPLICATES, 'lib')).toMatchObject({ ok: true })
    expect(mocks.findDuplicates).toHaveBeenCalledWith('lib')
  })
  it('rejects subframes and unregistered windows before a privileged handler runs', async () => {
    const entry = mocks.handle.mock.calls.find(([name]) => name === IPC.VIDEOS.UPDATE_META)!
    const args = ['lib', 'video', { rating: 3 }]
    for (const untrusted of [
      { sender, senderFrame: { url: rendererUrl } },
      { sender: { ...sender }, senderFrame },
      { sender, senderFrame: null },
    ]) {
      expect(await entry[1](untrusted, ...args)).toEqual({
        ok: false,
        error: '허용되지 않은 화면의 요청입니다.',
      })
    }
    senderFrame.url = 'https://example.com/'
    expect(await entry[1](event, ...args)).toMatchObject({ ok: false })
    expect(mocks.updateVideoMeta).not.toHaveBeenCalled()
  })

  const captureMutations = [
    {
      channel: IPC.HIGHLIGHTS.CREATE,
      args: [{ videoId: 'video', timeStart: 2 }],
      service: mocks.createHighlight,
    },
    {
      channel: IPC.HIGHLIGHTS.UPDATE,
      args: ['highlight', { timeStart: 3 }],
      service: mocks.updateHighlight,
    },
    { channel: IPC.HIGHLIGHTS.DELETE, args: ['highlight'], service: mocks.deleteHighlight },
    {
      channel: IPC.THUMBNAILS.SET_PRIMARY,
      args: ['thumbnail', 'video'],
      service: mocks.setPrimaryThumbnail,
    },
    {
      channel: IPC.THUMBNAILS.ENSURE_FOR_VIDEO,
      args: ['video'],
      service: mocks.ensureThumbnailForVideo,
    },
    {
      channel: IPC.THUMBNAILS.CAPTURE_AT_TIME,
      args: ['video', 2],
      service: mocks.captureThumbnailAtTime,
    },
    {
      channel: IPC.THUMBNAILS.SAVE_IMAGE_CAPTURE,
      args: ['video', 2, 'data:image/png;base64,AAAA'],
      service: mocks.saveThumbnailImageCapture,
    },
  ]

  it.each(['subtitles', 'exclusive', 'thumbnails'] as const)(
    'allows highlight and thumbnail mutations only alongside subtitle work (%s)',
    async (kind) => {
      await withLibraryWork(
        'lib',
        async () => {
          for (const { channel, args, service } of captureMutations) {
            expect(await invoke(channel, 'lib', ...args)).toMatchObject({
              ok: kind === 'subtitles',
            })
            expect(service).toHaveBeenCalledTimes(kind === 'subtitles' ? 1 : 0)
          }
        },
        kind,
      )
    },
  )

  it('keeps library and video mutations blocked while subtitles run', async () => {
    const mutations = [
      { channel: IPC.LIBRARY.CLOSE, args: [], service: mocks.closeLibrary },
      { channel: IPC.LIBRARY.DELETE, args: [], service: mocks.deleteLibrary },
      {
        channel: IPC.VIDEOS.UPDATE_META,
        args: ['video', { rating: 3 }],
        service: mocks.updateVideoMeta,
      },
      { channel: IPC.VIDEOS.DELETE, args: ['video'], service: mocks.deleteVideo },
      { channel: IPC.VIDEOS.RESTORE, args: ['video'], service: mocks.restoreVideo },
    ]
    await withLibraryWork(
      'lib',
      async () => {
        for (const { channel, args, service } of mutations) {
          expect(await invoke(channel, 'lib', ...args)).toMatchObject({
            ok: false,
            error: expect.stringContaining('라이브러리 작업'),
          })
          expect(service).not.toHaveBeenCalled()
        }
      },
      'subtitles',
    )
  })

  it('blocks capture mutations in every library while cancelled work is draining', async () => {
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = withLibraryWork('lib', async () => cleanup, 'subtitles')
    const drain = drainLibraryWork()
    try {
      for (const libraryId of ['lib', 'other-library']) {
        for (const { channel, args, service } of captureMutations) {
          expect(await invoke(channel, libraryId, ...args)).toMatchObject({
            ok: false,
            error: expect.stringContaining('라이브러리 작업'),
          })
          expect(service).not.toHaveBeenCalled()
        }
      }
    } finally {
      release()
      await Promise.all([work, drain])
    }
    expect(
      await invoke(IPC.HIGHLIGHTS.CREATE, 'lib', { videoId: 'video', timeStart: 2 }),
    ).toMatchObject({ ok: true })
  })

  it('validates conversion queue controls and returns service failures to the renderer', async () => {
    const jobId = 'dd270470-14f8-45ed-af6e-f3b2da7c86d3'
    mocks.listConversions.mockReturnValue([{ id: jobId, status: 'running' }])
    expect(await invoke(IPC.PLAYBACK.LIST_CONVERSION_QUEUE)).toEqual({
      ok: true,
      value: [{ id: jobId, status: 'running' }],
    })
    expect(await invoke(IPC.PLAYBACK.PAUSE_CONVERSION, 'C:/video.mp4')).toMatchObject({ ok: false })
    expect(mocks.pauseConversion).not.toHaveBeenCalled()
    mocks.pauseConversion.mockResolvedValue({ id: jobId, status: 'paused' })
    expect(await invoke(IPC.PLAYBACK.PAUSE_CONVERSION, jobId)).toEqual({
      ok: true,
      value: { id: jobId, status: 'paused' },
    })
    mocks.resumeConversion.mockRejectedValueOnce(new Error('변환 원본을 찾을 수 없습니다.'))
    expect(await invoke(IPC.PLAYBACK.RESUME_CONVERSION, jobId)).toEqual({
      ok: false,
      error: '변환 원본을 찾을 수 없습니다.',
    })
    mocks.removeConversion.mockResolvedValue(undefined)
    expect(await invoke(IPC.PLAYBACK.REMOVE_CONVERSION, jobId)).toEqual({ ok: true, value: null })
    expect(mocks.removeConversion).toHaveBeenCalledWith(jobId)
  })
  it('isolates GPU feature query errors without breaking later IPC requests', async () => {
    mocks.gpuInfoUpdated?.()
    mocks.getGPUFeatureStatus.mockImplementationOnce(() => {
      throw new Error('GPU process unavailable')
    })
    expect(await invoke(IPC.APP.GET_ACCELERATION_INFO)).toEqual({
      ok: false,
      error: 'GPU process unavailable',
    })
    mocks.getGPUFeatureStatus.mockReturnValue({ video_decode: 'enabled' })
    expect(await invoke(IPC.APP.GET_ACCELERATION_INFO)).toEqual({
      ok: true,
      value: { videoDecodeStatus: 'enabled', gpuCompositingStatus: 'unknown' },
    })
  })

  it('dispatches explicit seek positions only after validation', async () => {
    expect(await invoke(IPC.PLAYBACK.SEEK, 'lib', 'video', -1)).toMatchObject({ ok: false })
    expect(mocks.recordSeek).not.toHaveBeenCalled()
    expect(await invoke(IPC.PLAYBACK.SEEK, 'lib', 'video', 1.5)).toEqual({ ok: true, value: null })
    expect(mocks.recordSeek).toHaveBeenCalledWith('lib', 'video', 1.5)
  })

  it('registers every deployed invoke channel exactly once', () => {
    expect(mocks.handle).toHaveBeenCalledTimes(INVOKE_CHANNELS.length)
    expect(new Set(mocks.handle.mock.calls.map(([channel]) => channel))).toEqual(
      new Set(INVOKE_CHANNELS),
    )
  })

  it('rejects invalid import and seek inputs before invoking a service', async () => {
    expect(
      await invoke(IPC.DATA_IMPORT.IMPORT, 'lib', 'history.csv', { importRatings: 'yes' }),
    ).toMatchObject({ ok: false })
    expect(mocks.importCsvData).not.toHaveBeenCalled()
    expect(await invoke(IPC.VIDEOS.SEEK_ACTIVE_PLAYBACK, 'lib', 'video', -10)).toMatchObject({
      ok: false,
    })
    const options = { importRatings: true, importFavoritesAsHighlights: false }
    mocks.importCsvData.mockReturnValue({ ratingsUpdated: 2 })
    expect(await invoke(IPC.DATA_IMPORT.IMPORT, 'lib', 'history.csv', options)).toEqual({
      ok: true,
      value: { ratingsUpdated: 2 },
    })
    expect(mocks.importCsvData).toHaveBeenCalledWith(
      'lib',
      'history.csv',
      options,
      expect.any(Function),
    )
  })

  it('waits for video deletion and reports rejected deletion as a failed Result', async () => {
    let complete!: () => void
    mocks.deleteVideo.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
    )
    let resolved = false
    const pending = invoke(IPC.VIDEOS.DELETE, 'lib', 'video').then((result) => {
      resolved = true
      return result
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    complete()
    expect(await pending).toEqual({ ok: true, value: null })
    mocks.deleteVideo.mockRejectedValueOnce(new Error('Cannot delete file'))
    expect(await invoke(IPC.VIDEOS.DELETE, 'lib', 'video')).toEqual({
      ok: false,
      error: 'Cannot delete file',
    })
  })

  it('preserves native player geometry and thumbnail capture argument order', async () => {
    const geometry = { startTimeSec: 3, width: 800, height: 600, x: -1920, y: 0 }
    await invoke(IPC.VIDEOS.OPEN_IN_NATIVE_PLAYER, 'lib', 'video', geometry)
    expect(mocks.openVideoInNativePlayer).toHaveBeenCalledWith('lib', 'video', sender, geometry)
    await invoke(IPC.THUMBNAILS.ENSURE_FOR_VIDEO, 'lib', 'video')
    expect(mocks.ensureThumbnailForVideo).toHaveBeenCalledWith('lib', 'video', sender, false)
    await invoke(IPC.THUMBNAILS.CAPTURE_AT_TIME, 'lib', 'video', 12.5, false)
    expect(mocks.captureThumbnailAtTime).toHaveBeenCalledWith(
      'lib',
      'video',
      12.5,
      sender,
      true,
      false,
    )
    await invoke(
      IPC.THUMBNAILS.SAVE_IMAGE_CAPTURE,
      'lib',
      'video',
      12.5,
      'data:image/png;base64,AAAA',
    )
    expect(mocks.saveThumbnailImageCapture).toHaveBeenCalledWith(
      'lib',
      'video',
      12.5,
      'data:image/png;base64,AAAA',
      sender,
      true,
    )
  })

  it('rediscovers sidecars even when a video already has indexed tracks', async () => {
    const subtitles = [
      { id: 'sub', videoId: 'video', filePath: 'movie.srt', type: 'srt', isEmbedded: false },
    ]
    mocks.subtitleRows.mockReturnValue([])
    mocks.videoRow.mockReturnValue({ id: 'video', filePath: 'movie.mp4' })
    mocks.syncSidecarSubtitlesForVideo.mockReturnValue(subtitles)
    expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
      ok: true,
      value: subtitles,
    })
    expect(mocks.syncSidecarSubtitlesForVideo).toHaveBeenCalledWith(mocks.db, 'video', 'movie.mp4')
    mocks.syncSidecarSubtitlesForVideo.mockClear()
    mocks.subtitleRows.mockReturnValue(subtitles)
    await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')
    expect(mocks.syncSidecarSubtitlesForVideo).toHaveBeenCalledWith(mocks.db, 'video', 'movie.mp4')
    mocks.syncSidecarSubtitlesForVideo.mockReturnValue([])
    expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
      ok: true,
      value: [],
    })
  })

  it.each(['exclusive', 'subtitles', 'thumbnails'] as const)(
    'returns stored subtitle tracks without rediscovery during %s work, including an empty index',
    async (kind) => {
      const stored = [
        { id: 'sub', videoId: 'video', filePath: 'movie.srt', type: 'srt', isEmbedded: false },
      ]
      mocks.videoRow.mockReturnValue({ id: 'video', filePath: 'movie.mp4' })
      await withLibraryWork(
        'lib',
        async () => {
          for (const tracks of [stored, []]) {
            mocks.subtitleRows.mockReturnValue(tracks)
            expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
              ok: true,
              value: tracks,
            })
          }
          expect(mocks.syncSidecarSubtitlesForVideo).not.toHaveBeenCalled()
        },
        kind,
      )
    },
  )

  it('preserves subtitle snapshots across cancellation cleanup and resumes discovery after draining', async () => {
    const stored = [
      { id: 'sub', videoId: 'video', filePath: 'movie.srt', type: 'srt', isEmbedded: false },
    ]
    const refreshed = [...stored, { ...stored[0], id: 'new', filePath: 'movie.ko.srt', lang: 'ko' }]
    mocks.subtitleRows.mockReturnValue(stored)
    mocks.videoRow.mockReturnValue({ id: 'video', filePath: 'movie.mp4' })
    mocks.syncSidecarSubtitlesForVideo.mockReset().mockReturnValue(refreshed)
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = withLibraryWork('lib', async () => cleanup, 'subtitles')
    const drain = drainLibraryWork()
    try {
      for (const libraryId of ['lib', 'other-library']) {
        expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, libraryId, 'video')).toEqual({
          ok: true,
          value: stored,
        })
      }
      expect(mocks.syncSidecarSubtitlesForVideo).not.toHaveBeenCalled()
    } finally {
      release()
      await Promise.all([work, drain])
    }
    expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
      ok: true,
      value: refreshed,
    })
    expect(mocks.syncSidecarSubtitlesForVideo).toHaveBeenCalledExactlyOnceWith(
      mocks.db,
      'video',
      'movie.mp4',
    )
  })

  it('rediscovers subtitles in an idle library while a different library has an active job', async () => {
    mocks.subtitleRows.mockReturnValue([])
    mocks.videoRow.mockReturnValue({ id: 'video', filePath: 'movie.mp4' })
    mocks.syncSidecarSubtitlesForVideo.mockReset().mockReturnValue([])
    await withLibraryWork(
      'other-library',
      async () => {
        expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
          ok: true,
          value: [],
        })
        expect(mocks.syncSidecarSubtitlesForVideo).toHaveBeenCalledExactlyOnceWith(
          mocks.db,
          'video',
          'movie.mp4',
        )
      },
      'subtitles',
    )
  })

  it('keeps stored tracks when a subtitle directory is inaccessible and reports an initial scan failure', async () => {
    const subtitles = [
      { id: 'sub', videoId: 'video', filePath: 'movie.srt', type: 'srt', isEmbedded: false },
    ]
    mocks.subtitleRows.mockReturnValue(subtitles)
    mocks.videoRow.mockReturnValue({ id: 'video', filePath: 'movie.mp4' })
    mocks.syncSidecarSubtitlesForVideo.mockImplementation(() => {
      throw new Error('Drive offline')
    })
    expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
      ok: true,
      value: subtitles,
    })
    mocks.subtitleRows.mockReturnValue([])
    expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
      ok: false,
      error: 'Drive offline',
    })
  })

  it('does not rediscover subtitles for a deliberately removed video', async () => {
    mocks.subtitleRows.mockReturnValue([])
    mocks.videoRow.mockReturnValue({ id: 'video', filePath: 'movie.mp4', removalMode: 'keep' })
    expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
      ok: true,
      value: [],
    })
    expect(mocks.syncSidecarSubtitlesForVideo).not.toHaveBeenCalled()
  })

  it('treats file-picker cancellation as a successful empty selection', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke(IPC.DATA_IMPORT.SELECT_CSV)).toEqual({ ok: true, value: null })
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(
      { webContents: sender },
      {
        properties: ['openFile'],
        filters: [{ name: 'CSV files', extensions: ['csv'] }],
      },
    )
  })

  it('keeps capture mutations blocked after the shutdown drain has completed', async () => {
    vi.resetModules()
    const isolatedWork = await import('../services/LibraryWorkService')
    const isolatedIpc = await import('./index')
    const isolatedSecurity = await import('../infra/windowSecurity')
    isolatedSecurity.secureWindow({ webContents: sender } as unknown as BrowserWindow, rendererUrl)
    mocks.handle.mockClear()
    isolatedIpc.registerAllHandlers()
    await isolatedWork.drainLibraryWork({ shutdown: true })
    for (const { channel, args, service } of captureMutations) {
      expect(await invoke(channel, 'lib', ...args)).toMatchObject({
        ok: false,
        error: expect.stringContaining('라이브러리 작업'),
      })
      expect(service).not.toHaveBeenCalled()
    }
    mocks.subtitleRows.mockReturnValue([])
    expect(await invoke(IPC.SUBTITLES.GET_FOR_VIDEO, 'lib', 'video')).toEqual({
      ok: true,
      value: [],
    })
    expect(mocks.syncSidecarSubtitlesForVideo).not.toHaveBeenCalled()
  })
})
