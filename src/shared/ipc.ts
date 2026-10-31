import { PlaybackRateZ } from './playbackRate'
import { z } from 'zod'
import { SeekStepSecZ } from './playerSettings'
import { SubtitleConcurrencyZ } from './subtitleQueue'
import { AppUpdateStateZ } from './appUpdate'

import { PrivacySettingsZ } from './privacy'
import { DiscoveryQueryZ, DiscoveryPreferencesZ } from './discovery'
import {
  StashSettingsPatchZ,
  MetadataSearchZ,
  MetadataSearchModeZ,
  MetadataApplyZ,
} from './metadataImport'
import { CleanupRuleZ } from './maintenance'
import type { HighlightCreate, ImportProgress, SearchQuery, VideoMeta } from './types'

import { IPC } from './channels'
export { IPC } from './channels'

const IdZ = z.string().min(1)
const FilePathZ = z.string().min(1)
const FolderPathsZ = z.array(FilePathZ).min(1).max(100)
const EmptyArgsZ = z.tuple([])
const LibraryIdArgsZ = z.tuple([IdZ])
const VideoArgsZ = z.tuple([IdZ, IdZ])
const TimeZ = z.number().finite().nonnegative()
const VideoEventZ = z.object({ videoId: IdZ }).strict()
const NativePlayerNameZ = z.enum(['mpv', 'ffplay', 'vlc'])
const NativePlayerInfoZ = z.object({ name: NativePlayerNameZ, path: FilePathZ }).strict()

export const SubtitleGenerationOptionsZ = z
  .object({
    model: z.enum(['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3']),
    language: z.enum(['auto', 'ja', 'en', 'ko', 'zh']),
    translateToKorean: z.boolean(),
  })
  .strict()

export const CloudTranslationSettingsPatchZ = z
  .object({
    enabled: z.boolean().optional(),
    apiKey: z.string().max(512).optional(),
    removeApiKey: z.boolean().optional(),
    monthlyLimit: z.number().int().min(0).max(500_000).optional(),
    externalCharacters: z.number().int().min(0).max(500_000).optional(),
  })
  .strict()

export const CsvImportOptionsZ = z
  .object({
    importRatings: z.boolean(),
    importFavoritesAsHighlights: z.boolean(),
  })
  .strict()

export const NativePlayerOptionsZ = z
  .object({
    startTimeSec: TimeZ.optional(),
    playbackRate: PlaybackRateZ.optional(),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  })
  .strict()

export const NativePlayerActionEventZ = VideoEventZ.extend({
  action: z.enum(['previousHighlight', 'nextHighlight', 'saveHighlight', 'setThumbnail']),
  timeSec: TimeZ,
}).strict()

export const ImageCaptureDataUrlZ = z
  .string()
  .regex(
    /^data:image\/(?:jpeg|jpg|png);base64,[A-Za-z0-9+/]+={0,2}$/,
    'JPEG 또는 PNG base64 이미지가 필요합니다',
  )

export const ImportResultZ = z.object({
  cancelled: z.boolean().optional(),
  added: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  errors: z.array(z.string()),
})

export const ImportProgressZ = z.object({
  libraryId: IdZ.optional(),
  phase: z.enum([
    'scanning',
    'probing',
    'thumbnails',
    'done',
    'cancelled',
    'preparing',
    'applying',
  ]),
  total: z.number().int().nonnegative(),
  current: z.number().int().nonnegative(),
  currentFile: z.string().min(1).optional(),
  errors: z.array(z.string()),
})

export const SearchQueryZ = z
  .object({
    removed: z.boolean().optional(),
    q: z.string().optional(),
    category: z.string().optional(),
    tag: z.string().optional(),
    rating: z.number().int().min(1).max(5).optional(),
    hasSubtitles: z.boolean().optional(),
    sortBy: z
      .enum([
        'title',
        'rating',
        'createdAt',
        'lastPlayedAt',
        'durationSec',
        'fileName',
        'playCount',
        'playTimeSec',
      ])
      .optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
  })
  .strict()

export const VideoMetaZ = z
  .object({
    title: z.string().optional(),
    rating: z.number().min(0).max(5).multipleOf(0.5).optional(),
    memo: z.string().optional(),
    tags: z.string().optional(),
    category: z.string().optional(),
    lastPlayedAt: z.string().min(1).optional(),
    playCount: z.number().int().nonnegative().optional(),
    playTimeSec: TimeZ.optional(),
  })
  .strict()

export const HighlightCreateZ = z
  .object({
    videoId: IdZ,
    timeStart: z.number().finite().nonnegative(),
    timeEnd: z.number().finite().nonnegative().optional(),
    label: z.string().optional(),
    color: z.enum(['yellow', 'red', 'blue', 'green', 'purple']).optional(),
  })
  .strict()

export const HighlightPatchZ = HighlightCreateZ.partial().strict()

export const IPC_SCHEMAS = {
  [IPC.APP_UPDATE.GET]: EmptyArgsZ,
  [IPC.APP_UPDATE.CHECK]: EmptyArgsZ,
  [IPC.APP_UPDATE.DOWNLOAD]: EmptyArgsZ,
  [IPC.APP_UPDATE.INSTALL]: EmptyArgsZ,
  [IPC.APP_UPDATE.SET_AUTOMATIC]: z.tuple([z.boolean()]),
  [IPC.APP_UPDATE.OPEN_RELEASE]: EmptyArgsZ,
  [IPC.TEMPORARY_PLAYBACK.OPEN]: z.tuple([FilePathZ.max(32767)]),
  [IPC.TEMPORARY_PLAYBACK.CLOSE]: z.tuple([z.string().uuid()]),
  [IPC.PRIVACY.GET]: EmptyArgsZ,
  [IPC.PRIVACY.SAVE]: z.tuple([PrivacySettingsZ]),
  [IPC.PRIVACY.EXIT]: EmptyArgsZ,
  [IPC.DISCOVERY.QUERY]: z.tuple([IdZ, DiscoveryQueryZ]),
  [IPC.DISCOVERY.FAVORITE]: z.tuple([IdZ, IdZ, z.boolean()]),
  [IPC.DISCOVERY.TAGS]: z.tuple([IdZ, DiscoveryPreferencesZ.shape.preferredTags]),
  [IPC.MAINTENANCE.PREVIEW_NAMES]: z.tuple([IdZ, CleanupRuleZ]),
  [IPC.MAINTENANCE.APPLY_NAMES]: z.tuple([
    IdZ,
    z.string().uuid(),
    z
      .array(IdZ)
      .min(1)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length),
  ]),
  [IPC.MAINTENANCE.FIND_DUPLICATES]: LibraryIdArgsZ,
  [IPC.MAINTENANCE.CANCEL]: LibraryIdArgsZ,
  [IPC.APP.QUIT]: EmptyArgsZ,
  [IPC.APP.CLAIM_GITHUB_STAR_PROMPT]: EmptyArgsZ,
  [IPC.APP.OPEN_GITHUB_REPOSITORY]: EmptyArgsZ,
  [IPC.APP.GET_SETTINGS]: EmptyArgsZ,
  [IPC.APP.GET_NATIVE_PLAYERS]: EmptyArgsZ,
  [IPC.APP.SELECT_NATIVE_PLAYER]: z.tuple([NativePlayerNameZ]),
  [IPC.APP.UPDATE_SETTINGS]: z.tuple([
    z
      .object({
        cacheLimitGb: z.number().finite().min(1).max(1000).optional(),
        seekStepSec: SeekStepSecZ.optional(),
        nativePlayer: NativePlayerInfoZ.nullable().optional(),
      })
      .strict(),
  ]),
  [IPC.APP.GET_CACHE_INFO]: EmptyArgsZ,
  [IPC.APP.GET_ACCELERATION_INFO]: EmptyArgsZ,
  [IPC.APP.CLEAN_CACHE]: EmptyArgsZ,
  [IPC.DATA_IMPORT.SELECT_CSV]: EmptyArgsZ,
  [IPC.DATA_IMPORT.PREVIEW]: z.tuple([IdZ, FilePathZ]),
  [IPC.DATA_IMPORT.IMPORT]: z.tuple([IdZ, FilePathZ, CsvImportOptionsZ]),
  [IPC.METADATA_IMPORT.GET_SETTINGS]: EmptyArgsZ,
  [IPC.METADATA_IMPORT.UPDATE_SETTINGS]: z.tuple([StashSettingsPatchZ]),
  [IPC.METADATA_IMPORT.SEARCH]: z.tuple([MetadataSearchZ, MetadataSearchModeZ.optional()]),
  [IPC.METADATA_IMPORT.APPLY]: z.tuple([IdZ, IdZ, MetadataApplyZ]),
  [IPC.LIBRARY.LIST]: EmptyArgsZ,
  [IPC.LIBRARY.OPEN]: LibraryIdArgsZ,
  [IPC.LIBRARY.CREATE]: z.tuple([z.string().min(1), z.union([FilePathZ, FolderPathsZ])]),
  [IPC.LIBRARY.CLOSE]: LibraryIdArgsZ,
  [IPC.LIBRARY.IMPORT_FOLDER]: z.tuple([IdZ, FilePathZ]),
  [IPC.LIBRARY.IMPORT_FOLDERS]: z.tuple([IdZ, FolderPathsZ]),
  [IPC.LIBRARY.IMPORT_FILES]: z.tuple([IdZ, z.array(FilePathZ).min(1).max(1000)]),
  [IPC.LIBRARY.SELECT_FILES]: EmptyArgsZ,
  [IPC.LIBRARY.REFRESH]: LibraryIdArgsZ,
  [IPC.LIBRARY.CANCEL_WORK]: LibraryIdArgsZ,
  [IPC.LIBRARY.SELECT_FOLDER]: EmptyArgsZ,
  [IPC.LIBRARY.SELECT_FOLDERS]: EmptyArgsZ,
  [IPC.LIBRARY.DELETE]: LibraryIdArgsZ,
  [IPC.VIDEOS.SEARCH]: z.tuple([IdZ, SearchQueryZ]),
  [IPC.VIDEOS.METADATA_OPTIONS]: z.tuple([IdZ, z.boolean().optional()]),
  [IPC.VIDEOS.GET]: VideoArgsZ,
  [IPC.VIDEOS.REVEAL_SOURCE]: VideoArgsZ,
  [IPC.VIDEOS.GET_PLAYBACK_SOURCE]: VideoArgsZ,
  [IPC.VIDEOS.GET_NATIVE_PLAYER_INFO]: EmptyArgsZ,
  [IPC.VIDEOS.OPEN_IN_NATIVE_PLAYER]: z.tuple([IdZ, IdZ, NativePlayerOptionsZ.optional()]),
  [IPC.VIDEOS.SET_ACTIVE_PLAYBACK_RATE]: z.tuple([IdZ, IdZ, PlaybackRateZ]),
  [IPC.VIDEOS.SEEK_ACTIVE_PLAYBACK]: z.tuple([IdZ, IdZ, TimeZ]),
  [IPC.VIDEOS.UPDATE_META]: z.tuple([IdZ, IdZ, VideoMetaZ]),
  [IPC.VIDEOS.DELETE]: z.tuple([IdZ, IdZ, z.enum(['trash', 'remove']).optional()]),
  [IPC.VIDEOS.RESTORE]: VideoArgsZ,
  [IPC.PLAYBACK.START]: VideoArgsZ,
  [IPC.PLAYBACK.LIST_CONVERSION_QUEUE]: EmptyArgsZ,
  [IPC.PLAYBACK.PAUSE_CONVERSION]: z.tuple([z.string().uuid()]),
  [IPC.PLAYBACK.RESUME_CONVERSION]: z.tuple([z.string().uuid()]),
  [IPC.PLAYBACK.REMOVE_CONVERSION]: z.tuple([z.string().uuid()]),
  [IPC.PLAYBACK.HEARTBEAT]: z.tuple([IdZ, IdZ, z.number().finite().nonnegative()]),
  [IPC.PLAYBACK.SEEK]: z.tuple([IdZ, IdZ, TimeZ]),
  [IPC.PLAYBACK.END]: z.tuple([IdZ, IdZ, z.number().finite().nonnegative()]),
  [IPC.THUMBNAILS.GET_FOR_VIDEO]: VideoArgsZ,
  [IPC.THUMBNAILS.LIST_JOBS]: LibraryIdArgsZ,
  [IPC.THUMBNAILS.CANCEL_FOR_VIDEO]: VideoArgsZ,
  [IPC.THUMBNAILS.SET_PRIMARY]: z.tuple([IdZ, IdZ, IdZ]),
  [IPC.THUMBNAILS.ENSURE_FOR_VIDEO]: z.tuple([IdZ, IdZ, z.boolean().optional()]),
  [IPC.THUMBNAILS.CAPTURE_AT_TIME]: z.tuple([IdZ, IdZ, TimeZ, z.boolean().optional()]),
  [IPC.THUMBNAILS.SAVE_IMAGE_CAPTURE]: z.tuple([
    IdZ,
    IdZ,
    TimeZ,
    ImageCaptureDataUrlZ,
    z.boolean().optional(),
  ]),
  [IPC.HIGHLIGHTS.LIST]: VideoArgsZ,
  [IPC.HIGHLIGHTS.CREATE]: z.tuple([IdZ, HighlightCreateZ]),
  [IPC.HIGHLIGHTS.UPDATE]: z.tuple([IdZ, IdZ, HighlightPatchZ]),
  [IPC.HIGHLIGHTS.DELETE]: VideoArgsZ,
  [IPC.SUBTITLES.GET_FOR_VIDEO]: VideoArgsZ,
  [IPC.SUBTITLES.GET_SETUP_STATUS]: EmptyArgsZ,
  [IPC.SUBTITLES.CHECK_SETUP]: EmptyArgsZ,
  [IPC.SUBTITLES.START_SETUP]: EmptyArgsZ,
  [IPC.SUBTITLES.CANCEL_SETUP]: EmptyArgsZ,
  [IPC.SUBTITLES.LIST_QUEUE]: EmptyArgsZ,
  [IPC.SUBTITLES.GET_CONCURRENCY]: EmptyArgsZ,
  [IPC.SUBTITLES.SET_CONCURRENCY]: z.tuple([SubtitleConcurrencyZ]),
  [IPC.SUBTITLES.GET_TRANSLATION_SETTINGS]: EmptyArgsZ,
  [IPC.SUBTITLES.UPDATE_TRANSLATION_SETTINGS]: z.tuple([CloudTranslationSettingsPatchZ]),
  [IPC.SUBTITLES.PAUSE_JOB]: z.tuple([z.string().uuid()]),
  [IPC.SUBTITLES.RESUME_JOB]: z.tuple([z.string().uuid()]),
  [IPC.SUBTITLES.REMOVE_JOB]: z.tuple([z.string().uuid()]),
  [IPC.SUBTITLES.GET_ENGINE_INFO]: EmptyArgsZ,
  [IPC.SUBTITLES.GENERATE]: z.tuple([IdZ, IdZ, SubtitleGenerationOptionsZ]),
  [IPC.SUBTITLES.REGENERATE]: z.tuple([
    IdZ,
    IdZ,
    z
      .array(IdZ)
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length),
    SubtitleGenerationOptionsZ,
  ]),
  [IPC.SUBTITLES.GET_GENERATION_STATUS]: VideoArgsZ,
  [IPC.SUBTITLES.CANCEL_GENERATION]: VideoArgsZ,
  [IPC.SUBTITLES.CONVERT_TO_VTT]: z.tuple([IdZ, FilePathZ, z.enum(['smi', 'srt'])]),
  [IPC.SUBTITLES.READ_TEXT]: z.tuple([IdZ, FilePathZ]),
  [IPC.STATS.GET]: z.tuple([IdZ, z.number().int().min(1).max(365).optional()]),
} as const

export const IPC_EVENT_SCHEMAS = {
  [IPC.EVENTS.APP_UPDATE_CHANGED]: AppUpdateStateZ,
  [IPC.EVENTS.IMPORT_PROGRESS]: ImportProgressZ,
  [IPC.EVENTS.THUMBNAIL_READY]: VideoEventZ,
  [IPC.EVENTS.HIGHLIGHT_CHANGED]: VideoEventZ,
  [IPC.EVENTS.NATIVE_PLAYER_ESCAPE]: VideoEventZ,
  [IPC.EVENTS.NATIVE_PLAYER_SPEED]: VideoEventZ.extend({
    rate: z.number().finite().min(0.01).max(100),
  }).strict(),
  [IPC.EVENTS.NATIVE_PLAYER_ACTION]: NativePlayerActionEventZ,
} as const

export const INVOKE_CHANNELS = Object.keys(IPC_SCHEMAS) as [
  keyof typeof IPC_SCHEMAS,
  ...(keyof typeof IPC_SCHEMAS)[],
]

export const EVENT_CHANNELS = Object.keys(IPC_EVENT_SCHEMAS) as [
  keyof typeof IPC_EVENT_SCHEMAS,
  ...(keyof typeof IPC_EVENT_SCHEMAS)[],
]

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type EventChannel = (typeof EVENT_CHANNELS)[number]
export type InvokeArgs<C extends InvokeChannel> = z.infer<(typeof IPC_SCHEMAS)[C]>
export type EventPayload<C extends EventChannel> = z.infer<(typeof IPC_EVENT_SCHEMAS)[C]>

export type { HighlightCreate, ImportProgress, SearchQuery, VideoMeta }
