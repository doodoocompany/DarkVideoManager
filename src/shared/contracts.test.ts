import { describe, expect, it } from 'vitest'

import {
  IPC,
  IPC_SCHEMAS,
  IPC_EVENT_SCHEMAS,
  INVOKE_CHANNELS,
  EVENT_CHANNELS,
  SearchQueryZ,
  VideoMetaZ,
  NativePlayerActionEventZ,
} from './ipc'
import {
  DOMAIN_ERROR_CODES,
  domainError,
  err,
  isDomainError,
  isErr,
  isOk,
  ok,
  toDomainError,
} from './result'

describe('IPC contracts', () => {
  it('accepts every half-star rating without relaxing integer playback counts', () => {
    const schema = IPC_SCHEMAS[IPC.VIDEOS.UPDATE_META]
    for (let rating = 0; rating <= 5; rating += 0.5) {
      expect(schema.parse(['lib', 'video', { rating }])).toEqual(['lib', 'video', { rating }])
    }
    for (const rating of [-0.5, 5.5, 0.25, 3.7, NaN, Infinity, '4.5']) {
      expect(schema.safeParse(['lib', 'video', { rating }]).success).toBe(false)
    }
    expect(VideoMetaZ.safeParse({ rating: 4.5, playCount: 1.5 }).success).toBe(false)
  })

  it('accepts update actions without accepting a feed URL, path, version or arbitrary settings', () => {
    for (const channel of [
      IPC.APP_UPDATE.GET,
      IPC.APP_UPDATE.CHECK,
      IPC.APP_UPDATE.DOWNLOAD,
      IPC.APP_UPDATE.INSTALL,
      IPC.APP_UPDATE.OPEN_RELEASE,
    ]) {
      expect(IPC_SCHEMAS[channel].safeParse([]).success).toBe(true)
      for (const value of ['https://example.com/feed', 'C:/installer.exe', { version: '9.0.0' }]) {
        expect(IPC_SCHEMAS[channel].safeParse([value]).success).toBe(false)
      }
    }
    expect(IPC_SCHEMAS[IPC.APP_UPDATE.SET_AUTOMATIC].safeParse([false]).success).toBe(true)
    expect(IPC_SCHEMAS[IPC.APP_UPDATE.SET_AUTOMATIC].safeParse(['false']).success).toBe(false)
  })
  it('keeps single folder creation compatible and bounds multi-folder operations', () => {
    const create = IPC_SCHEMAS[IPC.LIBRARY.CREATE]
    expect(create.safeParse(['Videos', 'D:/']).success).toBe(true)
    expect(create.safeParse(['Videos', ['D:/', 'E:/Movies']]).success).toBe(true)
    const folders = IPC_SCHEMAS[IPC.LIBRARY.IMPORT_FOLDERS]
    expect(folders.safeParse(['lib', ['D:/', 'E:/Movies']]).success).toBe(true)
    for (const paths of [[], [''], Array(101).fill('D:/'), 'D:/', undefined]) {
      expect(folders.safeParse(['lib', paths]).success).toBe(false)
      if (Array.isArray(paths)) expect(create.safeParse(['Videos', paths]).success).toBe(false)
    }
    expect(IPC_SCHEMAS[IPC.LIBRARY.SELECT_FOLDERS].safeParse([]).success).toBe(true)
    expect(IPC_SCHEMAS[IPC.LIBRARY.SELECT_FOLDERS].safeParse(['D:/']).success).toBe(false)
  })
  it('bounds requested playback rates and accepts native speed reports independently', () => {
    for (const rate of [0.25, 1, 1.5, 4]) {
      expect(
        IPC_SCHEMAS[IPC.VIDEOS.SET_ACTIVE_PLAYBACK_RATE].safeParse(['lib', 'video', rate]).success,
      ).toBe(true)
      expect(
        IPC_SCHEMAS[IPC.VIDEOS.OPEN_IN_NATIVE_PLAYER].safeParse([
          'lib',
          'video',
          { playbackRate: rate },
        ]).success,
      ).toBe(true)
    }
    for (const rate of [0, -1, 0.24, 4.01, NaN, Infinity, '1.5']) {
      expect(
        IPC_SCHEMAS[IPC.VIDEOS.SET_ACTIVE_PLAYBACK_RATE].safeParse(['lib', 'video', rate]).success,
      ).toBe(false)
    }
    expect(
      IPC_EVENT_SCHEMAS[IPC.EVENTS.NATIVE_PLAYER_SPEED].safeParse({ videoId: 'video', rate: 5 })
        .success,
    ).toBe(true)
  })
  it('does not accept renderer URLs or account details for the GitHub quick link', () => {
    for (const channel of [IPC.APP.CLAIM_GITHUB_STAR_PROMPT, IPC.APP.OPEN_GITHUB_REPOSITORY]) {
      expect(IPC_SCHEMAS[channel].safeParse([]).success).toBe(true)
      for (const args of [
        ['https://example.com'],
        ['file:///C:/Windows/notepad.exe'],
        [{ token: 'x' }],
      ])
        expect(IPC_SCHEMAS[channel].safeParse(args).success).toBe(false)
    }
    expect(
      IPC_SCHEMAS[IPC.APP.UPDATE_SETTINGS].safeParse([{ githubStarPromptShown: false }]).success,
    ).toBe(false)
  })
  it('bounds statistics to one through 365 days', () => {
    const schema = IPC_SCHEMAS[IPC.STATS.GET]
    expect(schema.safeParse(['library']).success).toBe(true)
    for (const days of [1, 7, 30, 90, 365])
      expect(schema.safeParse(['library', days]).success).toBe(true)
    for (const days of [0, -1, 366, 1.5, Infinity, NaN, '30'])
      expect(schema.safeParse(['library', days]).success).toBe(false)
  })
  it('only accepts queue job identifiers for conversion controls', () => {
    expect(IPC_SCHEMAS[IPC.PLAYBACK.LIST_CONVERSION_QUEUE].safeParse([]).success).toBe(true)
    for (const channel of [
      IPC.PLAYBACK.PAUSE_CONVERSION,
      IPC.PLAYBACK.RESUME_CONVERSION,
      IPC.PLAYBACK.REMOVE_CONVERSION,
    ]) {
      const schema = IPC_SCHEMAS[channel]
      expect(schema.safeParse(['dd270470-14f8-45ed-af6e-f3b2da7c86d3']).success).toBe(true)
      for (const args of [[], [''], ['C:/videos/movie.mp4'], ['../library'], ['id', 'extra']])
        expect(schema.safeParse(args).success).toBe(false)
    }
  })
  it('restricts translation budgets and rejects usage-counter or credential readback fields', () => {
    const schema = IPC_SCHEMAS[IPC.SUBTITLES.UPDATE_TRANSLATION_SETTINGS]
    expect(
      schema.safeParse([
        { apiKey: 'test-key', enabled: true, monthlyLimit: 500_000, externalCharacters: 10 },
      ]).success,
    ).toBe(true)
    for (const patch of [
      { monthlyLimit: 500_001 },
      { monthlyLimit: -1 },
      { monthlyLimit: 1.1 },
      { externalCharacters: -1 },
      { usedCharacters: 0 },
      { encryptedApiKey: 'x' },
      { apiKey: 'x'.repeat(513) },
    ])
      expect(schema.safeParse([patch]).success).toBe(false)
    expect(IPC_SCHEMAS[IPC.SUBTITLES.GET_TRANSLATION_SETTINGS].safeParse([]).success).toBe(true)
  })
  it('requires an explicit unique subtitle selection for regeneration', () => {
    const schema = IPC_SCHEMAS[IPC.SUBTITLES.REGENERATE]
    const options = { model: 'base', language: 'auto', translateToKorean: true }
    expect(schema.safeParse(['lib', 'video', ['sub-1', 'sub-2'], options]).success).toBe(true)
    for (const selection of [[], ['sub', 'sub'], [''], undefined, 'C:/videos/movie.srt']) {
      expect(schema.safeParse(['lib', 'video', selection, options]).success).toBe(false)
    }
    expect(
      schema.safeParse(['lib', 'video', ['sub'], { ...options, model: 'unknown' }]).success,
    ).toBe(false)
  })

  it('accepts large-v2 for generation and regeneration without widening model input', () => {
    const options = { model: 'large-v2', language: 'auto', translateToKorean: true }
    expect(IPC_SCHEMAS[IPC.SUBTITLES.GENERATE].parse(['lib', 'video', options])[2]).toEqual(options)
    expect(
      IPC_SCHEMAS[IPC.SUBTITLES.REGENERATE].parse(['lib', 'video', ['subtitle'], options])[3],
    ).toEqual(options)
    for (const model of ['large', 'large-v2.en', '../large-v2']) {
      expect(
        IPC_SCHEMAS[IPC.SUBTITLES.GENERATE].safeParse(['lib', 'video', { ...options, model }])
          .success,
      ).toBe(false)
    }
  })

  it('accepts explicit seek positions and rejects invalid positional inputs', () => {
    const seek = IPC_SCHEMAS[IPC.PLAYBACK.SEEK]
    expect(seek.safeParse(['library', 'video', 0]).success).toBe(true)
    expect(seek.safeParse(['library', 'video', 12.5]).success).toBe(true)
    for (const invalid of [-1, NaN, Infinity, '1'])
      expect(seek.safeParse(['library', 'video', invalid]).success).toBe(false)
    expect(seek.safeParse(['library', 'video']).success).toBe(false)
    expect(seek.safeParse(['library', 'video', 1, 'unexpected']).success).toBe(false)
  })

  it('registers every invoke channel with a positional schema', () => {
    expect(INVOKE_CHANNELS.length).toBeGreaterThanOrEqual(39)
    expect(EVENT_CHANNELS).toHaveLength(7)
    const { EVENTS, ...invokeGroups } = IPC
    expect(new Set(INVOKE_CHANNELS)).toEqual(
      new Set(Object.values(invokeGroups).flatMap(Object.values)),
    )
    expect(new Set(EVENT_CHANNELS)).toEqual(new Set(Object.values(EVENTS)))
    expect(IPC_SCHEMAS[IPC.LIBRARY.LIST].safeParse([]).success).toBe(true)
    expect(IPC_SCHEMAS[IPC.LIBRARY.LIST].safeParse(['unexpected']).success).toBe(false)
    expect(
      IPC_SCHEMAS[IPC.PLAYBACK.HEARTBEAT].safeParse(['library-1', 'video-1', 12.5]).success,
    ).toBe(true)
  })

  it('accepts only supported integer seek intervals in settings updates', () => {
    for (const seekStepSec of [1, 5, 30, 600]) {
      expect(IPC_SCHEMAS[IPC.APP.UPDATE_SETTINGS].safeParse([{ seekStepSec }]).success).toBe(true)
    }
    for (const seekStepSec of [0, -1, 1.5, 601, NaN, Infinity, '10', null]) {
      expect(IPC_SCHEMAS[IPC.APP.UPDATE_SETTINGS].safeParse([{ seekStepSec }]).success).toBe(false)
    }
  })

  it('rejects unknown search fields and invalid ranges', () => {
    expect(IPC_SCHEMAS[IPC.APP.UPDATE_SETTINGS].safeParse([{ cacheLimitGb: 10 }]).success).toBe(
      true,
    )
    expect(IPC_SCHEMAS[IPC.APP.UPDATE_SETTINGS].safeParse([{ cacheLimitGb: 0 }]).success).toBe(
      false,
    )
    expect(
      IPC_SCHEMAS[IPC.APP.UPDATE_SETTINGS].safeParse([{ cacheLimitGb: Infinity }]).success,
    ).toBe(false)
    expect(SearchQueryZ.safeParse({ q: 'sample', page: 1, pageSize: 50 }).success).toBe(true)
    expect(SearchQueryZ.safeParse({ rating: 6 }).success).toBe(false)
    expect(SearchQueryZ.safeParse({ unknown: true }).success).toBe(false)
    expect(SearchQueryZ.safeParse({ sortBy: 'playCount' }).success).toBe(true)
    expect(SearchQueryZ.safeParse({ sortBy: 'playTimeSec' }).success).toBe(true)
    expect(VideoMetaZ.safeParse({ tags: 'travel, family' }).success).toBe(true)
    expect(VideoMetaZ.safeParse({ category: '', tags: '#선수명' }).success).toBe(true)
    expect(SearchQueryZ.safeParse({ category: '', tag: '#선수명' }).success).toBe(true)
    expect(SearchQueryZ.safeParse({ category: 3 }).success).toBe(false)
    expect(SearchQueryZ.safeParse({ tag: ['선수명'] }).success).toBe(false)
    expect(IPC_SCHEMAS[IPC.VIDEOS.METADATA_OPTIONS].safeParse(['lib']).success).toBe(true)
    expect(IPC_SCHEMAS[IPC.VIDEOS.METADATA_OPTIONS].safeParse(['lib', true]).success).toBe(true)
    expect(IPC_SCHEMAS[IPC.VIDEOS.METADATA_OPTIONS].safeParse(['lib', 'false']).success).toBe(false)
  })

  it('accepts optional boolean subtitle filters without coercing other values', () => {
    expect(SearchQueryZ.parse({})).not.toHaveProperty('hasSubtitles')
    for (const hasSubtitles of [true, false]) {
      const query = { hasSubtitles, q: 'sample', rating: 4, page: 2, pageSize: 10 }
      expect(IPC_SCHEMAS[IPC.VIDEOS.SEARCH].parse(['library-1', query])).toEqual([
        'library-1',
        query,
      ])
    }
    for (const hasSubtitles of ['false', 0, 1, null]) {
      expect(SearchQueryZ.safeParse({ hasSubtitles }).success).toBe(false)
    }
  })

  it('requires explicit import options and rejects malformed mutations', () => {
    expect(IPC_SCHEMAS[IPC.VIDEOS.DELETE].safeParse(['lib', 'video', 'trash']).success).toBe(true)
    expect(IPC_SCHEMAS[IPC.VIDEOS.DELETE].safeParse(['lib', 'video', 'remove']).success).toBe(true)
    expect(IPC_SCHEMAS[IPC.VIDEOS.DELETE].safeParse(['lib', 'video', 'permanent']).success).toBe(
      false,
    )
    const csv = IPC_SCHEMAS[IPC.DATA_IMPORT.IMPORT]
    expect(
      csv.safeParse([
        'lib',
        'history.csv',
        { importRatings: true, importFavoritesAsHighlights: false },
      ]).success,
    ).toBe(true)
    expect(csv.safeParse(['lib', 'history.csv', { importRatings: 'yes' }]).success).toBe(false)
    expect(csv.safeParse(['lib', 'history.csv']).success).toBe(false)
  })

  it('validates native player coordinates, timestamps and image captures', () => {
    const open = IPC_SCHEMAS[IPC.VIDEOS.OPEN_IN_NATIVE_PLAYER]
    expect(open.safeParse(['lib', 'video']).success).toBe(true)
    expect(
      open.safeParse(['lib', 'video', { x: -1920, y: 0, width: 1280, startTimeSec: 1.5 }]).success,
    ).toBe(true)
    expect(open.safeParse(['lib', 'video', { width: 0 }]).success).toBe(false)
    expect(open.safeParse(['lib', 'video', { startTimeSec: Infinity }]).success).toBe(false)
    expect(
      IPC_SCHEMAS[IPC.VIDEOS.SEEK_ACTIVE_PLAYBACK].safeParse(['lib', 'video', -1]).success,
    ).toBe(false)
    const capture = IPC_SCHEMAS[IPC.THUMBNAILS.SAVE_IMAGE_CAPTURE]
    expect(
      capture.safeParse(['lib', 'video', 2.5, 'data:image/jpeg;base64,/9j/AA==', false]).success,
    ).toBe(true)
    expect(capture.safeParse(['lib', 'video', 2.5, 'file:///private.txt']).success).toBe(false)
    expect(capture.safeParse(['lib', 'video', NaN, 'data:image/png;base64,AAAA']).success).toBe(
      false,
    )
  })

  it('validates every restored event payload', () => {
    expect(
      IPC_EVENT_SCHEMAS[IPC.EVENTS.HIGHLIGHT_CHANGED].safeParse({ videoId: 'video' }).success,
    ).toBe(true)
    expect(
      IPC_EVENT_SCHEMAS[IPC.EVENTS.NATIVE_PLAYER_ESCAPE].safeParse({ videoId: '' }).success,
    ).toBe(false)
    expect(
      NativePlayerActionEventZ.safeParse({ videoId: 'video', action: 'setThumbnail', timeSec: 1.2 })
        .success,
    ).toBe(true)
    expect(
      NativePlayerActionEventZ.safeParse({ videoId: 'video', action: 'runCommand', timeSec: 0 })
        .success,
    ).toBe(false)
  })
})

describe('Result contracts', () => {
  it('distinguishes successful and failed values', () => {
    const success = ok({ id: 'video-1' })
    const failure = err(domainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'video not found'))

    expect(isOk(success)).toBe(true)
    expect(isErr(success)).toBe(false)
    expect(isErr(failure)).toBe(true)
    expect(isDomainError(failure.error)).toBe(true)
  })

  it('normalizes unknown errors without losing Error messages', () => {
    expect(toDomainError(new Error('disk full'))).toEqual({
      code: DOMAIN_ERROR_CODES.INTERNAL,
      message: 'disk full',
    })
    expect(toDomainError('bad input', 'fallback')).toEqual({
      code: DOMAIN_ERROR_CODES.INTERNAL,
      message: 'fallback',
    })
  })
})
