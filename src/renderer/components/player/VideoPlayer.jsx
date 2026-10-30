import PlaybackRateControl from './PlaybackRateControl'
import AbRepeatControl from './AbRepeatControl'
import { createAbRepeatController, repeatRangeError } from '../../utils/abRepeat'
import { PlaybackRateZ } from '../../../shared/playbackRate'
// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useLibraryStore } from '../../store/libraryStore'
import { toLocalMediaUrl } from '../../utils/media'
import { createSeekController } from '../../utils/seekController'
import { needsCompatiblePlayback } from '../../../shared/playback'
import { usePlaybackConversionQueue } from '../../api/usePlaybackConversionQueue'
import { ConversionQueueItem } from './PlaybackConversionQueue'
import SubtitleNavigator from './SubtitleNavigator'
import { usePlayerView } from './usePlayerView'
import { FullscreenViewToggle, PlaybackInfo, PlayerViewControls } from './PlayerViewControls'
import { DEFAULT_SEEK_STEP_SEC } from '@shared/playerSettings'
function VideoPlayer({
  video,
  libraryId,
  seekRequest,
  onNativeLaunchPendingChange,
  subtitleNavigationTarget,
  isMaximized,
  onToggleMaximized,
  onFullscreenChange,
}) {
  const playbackInstanceId = React.useId()
  const [playbackSourceEpoch, setPlaybackSourceEpoch] = React.useState(0)
  const videoRef = React.useRef(null)
  const seekControllerRef = React.useRef(null)
  const pendingSeekRecordRef = React.useRef(false)
  const mouseSeekingRef = React.useRef(false)
  const lastPositionRef = React.useRef(video.resumePosSec ?? 0)
  const nativePlaybackRef = React.useRef(false)
  const nativeLaunchPendingRef = React.useRef(false)
  const nativeLaunchViewRef = React.useRef({ active: false })
  React.useEffect(() => {
    const view = { active: true }
    nativeLaunchViewRef.current = view
    return () => {
      view.active = false
    }
  }, [libraryId, video.id])
  const [nativeLaunchError, setNativeLaunchError] = React.useState(null)
  const [mediaPlaybackError, setMediaPlaybackError] = React.useState(null)
  const [playerActionError, setPlayerActionError] = React.useState(null)
  const [playbackRecordError, setPlaybackRecordError] = React.useState(null)
  const recordPlayback = React.useCallback(async (request) => {
    try {
      const result = await request
      if (!result.ok) throw new Error(result.error)
    } catch (error) {
      setPlaybackRecordError(
        `재생 기록을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }, [])
  const containerRef = React.useRef(null)
  const initializedResumeForVideoRef = React.useRef(null)
  const heartbeatRef = React.useRef(null)
  const smoothSeekTimerRef = React.useRef(null)
  const smoothSeekStartTimerRef = React.useRef(null)
  const activeSeekKeyRef = React.useRef(null)
  const smoothSeekStartedAtRef = React.useRef(0)
  const modifierStateRef = React.useRef({
    shift: false,
    ctrl: false,
  })
  const stopSmoothSeek = React.useCallback((finish = true) => {
    activeSeekKeyRef.current = null
    smoothSeekStartedAtRef.current = 0
    modifierStateRef.current = { shift: false, ctrl: false }
    if (smoothSeekStartTimerRef.current) clearTimeout(smoothSeekStartTimerRef.current)
    if (smoothSeekTimerRef.current) clearInterval(smoothSeekTimerRef.current)
    smoothSeekStartTimerRef.current = smoothSeekTimerRef.current = null
    if (finish) seekControllerRef.current?.finish()
  }, [])
  const [statusMessage, setStatusMessage] = React.useState(null)
  const [activeSubtitleText, setActiveSubtitleText] = React.useState(null)
  const [isSubtitleEnabled, setIsSubtitleEnabled] = React.useState(true)
  const [subtitleSelection, setSubtitleSelection] = React.useState(null)
  const [useInAppPlayback, setUseInAppPlayback] = React.useState(
    !video.filePath.toLowerCase().endsWith('.avi'),
  )
  const enableInAppPlayback = React.useCallback(() => {
    setPlaybackRate((value) => (PlaybackRateZ.safeParse(value).success ? value : 1))
    if (!useInAppPlayback) setPlaybackSourceEpoch((value) => value + 1)
    setUseInAppPlayback(true)
  }, [useInAppPlayback])
  const [currentTimeSec, setCurrentTimeSec] = React.useState(0)
  const [durationSec, setDurationSec] = React.useState(video.durationSec ?? 0)
  const [playbackRate, setPlaybackRate] = React.useState(1)
  const [speedPending, setSpeedPending] = React.useState(false)
  const [activeNativePlayer, setActiveNativePlayer] = React.useState(null)
  const [isPaused, setIsPaused] = React.useState(true)
  const [isSeekingWithMouse, setIsSeekingWithMouse] = React.useState(false)
  const [decodedSize, setDecodedSize] = React.useState({ width: 0, height: 0 })
  const viewEnabled = useInAppPlayback && !nativeLaunchPendingRef.current
  const view = usePlayerView(
    containerRef,
    videoRef,
    viewEnabled,
    video.id,
    setPlayerActionError,
    onFullscreenChange,
  )
  const handleViewKey = view.handleKey
  const { playerVolume, setPlayerVolume } = useLibraryStore()
  const navigate = useNavigate()
  const qc2 = useQueryClient()
  const { data: settings, error: settingsError } = useQuery({
    queryKey: ['app-settings'],
    queryFn: async () => {
      const result = await window.api.app.getSettings()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
  })
  const seekStepSec = settings?.seekStepSec ?? DEFAULT_SEEK_STEP_SEC
  const {
    data: subtitles = [],
    isLoading: areSubtitlesLoading,
    error: subtitlesError,
  } = useQuery({
    queryKey: ['subtitles', libraryId, video.id],
    queryFn: async () => {
      const res = await window.api.subtitles.getForVideo(libraryId, video.id)
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    retry: false,
  })
  const orderedSubtitles = React.useMemo(
    () => orderSubtitleTracks(subtitles, video.filePath),
    [subtitles, video.filePath],
  )
  const generationKey = orderedSubtitles
    .filter((subtitle) => generatedSubtitleInfo(subtitle.filePath, video.filePath))
    .map((subtitle) => subtitle.id)
    .join('|')
  const selectedSubtitleId =
    subtitleSelection?.videoId === video.id &&
    subtitleSelection?.generationKey === generationKey &&
    orderedSubtitles.some((subtitle) => subtitle.id === subtitleSelection.trackId)
      ? subtitleSelection.trackId
      : orderedSubtitles[0]?.id
  const selectSubtitleTrack = React.useCallback(
    (trackId) => {
      setSubtitleSelection({ videoId: video.id, generationKey, trackId })
      setIsSubtitleEnabled(true)
    },
    [generationKey, video.id],
  )
  const {
    data: subtitleTracks = [],
    isLoading: areSubtitleTracksLoading,
    error: subtitleTracksError,
  } = useQuery({
    queryKey: ['subtitle-tracks', libraryId, video.id, subtitles],
    queryFn: async () => {
      const resolved = await Promise.all(
        orderedSubtitles.map(async (subtitle) => {
          if (!subtitle.filePath || subtitle.isEmbedded) return subtitle
          if (subtitle.type === 'srt' || subtitle.type === 'smi') {
            try {
              const converted = await window.api.subtitles.convertToVtt(
                libraryId,
                subtitle.filePath,
                subtitle.type,
              )
              if (!converted.ok) throw new Error(converted.error)
              return {
                ...subtitle,
                filePath: converted.value,
                type: 'vtt',
              }
            } catch (error) {
              return {
                ...subtitle,
                loadError: `자막을 변환하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
              }
            }
          }
          return subtitle
        }),
      )
      return resolved.filter((track) => Boolean(track))
    },
    enabled: subtitles.length > 0,
    retry: false,
  })
  const selectedSubtitleTrack = subtitleTracks.find((track) => track.id === selectedSubtitleId)
  const {
    data: subtitleCues = [],
    isLoading: areSubtitleCuesLoading,
    error: subtitleCuesError,
  } = useQuery({
    queryKey: [
      'subtitle-cues',
      libraryId,
      video.id,
      selectedSubtitleTrack?.id,
      selectedSubtitleTrack?.filePath,
      selectedSubtitleTrack?.type,
      selectedSubtitleTrack?.loadError,
    ],
    queryFn: async () => {
      const primaryTrack = selectedSubtitleTrack
      if (primaryTrack?.isEmbedded) {
        throw new Error(
          '영상에 포함된 자막은 아직 탐색할 수 없습니다. SRT, VTT 또는 SMI 자막을 추가해 주세요.',
        )
      }
      if (!primaryTrack?.filePath) throw new Error('자막 파일 위치를 찾을 수 없습니다.')
      if (primaryTrack.loadError) throw new Error(primaryTrack.loadError)
      if (primaryTrack.type !== 'vtt' && primaryTrack.type !== 'srt') {
        throw new Error(
          '이 자막 형식은 아직 탐색할 수 없습니다. SRT, VTT 또는 SMI 자막을 선택해 주세요.',
        )
      }
      const response = await window.api.subtitles.readText(libraryId, primaryTrack.filePath)
      if (!response.ok) {
        throw new Error(response.error)
      }
      return parseSubtitleCues(response.value)
    },
    enabled:
      ((useInAppPlayback && isSubtitleEnabled) || Boolean(subtitleNavigationTarget)) &&
      Boolean(selectedSubtitleTrack),
    staleTime: Infinity,
    retry: false,
  })
  const subtitleNavigationError = subtitlesError || subtitleTracksError || subtitleCuesError
  const {
    data: playbackSource,
    isLoading: isPlaybackSourceLoading,
    isError: isPlaybackSourceError,
    error: playbackSourceError,
  } = useQuery({
    // A new view or return from native playback must reacquire the backend cache lease.
    queryKey: ['playback-source', libraryId, video.id, playbackInstanceId, playbackSourceEpoch],
    queryFn: async () => {
      const res = await window.api.videos.getPlaybackSource(libraryId, video.id)
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    enabled: useInAppPlayback,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  const conversionQueue = usePlaybackConversionQueue(useInAppPlayback && !playbackSource)
  const conversionJob = [...(conversionQueue.data ?? [])]
    .reverse()
    .find((job) => job.libraryId === libraryId && job.videoId === video.id)
  const previousConversion = React.useRef(null)
  const retriedCompletedConversion = React.useRef(null)
  React.useEffect(() => {
    const previous = previousConversion.current
    previousConversion.current = conversionJob
      ? { id: conversionJob.id, status: conversionJob.status }
      : null
    const resumed =
      conversionJob &&
      previous?.id === conversionJob.id &&
      ['paused', 'failed'].includes(previous.status) &&
      ['queued', 'running', 'completed'].includes(conversionJob.status)
    const completedKey = conversionJob && `${conversionJob.id}:${conversionJob.updatedAt}`
    const completedAfterError =
      conversionJob?.status === 'completed' &&
      isPlaybackSourceError &&
      retriedCompletedConversion.current !== completedKey
    if (useInAppPlayback && (resumed || completedAfterError)) {
      if (conversionJob.status === 'completed') retriedCompletedConversion.current = completedKey
      setPlaybackSourceEpoch((value) => value + 1)
    }
  }, [
    conversionJob?.id,
    conversionJob?.status,
    conversionJob?.updatedAt,
    isPlaybackSourceError,
    useInAppPlayback,
  ])
  const showConversionJob =
    useInAppPlayback && !playbackSource && conversionJob && conversionJob.status !== 'completed'
  const repeatContext = JSON.stringify([
    libraryId,
    video.id,
    video.filePath,
    useInAppPlayback,
    playbackSource,
    playbackSourceEpoch,
  ])
  const [repeatState, setRepeatState] = React.useState({
    context: '',
    start: null,
    end: null,
    enabled: false,
    error: null,
  })
  const repeat =
    repeatState.context === repeatContext
      ? repeatState
      : { start: null, end: null, enabled: false, error: null }
  React.useEffect(() => {
    setRepeatState({ context: repeatContext, start: null, end: null, enabled: false, error: null })
  }, [repeatContext])
  const {
    data: nativePlayerInfo,
    isFetched: nativePlayerFetched,
    error: nativePlayerInfoError,
  } = useQuery({
    queryKey: ['native-player-info'],
    queryFn: async () => {
      const res = await window.api.videos.getNativePlayerInfo()
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    retry: false,
  })
  React.useEffect(() => {
    if (nativePlayerFetched && !nativePlayerInfo && !nativePlaybackRef.current)
      enableInAppPlayback()
  }, [nativePlayerFetched, nativePlayerInfo, enableInAppPlayback])
  const { data: highlights = [] } = useQuery({
    queryKey: ['highlights', libraryId, video.id],
    queryFn: async () => {
      const res = await window.api.highlights.list(libraryId, video.id)
      return res.ok ? res.value : []
    },
  })
  const orderedHighlights = React.useMemo(
    () => [...highlights].sort((a2, b2) => a2.timeStart - b2.timeStart),
    [highlights],
  )
  const createHighlight = useMutation({
    mutationFn: async (timeStart) => {
      const res = await window.api.highlights.create(libraryId, {
        videoId: video.id,
        timeStart,
        color: 'yellow',
      })
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    onSuccess: () =>
      qc2.invalidateQueries({
        queryKey: ['highlights', libraryId, video.id],
      }),
  })
  const deleteHighlight = useMutation({
    onMutate: () => setPlayerActionError(null),
    mutationFn: async (id2) => {
      const res = await window.api.highlights.delete(libraryId, id2)
      if (!res.ok) throw new Error(res.error)
    },
    onSuccess: () =>
      qc2.invalidateQueries({
        queryKey: ['highlights', libraryId, video.id],
      }),
    onError: (error) =>
      setPlayerActionError(
        `하이라이트를 삭제하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
  React.useEffect(() => {
    const media = videoRef.current
    if (!media || !useInAppPlayback || !playbackSource) return
    pendingSeekRecordRef.current = false
    const controller = createSeekController(media, {
      fallbackDuration: video.durationSec,
      onStart: (time) => {
        if (!nativePlaybackRef.current)
          void recordPlayback(window.api.playback.heartbeat(libraryId, video.id, time))
      },
      onTarget: (time) => {
        pendingSeekRecordRef.current = true
        lastPositionRef.current = time
        setCurrentTimeSec(time)
      },
      onSettled: (time) => {
        pendingSeekRecordRef.current = false
        lastPositionRef.current = time
        setCurrentTimeSec(time)
        if (!nativePlaybackRef.current)
          void recordPlayback(window.api.playback.seek(libraryId, video.id, time))
      },
      onError: (error) => {
        setPlayerActionError(`이동하지 못했습니다: ${String(error)}`)
        setRepeatState((state) => ({ ...state, enabled: false }))
      },
    })
    seekControllerRef.current = controller
    return () => {
      controller.dispose()
      if (seekControllerRef.current === controller) seekControllerRef.current = null
      mouseSeekingRef.current = false
      activeSeekKeyRef.current = null
      if (smoothSeekStartTimerRef.current) clearTimeout(smoothSeekStartTimerRef.current)
      if (smoothSeekTimerRef.current) clearInterval(smoothSeekTimerRef.current)
      smoothSeekStartTimerRef.current = smoothSeekTimerRef.current = null
    }
  }, [libraryId, playbackSource, recordPlayback, useInAppPlayback, video.durationSec, video.id])
  const openInNativePlayer = useMutation({
    mutationFn: async () => {
      const view = nativeLaunchViewRef.current
      if (!view.active) throw new Error('외부 플레이어 실행이 취소되었습니다.')
      const hasMetadata =
        initializedResumeForVideoRef.current === video.id || videoRef.current?.readyState >= 1
      const currentTime = hasMetadata
        ? (seekControllerRef.current?.position ??
          videoRef.current?.currentTime ??
          lastPositionRef.current)
        : lastPositionRef.current
      if (pendingSeekRecordRef.current) {
        const result = await window.api.playback.seek(libraryId, video.id, currentTime)
        if (!result.ok) throw new Error(result.error)
      }
      // Emergency exit unmounts this view; an earlier seek write must not launch a new window later.
      if (!view.active) throw new Error('외부 플레이어 실행이 취소되었습니다.')
      const bounds = containerRef.current?.getBoundingClientRect()
      const outerLeft = typeof window.screenX === 'number' ? window.screenX : 0
      const outerTop = typeof window.screenY === 'number' ? window.screenY : 0
      const res = await window.api.videos.openInNativePlayer(libraryId, video.id, {
        startTimeSec: currentTime,
        ...(nativePlayerInfo?.name === 'mpv'
          ? { playbackRate: PlaybackRateZ.safeParse(playbackRate).success ? playbackRate : 1 }
          : {}),
        width: bounds ? Math.floor(bounds.width) : window.innerWidth,
        height: bounds ? Math.floor(bounds.height) : window.innerHeight,
        x: bounds ? Math.floor(outerLeft + bounds.left) : outerLeft,
        y: bounds ? Math.floor(outerTop + bounds.top) : outerTop,
      })
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    onSuccess: (player) => {
      setActiveNativePlayer(player.name)
      nativePlaybackRef.current = true
      setMediaPlaybackError(null)
      pendingSeekRecordRef.current = false
      seekControllerRef.current?.cancel()
      initializedResumeForVideoRef.current = null
      stopInAppPlayback(videoRef.current)
      setUseInAppPlayback(false)
      setStatusMessage(`${formatPlayerName(player)}로 전환했습니다`)
    },
    onError: (error) => {
      nativePlaybackRef.current = false
      enableInAppPlayback()
      setNativeLaunchError(error instanceof Error ? error.message : String(error))
    },
    onSettled: () => {
      nativeLaunchPendingRef.current = false
      onNativeLaunchPendingChange?.(false)
    },
  })
  React.useEffect(() => {
    const element = videoRef.current
    if (!element || !useInAppPlayback || !playbackSource) return
    const rate = PlaybackRateZ.safeParse(playbackRate).success ? playbackRate : 1
    element.preservesPitch = true
    element.playbackRate = rate
  }, [playbackRate, playbackSource, useInAppPlayback])
  React.useEffect(
    () =>
      window.api.on.nativePlayerSpeed?.((event) => {
        if (event.videoId === video.id && nativePlaybackRef.current && Number.isFinite(event.rate))
          setPlaybackRate(event.rate)
      }),
    [video.id],
  )
  async function changePlaybackRate(rate) {
    if (!PlaybackRateZ.safeParse(rate).success || speedPending) return
    setPlayerActionError(null)
    if (useInAppPlayback) {
      if (videoRef.current) {
        videoRef.current.preservesPitch = true
        videoRef.current.playbackRate = rate
      }
      setPlaybackRate(rate)
      return
    }
    if (activeNativePlayer !== 'mpv') return
    setSpeedPending(true)
    try {
      const result = await window.api.videos.setActivePlaybackRate(libraryId, video.id, rate)
      if (!result.ok) throw new Error(result.error)
      setPlaybackRate(result.value)
    } catch (error) {
      setPlayerActionError(
        '배속을 적용하지 못했습니다: ' + (error instanceof Error ? error.message : String(error)),
      )
    } finally {
      setSpeedPending(false)
    }
  }
  const requestNativePlayback = React.useCallback(() => {
    if (nativeLaunchPendingRef.current) return
    stopSmoothSeek()
    setRepeatState((state) => ({ ...state, start: null, end: null, enabled: false, error: null }))
    nativeLaunchPendingRef.current = true
    setNativeLaunchError(null)
    onNativeLaunchPendingChange?.(true)
    openInNativePlayer.mutate()
  }, [onNativeLaunchPendingChange, openInNativePlayer, stopSmoothSeek])
  React.useEffect(() => {
    setMediaPlaybackError(null)
  }, [playbackSource, useInAppPlayback])
  React.useEffect(() => {
    if (!useInAppPlayback) return
    nativePlaybackRef.current = false
    void recordPlayback(window.api.playback.start(libraryId, video.id))
    heartbeatRef.current = setInterval(() => {
      if (nativePlaybackRef.current || seekControllerRef.current?.isActive) return
      const pos =
        initializedResumeForVideoRef.current === video.id
          ? (videoRef.current?.currentTime ?? lastPositionRef.current)
          : lastPositionRef.current
      lastPositionRef.current = pos
      void recordPlayback(window.api.playback.heartbeat(libraryId, video.id, pos))
    }, 5e3)
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
      if (smoothSeekStartTimerRef.current) clearTimeout(smoothSeekStartTimerRef.current)
      if (smoothSeekTimerRef.current) clearInterval(smoothSeekTimerRef.current)
      const pos = lastPositionRef.current
      if (!nativePlaybackRef.current) {
        if (pendingSeekRecordRef.current)
          void recordPlayback(window.api.playback.seek(libraryId, video.id, pos))
        void recordPlayback(window.api.playback.end(libraryId, video.id, pos))
      }
    }
  }, [libraryId, video.id, useInAppPlayback, recordPlayback])
  React.useEffect(() => {
    setCurrentTimeSec(0)
    setDurationSec(video.durationSec ?? 0)
    setIsPaused(true)
    setIsSeekingWithMouse(false)
    setIsSubtitleEnabled(true)
  }, [video.durationSec, video.id])
  React.useEffect(() => {
    setDecodedSize({
      width: videoRef.current?.videoWidth ?? 0,
      height: videoRef.current?.videoHeight ?? 0,
    })
  }, [video.id, playbackSource])
  React.useEffect(() => {
    if (!useInAppPlayback) return
    if (initializedResumeForVideoRef.current === video.id) return
    const videoElement = videoRef.current
    if (!videoElement || !playbackSource) return
    videoElement.volume = playerVolume
    const restorePosition = () => {
      if (initializedResumeForVideoRef.current === video.id) return
      if (seekControllerRef.current?.isActive) {
        initializedResumeForVideoRef.current = video.id
        return
      }
      const position = clampTime(
        lastPositionRef.current,
        getVideoDuration(videoElement, video.durationSec ?? 0),
      )
      videoElement.currentTime = position
      lastPositionRef.current = position
      setCurrentTimeSec(position)
      initializedResumeForVideoRef.current = video.id
    }
    if (videoElement.readyState >= 1) restorePosition()
    videoElement.addEventListener('loadedmetadata', restorePosition)
    return () => videoElement.removeEventListener('loadedmetadata', restorePosition)
  }, [
    playbackSource,
    playerVolume,
    video.id,
    video.resumePosSec,
    video.durationSec,
    useInAppPlayback,
  ])
  React.useEffect(() => {
    const videoElement = videoRef.current
    if (!videoElement) return
    videoElement.volume = playerVolume
    if (playerVolume > 0 && videoElement.muted) {
      videoElement.muted = false
    }
  }, [playerVolume, playbackSource, useInAppPlayback, video.id])
  React.useEffect(() => {
    const videoElement = videoRef.current
    if (!videoElement) return
    const syncVolume = () => {
      const normalized = videoElement.muted ? 0 : videoElement.volume
      setPlayerVolume(normalized)
    }
    videoElement.addEventListener('volumechange', syncVolume)
    return () => videoElement.removeEventListener('volumechange', syncVolume)
  }, [playbackSource, setPlayerVolume, useInAppPlayback, video.id])
  React.useEffect(() => {
    const videoElement = videoRef.current
    if (!videoElement || !useInAppPlayback || !isSubtitleEnabled || subtitleCues.length === 0) {
      setActiveSubtitleText(null)
      return
    }
    const updateActiveSubtitle = () => {
      const currentTime = videoElement.currentTime
      const activeCue = subtitleCues.find(
        (cue) => currentTime >= cue.startSec && currentTime <= cue.endSec,
      )
      setActiveSubtitleText(activeCue?.text ?? null)
    }
    updateActiveSubtitle()
    videoElement.addEventListener('timeupdate', updateActiveSubtitle)
    videoElement.addEventListener('seeked', updateActiveSubtitle)
    videoElement.addEventListener('loadeddata', updateActiveSubtitle)
    videoElement.addEventListener('pause', updateActiveSubtitle)
    videoElement.addEventListener('play', updateActiveSubtitle)
    return () => {
      videoElement.removeEventListener('timeupdate', updateActiveSubtitle)
      videoElement.removeEventListener('seeked', updateActiveSubtitle)
      videoElement.removeEventListener('loadeddata', updateActiveSubtitle)
      videoElement.removeEventListener('pause', updateActiveSubtitle)
      videoElement.removeEventListener('play', updateActiveSubtitle)
    }
  }, [isSubtitleEnabled, subtitleCues, useInAppPlayback, video.id])
  React.useEffect(() => {
    const videoElement = videoRef.current
    if (!videoElement || !useInAppPlayback) return
    const disableNativeTextTracks = () => {
      const textTracks = videoElement.textTracks
      if (!textTracks) return
      for (let index = 0; index < textTracks.length; index++) {
        textTracks[index].mode = 'disabled'
      }
    }
    disableNativeTextTracks()
    videoElement.addEventListener('loadedmetadata', disableNativeTextTracks)
    videoElement.addEventListener('loadeddata', disableNativeTextTracks)
    return () => {
      videoElement.removeEventListener('loadedmetadata', disableNativeTextTracks)
      videoElement.removeEventListener('loadeddata', disableNativeTextTracks)
    }
  }, [playbackSource, useInAppPlayback, video.id])
  React.useEffect(() => {
    if (!statusMessage) return
    const timer = setTimeout(() => setStatusMessage(null), 2200)
    return () => clearTimeout(timer)
  }, [statusMessage])
  const jumpToTime = React.useCallback(
    async (timeSec) => {
      setPlayerActionError(null)
      try {
        if (useInAppPlayback && videoRef.current) {
          if (!seekControllerRef.current) {
            throw new Error('영상을 준비하고 있습니다. 재생 준비가 끝난 뒤 다시 시도해 주세요.')
          }
          stopSmoothSeek(false)
          seekControllerRef.current.request(timeSec)
          await videoRef.current.play().catch(() => void 0)
          setStatusMessage(`${formatTime(timeSec)} 위치로 이동했습니다`)
          return true
        }
        const res = await window.api.videos.seekActivePlayback(libraryId, video.id, timeSec)
        if (!res.ok) throw new Error(res.error)
        if (!res.value) throw new Error('해당 위치로 이동하지 못했습니다')
        setCurrentTimeSec(timeSec)
        setStatusMessage(`${formatTime(timeSec)} 위치로 이동했습니다`)
        return true
      } catch (error) {
        setPlayerActionError(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [libraryId, stopSmoothSeek, useInAppPlayback, video.id],
  )
  const getCurrentTime = React.useCallback(() => {
    const currentTime = seekControllerRef.current?.position ?? videoRef.current?.currentTime
    if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0) {
      return currentTime
    }
    const resumePosSec = video.resumePosSec
    if (typeof resumePosSec === 'number' && Number.isFinite(resumePosSec) && resumePosSec >= 0) {
      return resumePosSec
    }
    return 0
  }, [video.resumePosSec])
  const clearRepeat = () => {
    setRepeatState({ context: repeatContext, start: null, end: null, enabled: false, error: null })
  }
  const markRepeatPoint = (point) => {
    const position = clampTime(getCurrentTime(), durationSec)
    const next = { ...repeat, [point]: position }
    setRepeatState({
      ...next,
      context: repeatContext,
      enabled: false,
      error:
        next.start !== null && next.end !== null
          ? repeatRangeError(next.start, next.end, durationSec)
          : null,
    })
  }
  const toggleRepeat = () => {
    const error = repeat.enabled ? null : repeatRangeError(repeat.start, repeat.end, durationSec)
    setRepeatState({
      ...repeat,
      context: repeatContext,
      error,
      enabled: !repeat.enabled && !error,
    })
  }
  React.useEffect(() => {
    const media = videoRef.current
    if (!repeat.enabled || !useInAppPlayback || !playbackSource || !media) return
    const error = repeatRangeError(repeat.start, repeat.end, durationSec)
    if (error) {
      setRepeatState((state) => ({ ...state, enabled: false, error }))
      return
    }
    const controller = createAbRepeatController(media, {
      range: { start: repeat.start, end: repeat.end },
      isSeekPending: () => Boolean(seekControllerRef.current?.isActive || mouseSeekingRef.current),
      seek: (time) => {
        if (!seekControllerRef.current) throw new Error('영상이 아직 준비되지 않았습니다.')
        seekControllerRef.current.request(time)
      },
      onError: (error) =>
        setRepeatState((state) => ({
          ...state,
          enabled: false,
          error: `구간 반복을 적용하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        })),
    })
    return () => controller.dispose()
  }, [
    durationSec,
    playbackSource,
    repeat.enabled,
    repeat.start,
    repeat.end,
    useInAppPlayback,
    repeatContext,
  ])
  const jumpToAdjacentHighlight = React.useCallback(
    async (direction, currentTime) => {
      const baseTime = currentTime ?? getCurrentTime()
      const candidate =
        direction === 'previous'
          ? findPreviousHighlight(orderedHighlights, baseTime)
          : orderedHighlights.find((highlight) => highlight.timeStart > baseTime + 0.05)
      if (!candidate) {
        setStatusMessage(
          direction === 'previous' ? '이전 하이라이트가 없습니다' : '다음 하이라이트가 없습니다',
        )
        return
      }
      await jumpToTime(candidate.timeStart)
    },
    [getCurrentTime, jumpToTime, orderedHighlights],
  )
  const jumpToAdjacentSubtitle = React.useCallback(
    async (direction, currentTime) => {
      const baseTime = currentTime ?? getCurrentTime()
      const candidate =
        direction === 'previous'
          ? findPreviousSubtitleCue(subtitleCues, baseTime)
          : subtitleCues.find((cue) => cue.startSec > baseTime + 0.05)
      if (!candidate) {
        setStatusMessage(direction === 'previous' ? '이전 자막이 없습니다' : '다음 자막이 없습니다')
        return
      }
      await jumpToTime(candidate.startSec)
    },
    [getCurrentTime, jumpToTime, subtitleCues],
  )
  const captureThumbnailWithFallback = React.useCallback(
    async (timeSec, makePrimary) => {
      const captureResult = await window.api.thumbnails.captureAtTime(
        libraryId,
        video.id,
        timeSec,
        makePrimary,
      )
      if (captureResult.ok) {
        return captureResult.value
      }
      const videoElement = videoRef.current
      if (!videoElement || videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        throw new Error(captureResult.error)
      }
      const canvas = document.createElement('canvas')
      canvas.width = videoElement.videoWidth
      canvas.height = videoElement.videoHeight
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error(captureResult.error)
      }
      context.drawImage(videoElement, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
      const fallbackResult = await window.api.thumbnails.saveImageCapture(
        libraryId,
        video.id,
        timeSec,
        dataUrl,
        makePrimary,
      )
      if (!fallbackResult.ok) {
        throw new Error(fallbackResult.error)
      }
      return fallbackResult.value
    },
    [libraryId, video.id],
  )
  const saveCurrentHighlight = React.useCallback(
    async (currentTime) => {
      const baseTime = currentTime ?? getCurrentTime()
      const duplicate = findDuplicateHighlight(orderedHighlights, baseTime)
      if (duplicate) {
        const thumbnail2 = await captureThumbnailWithFallback(baseTime, false)
        if (Math.abs(thumbnail2.timeSec - duplicate.timeStart) > 0.05) {
          const updateRes = await window.api.highlights.update(libraryId, duplicate.id, {
            timeStart: thumbnail2.timeSec,
          })
          if (!updateRes.ok) {
            throw new Error(updateRes.error)
          }
        }
        qc2.invalidateQueries({
          queryKey: ['highlights', libraryId, video.id],
        })
        qc2.invalidateQueries({
          queryKey: ['thumbnails', libraryId, video.id],
        })
        setStatusMessage('현재 하이라이트 위치를 저장했습니다')
        return
      }
      const createdHighlight = await createHighlight.mutateAsync(baseTime)
      const thumbnail = await captureThumbnailWithFallback(baseTime, false)
      if (Math.abs(thumbnail.timeSec - createdHighlight.timeStart) > 0.05) {
        const updateRes = await window.api.highlights.update(libraryId, createdHighlight.id, {
          timeStart: thumbnail.timeSec,
        })
        if (!updateRes.ok) {
          throw new Error(updateRes.error)
        }
      }
      qc2.invalidateQueries({
        queryKey: ['highlights', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['thumbnails', libraryId, video.id],
      })
      setStatusMessage('새 하이라이트를 저장했습니다')
    },
    [
      captureThumbnailWithFallback,
      createHighlight,
      getCurrentTime,
      libraryId,
      orderedHighlights,
      qc2,
      video.id,
    ],
  )
  const setCurrentThumbnail = React.useCallback(
    async (currentTime) => {
      const baseTime = currentTime ?? getCurrentTime()
      const thumbnail = await captureThumbnailWithFallback(baseTime, true)
      qc2.invalidateQueries({
        queryKey: ['thumbnails', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['video', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['videos', libraryId],
      })
      setStatusMessage(`썸네일을 ${formatTime(thumbnail.timeSec)} 위치로 저장했습니다`)
    },
    [captureThumbnailWithFallback, getCurrentTime, libraryId, qc2, video.id],
  )
  const addHighlightAtCurrentTime = React.useCallback(
    async (currentTime) => {
      const baseTime = currentTime ?? getCurrentTime()
      await createHighlight.mutateAsync(baseTime)
      setStatusMessage('하이라이트를 추가했습니다')
    },
    [createHighlight, getCurrentTime],
  )
  const handlePlayerAction = React.useCallback(
    async (action, currentTime) => {
      setPlayerActionError(null)
      try {
        if (action === 'previousHighlight') {
          await jumpToAdjacentHighlight('previous', currentTime)
          return
        }
        if (action === 'nextHighlight') {
          await jumpToAdjacentHighlight('next', currentTime)
          return
        }
        if (action === 'saveHighlight') {
          await saveCurrentHighlight(currentTime)
          return
        }
        if (action === 'setThumbnail') {
          await setCurrentThumbnail(currentTime)
          return
        }
        if (action === 'addHighlight') {
          await addHighlightAtCurrentTime(currentTime)
          return
        }
        if (action === 'openNativePlayer') {
          requestNativePlayback()
        }
      } catch (error) {
        setPlayerActionError(error instanceof Error ? error.message : String(error))
      }
    },
    [
      addHighlightAtCurrentTime,
      jumpToAdjacentHighlight,
      requestNativePlayback,
      saveCurrentHighlight,
      setCurrentThumbnail,
    ],
  )
  const handleKeyDown = React.useCallback(
    (event) => {
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      const isShiftKey =
        event.code === 'ShiftLeft' || event.code === 'ShiftRight' || event.key === 'Shift'
      const isCtrlKey =
        event.code === 'ControlLeft' || event.code === 'ControlRight' || event.key === 'Control'
      const target = event.target
      if (
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector('[aria-modal="true"]') ||
        isTextEditingTarget(target) ||
        subtitleNavigationTarget?.contains(target)
      ) {
        return
      }
      if (handleViewKey(event)) return
      if (event.altKey || event.metaKey) return
      if (
        target instanceof Element &&
        target.closest('button, a, [role="button"]') &&
        [' ', 'Enter'].includes(event.key)
      )
        return
      if (isShiftKey) {
        modifierStateRef.current.shift = true
        return
      }
      if (isCtrlKey) {
        modifierStateRef.current.ctrl = true
        return
      }
      const key = event.key.toLowerCase()
      const videoElement = videoRef.current
      if (event.ctrlKey && !['arrowleft', 'arrowright', 'a', 'd'].includes(key)) return
      if (/^[0-9]$/.test(key) && !event.shiftKey && !event.ctrlKey && useInAppPlayback) {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat || nativeLaunchPendingRef.current) return
        const duration = videoElement ? getVideoDuration(videoElement, durationSec) : durationSec
        if (!Number.isFinite(duration) || duration <= 0) {
          setPlayerActionError('영상 길이를 확인한 뒤 구간 이동을 사용할 수 있습니다.')
          return
        }
        if (!seekControllerRef.current) {
          setPlayerActionError('영상을 준비하고 있습니다. 재생 준비가 끝난 뒤 다시 시도해 주세요.')
          return
        }
        stopSmoothSeek(false)
        setPlayerActionError(null)
        const position = (duration * Number(key)) / 10
        seekControllerRef.current.request(position)
        setStatusMessage(`${Number(key) * 10}% · ${formatTime(position)} 위치로 이동했습니다`)
        return
      }
      if (
        event.repeat &&
        ['a', 'd', 'arrowleft', 'arrowright'].includes(key) &&
        activeSeekKeyRef.current !== key
      ) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (nativeLaunchPendingRef.current && ['a', 'd', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (useInAppPlayback && videoElement) {
        const seekBy = (deltaSec) => {
          const nextTime = clampTime(
            (seekControllerRef.current?.position ?? videoElement.currentTime) + deltaSec,
            getVideoDuration(videoElement, durationSec),
          )
          seekControllerRef.current?.request(nextTime)
          setStatusMessage(`${formatTime(nextTime)} 위치로 이동했습니다`)
        }
        const startSmoothSeek = (deltaSec) => {
          if (
            activeSeekKeyRef.current === key &&
            (smoothSeekTimerRef.current || smoothSeekStartTimerRef.current)
          ) {
            return
          }
          stopSmoothSeek(false)
          activeSeekKeyRef.current = key
          smoothSeekStartedAtRef.current = Date.now()
          smoothSeekStartTimerRef.current = setTimeout(() => {
            smoothSeekTimerRef.current = setInterval(() => {
              const elapsedMs = Date.now() - smoothSeekStartedAtRef.current
              const step = Math.sign(deltaSec) * getAcceleratedSeekStep(deltaSec, elapsedMs)
              const nextTime = clampTime(
                (seekControllerRef.current?.position ?? videoElement.currentTime) + step,
                getVideoDuration(videoElement, durationSec),
              )
              seekControllerRef.current?.request(nextTime, true)
            }, 60)
          }, 180)
        }
        const changeVolumeBy = (delta) => {
          const nextVolume = Math.max(0, Math.min(1, videoElement.volume + delta))
          videoElement.volume = nextVolume
          if (nextVolume > 0 && videoElement.muted) {
            videoElement.muted = false
          }
          setPlayerVolume(nextVolume)
          setStatusMessage(`볼륨 ${Math.round(nextVolume * 100)}%`)
        }
        const togglePause = async () => {
          if (videoElement.paused) {
            await videoElement.play().catch(() => void 0)
            setStatusMessage('재생을 계속합니다')
            return
          }
          videoElement.pause()
          setStatusMessage('일시정지했습니다')
        }
        if (key === ' ' || key === 'spacebar' || key === 'p') {
          event.preventDefault()
          event.stopPropagation()
          void togglePause()
          return
        }
        if (event.key === 'ArrowRight' || key === 'd') {
          event.preventDefault()
          event.stopPropagation()
          const isShift = event.getModifierState('Shift') || modifierStateRef.current.shift
          const isCtrl = event.getModifierState('Control') || modifierStateRef.current.ctrl
          const deltaSec = isShift ? 5 : isCtrl ? 30 : seekStepSec
          startSmoothSeek(deltaSec)
          if (!event.repeat) {
            seekBy(deltaSec)
          }
          return
        }
        if (event.key === 'ArrowLeft' || key === 'a') {
          event.preventDefault()
          event.stopPropagation()
          const isShift = event.getModifierState('Shift') || modifierStateRef.current.shift
          const isCtrl = event.getModifierState('Control') || modifierStateRef.current.ctrl
          const deltaSec = isShift ? -5 : isCtrl ? -30 : -seekStepSec
          startSmoothSeek(deltaSec)
          if (!event.repeat) {
            seekBy(deltaSec)
          }
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          changeVolumeBy(0.05)
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          event.stopPropagation()
          changeVolumeBy(-0.05)
          return
        }
      }
      if (key === 'q') {
        event.preventDefault()
        event.stopPropagation()
        void handlePlayerAction('previousHighlight')
        return
      }
      if (key === 'e') {
        event.preventDefault()
        event.stopPropagation()
        void handlePlayerAction('nextHighlight')
        return
      }
      if (key === 's') {
        event.preventDefault()
        event.stopPropagation()
        void handlePlayerAction('saveHighlight')
        return
      }
      if (key === 'f' || key === 't') {
        event.preventDefault()
        event.stopPropagation()
        void handlePlayerAction('setThumbnail')
        return
      }
      if (key === 'h') {
        event.preventDefault()
        event.stopPropagation()
        void handlePlayerAction('addHighlight')
        return
      }
      if (key === 'o') {
        event.preventDefault()
        event.stopPropagation()
        void handlePlayerAction('openNativePlayer')
        return
      }
      if (key === 'z') {
        event.preventDefault()
        event.stopPropagation()
        void jumpToAdjacentSubtitle('previous')
        return
      }
      if (key === 'c') {
        event.preventDefault()
        event.stopPropagation()
        void jumpToAdjacentSubtitle('next')
      }
    },
    [
      durationSec,
      seekStepSec,
      handleViewKey,
      handlePlayerAction,
      jumpToAdjacentSubtitle,
      setPlayerVolume,
      stopSmoothSeek,
      subtitleNavigationTarget,
      useInAppPlayback,
    ],
  )
  const handleKeyUp = React.useCallback(
    (event) => {
      const isShiftKey =
        event.code === 'ShiftLeft' || event.code === 'ShiftRight' || event.key === 'Shift'
      const isCtrlKey =
        event.code === 'ControlLeft' || event.code === 'ControlRight' || event.key === 'Control'
      if (isShiftKey) {
        modifierStateRef.current.shift = false
      }
      if (isCtrlKey) {
        modifierStateRef.current.ctrl = false
      }
      if (
        event.key.toLowerCase() === activeSeekKeyRef.current ||
        event.key === 'Shift' ||
        event.key === 'Control'
      ) {
        stopSmoothSeek()
      }
    },
    [stopSmoothSeek],
  )
  React.useEffect(() => {
    const finishOnBlur = () => {
      mouseSeekingRef.current = false
      setIsSeekingWithMouse(false)
      stopSmoothSeek()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', finishOnBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', finishOnBlur)
    }
  }, [handleKeyDown, handleKeyUp, stopSmoothSeek])
  React.useEffect(() => {
    return window.api.on.highlightChanged(({ videoId }) => {
      if (videoId !== video.id) return
      qc2.invalidateQueries({
        queryKey: ['highlights', libraryId, video.id],
      })
    })
  }, [libraryId, qc2, video.id])
  React.useEffect(() => {
    return window.api.on.thumbnailReady(({ videoId }) => {
      if (videoId !== video.id) return
      qc2.invalidateQueries({
        queryKey: ['thumbnails', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['video', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['videos', libraryId],
      })
    })
  }, [libraryId, qc2, video.id])
  React.useEffect(() => {
    const subscribe = window.api.on.nativePlayerAction
    if (typeof subscribe !== 'function') {
      return
    }
    return subscribe(({ videoId, action, timeSec }) => {
      if (videoId !== video.id) return
      void handlePlayerAction(action, timeSec)
    })
  }, [handlePlayerAction, video.id])
  React.useEffect(() => {
    if (!seekRequest) return
    void jumpToTime(seekRequest.timeSec)
  }, [jumpToTime, seekRequest])
  const seekBarMax = durationSec > 0 ? durationSec : 0
  const seekBarProgress = seekBarMax > 0 ? (currentTimeSec / seekBarMax) * 100 : 0
  const focusPlayerContainer = React.useCallback(() => {
    containerRef.current?.focus()
  }, [])
  const handleVideoTimeUpdate = React.useCallback(() => {
    if (nativePlaybackRef.current || isSeekingWithMouse || seekControllerRef.current?.isActive)
      return
    const videoElement = videoRef.current
    if (!videoElement) return
    lastPositionRef.current = videoElement.currentTime
    setCurrentTimeSec(videoElement.currentTime)
  }, [isSeekingWithMouse])
  const handleVideoMetadata = React.useCallback(() => {
    const videoElement = videoRef.current
    if (!videoElement) return
    const nextDuration = getVideoDuration(videoElement, video.durationSec ?? 0)
    setDurationSec(nextDuration)
    if (!seekControllerRef.current?.isActive) setCurrentTimeSec(videoElement.currentTime)
    setIsPaused(videoElement.paused)
  }, [video.durationSec])
  const handleSeekChange = React.useCallback((event) => {
    const nextTime = Number(event.target.value)
    if (!Number.isFinite(nextTime)) return
    seekControllerRef.current?.request(nextTime, mouseSeekingRef.current)
  }, [])
  const finishMouseSeek = React.useCallback(() => {
    mouseSeekingRef.current = false
    seekControllerRef.current?.finish()
    setIsSeekingWithMouse(false)
    focusPlayerContainer()
  }, [focusPlayerContainer])
  const togglePlayback = React.useCallback(async () => {
    const videoElement = videoRef.current
    if (!videoElement) return
    if (videoElement.paused) {
      await videoElement.play().catch(() => void 0)
      return
    }
    videoElement.pause()
  }, [])
  const toggleSubtitles = React.useCallback(() => {
    setIsSubtitleEnabled((enabled) => {
      const nextEnabled = !enabled
      setStatusMessage(nextEnabled ? '자막을 켰습니다' : '자막을 껐습니다')
      return nextEnabled
    })
  }, [])
  const handleMediaError = React.useCallback(() => {
    if (!useInAppPlayback || nativePlaybackRef.current || !playbackSource) return
    const error = videoRef.current?.error
    if (!error || error.code === 1) return
    setRepeatState((state) => ({ ...state, enabled: false }))
    setMediaPlaybackError(
      error.code === 3 || error.code === 4
        ? '이 영상의 코덱을 인앱 플레이어에서 재생할 수 없습니다.'
        : '영상 파일을 읽지 못했습니다. 파일 위치와 접근 권한을 확인해 주세요.',
    )
  }, [playbackSource, useInAppPlayback])
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-fullscreen-view={view.fullscreenMode}
      className={
        'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-black outline-hidden'
      }
    >
      {view.isFullscreen && <FullscreenViewToggle view={view} containerRef={containerRef} />}
      {!view.isFullscreen && (
        <>
          <PlayerViewControls
            view={view}
            enabled={viewEnabled}
            isMaximized={isMaximized}
            onToggleMaximized={onToggleMaximized}
            seekStepSec={seekStepSec}
            settingsError={settingsError}
          />
          <PlaybackRateControl
            rate={playbackRate}
            onChange={changePlaybackRate}
            pending={speedPending || openInNativePlayer.isPending}
            disabled={!useInAppPlayback && activeNativePlayer !== 'mpv'}
            hint={
              useInAppPlayback
                ? '인앱 0.25–4× · 음성·자막 함께 적용'
                : !activeNativePlayer
                  ? '외부 플레이어를 연 뒤 배속을 조절하세요. 인앱·mpv는 앱에서 0.25–4×를 지원합니다.'
                  : activeNativePlayer === 'mpv'
                    ? 'mpv 앱 조절 0.25–4× · mpv에서 변경한 값도 표시'
                    : activeNativePlayer === 'vlc'
                      ? 'VLC의 재생 → 속도 메뉴에서 조절하세요. 앱에서는 변경·조회할 수 없습니다.'
                      : 'FFplay 배속 변경은 앱에서 지원하지 않습니다. 인앱 또는 mpv를 사용하세요.'
            }
          />
          <AbRepeatControl
            start={repeat.start}
            end={repeat.end}
            enabled={repeat.enabled}
            available={Boolean(
              useInAppPlayback &&
              playbackSource &&
              videoRef.current?.readyState >= 1 &&
              !openInNativePlayer.isPending &&
              !mediaPlaybackError,
            )}
            external={!useInAppPlayback}
            error={repeat.error}
            onMark={markRepeatPoint}
            onToggle={toggleRepeat}
            onClear={clearRepeat}
          />
        </>
      )}
      {subtitleNavigationTarget &&
        createPortal(
          <SubtitleNavigator
            cues={subtitleCues}
            tracks={orderedSubtitles}
            selectedTrackId={selectedSubtitleId}
            onSelectTrack={selectSubtitleTrack}
            currentTimeSec={useInAppPlayback ? currentTimeSec : null}
            isLoading={areSubtitlesLoading || areSubtitleTracksLoading || areSubtitleCuesLoading}
            error={subtitleNavigationError ? subtitleNavigationError.message : null}
            onSeek={jumpToTime}
            getTrackLabel={(track) => subtitleTrackLabel(track, video.filePath)}
          />,
          subtitleNavigationTarget,
        )}
      {/* Keep intrinsic media dimensions from expanding either flex axis. */}
      <div
        className={'relative min-h-0 min-w-0 flex-1 overflow-hidden'}
        style={view.isFullscreen ? { flex: '1 1 0%', height: 'auto' } : undefined}
      >
        <video
          ref={videoRef}
          className={'absolute inset-0 h-full w-full object-contain'}
          style={view.videoStyle}
          {...view.pointer}
          src={useInAppPlayback && playbackSource ? toLocalMediaUrl(playbackSource) : void 0}
          autoPlay={true}
          onClick={() => {
            if (!view.consumeDrag()) void togglePlayback()
          }}
          onError={handleMediaError}
          onEmptied={() => setDecodedSize({ width: 0, height: 0 })}
          onLoadedMetadata={(event) => {
            setDecodedSize({
              width: event.currentTarget.videoWidth,
              height: event.currentTarget.videoHeight,
            })
            event.currentTarget.playbackRate = PlaybackRateZ.safeParse(playbackRate).success
              ? playbackRate
              : 1
            handleVideoMetadata()
          }}
          onResize={(event) =>
            setDecodedSize({
              width: event.currentTarget.videoWidth,
              height: event.currentTarget.videoHeight,
            })
          }
          onDurationChange={handleVideoMetadata}
          onTimeUpdate={handleVideoTimeUpdate}
          onPlay={() => setIsPaused(false)}
          onPause={() => {
            setIsPaused(true)
            if (seekControllerRef.current?.isActive) return
            const pos =
              initializedResumeForVideoRef.current === video.id
                ? (videoRef.current?.currentTime ?? lastPositionRef.current)
                : lastPositionRef.current
            lastPositionRef.current = pos
            if (!nativePlaybackRef.current)
              void recordPlayback(window.api.playback.heartbeat(libraryId, video.id, pos))
          }}
          onSeeked={() => {
            if (nativePlaybackRef.current || seekControllerRef.current?.isActive) return
            const pos = videoRef.current?.currentTime ?? lastPositionRef.current
            lastPositionRef.current = pos
            setCurrentTimeSec(pos)
          }}
          key={video.id}
        />
        {!view.isFullscreen && view.showInfo && (
          <PlaybackInfo
            video={video}
            decodedSize={decodedSize}
            inApp={useInAppPlayback}
            onClose={() => view.setShowInfo(false)}
          />
        )}
        {isSubtitleEnabled && activeSubtitleText && (
          <div
            className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center px-8 ${view.isFullscreen ? (view.fullscreenMode === 'highlights' ? 'bottom-12' : 'bottom-6') : orderedSubtitles.length > 1 ? 'bottom-32' : 'bottom-24'}`}
          >
            <div
              className={
                'max-w-4xl rounded-lg bg-black/70 px-4 py-2 text-center text-lg font-medium leading-relaxed text-white shadow-[0_0_12px_rgba(0,0,0,0.6)]'
              }
            >
              {activeSubtitleText.split('\n').map((line, index) => (
                <div key={`${index}-${line}`}>{line}</div>
              ))}
            </div>
          </div>
        )}
        {!view.isFullscreen && (
          <button
            disabled={openInNativePlayer.isPending}
            onClick={() => navigate(-1)}
            className={
              'absolute right-3 top-3 z-20 rounded bg-black/60 px-3 py-1.5 text-xs text-white hover:bg-black/80'
            }
          >
            {'닫기'}
          </button>
        )}
        {!view.isFullscreen && nativePlayerInfo && (
          <button
            onClick={requestNativePlayback}
            disabled={openInNativePlayer.isPending}
            className={
              'absolute right-20 top-3 z-20 rounded bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500'
            }
          >
            {openInNativePlayer.isPending
              ? '외부 플레이어 여는 중...'
              : `${formatPlayerName(nativePlayerInfo)}로 열기`}
          </button>
        )}
        {!view.isFullscreen && statusMessage && (
          <div
            className={
              'absolute bottom-16 left-3 rounded bg-black/70 px-3 py-1.5 text-xs text-white'
            }
          >
            {statusMessage}
          </div>
        )}
        {(playerActionError || playbackRecordError) && (
          <p
            role="alert"
            className="absolute inset-x-3 bottom-24 z-30 break-words rounded border border-red-800 bg-red-950/95 p-3 text-sm text-red-200"
          >
            {playerActionError || playbackRecordError}
          </p>
        )}
        {useInAppPlayback && mediaPlaybackError && !nativeLaunchError && !nativePlayerInfoError && (
          <div
            role="alert"
            className="absolute inset-x-3 bottom-36 z-30 rounded border border-red-800 bg-red-950/95 p-3 text-sm text-red-200"
          >
            <p>{mediaPlaybackError}</p>
            {nativePlayerInfo ? (
              <button
                onClick={requestNativePlayback}
                disabled={openInNativePlayer.isPending}
                className="mt-2 rounded bg-emerald-600 px-3 py-2 text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                외부 플레이어로 다시 재생
              </button>
            ) : (
              <p className="mt-1 text-xs">라이브러리의 설정에서 외부 플레이어를 선택해 주세요.</p>
            )}
          </div>
        )}
        {openInNativePlayer.isPending && (
          <p
            role="status"
            className="absolute inset-x-3 top-16 z-30 rounded bg-zinc-900/95 p-3 text-center text-sm text-zinc-200"
          >
            외부 플레이어 실행 결과를 기다리고 있습니다...
          </p>
        )}
        {(nativeLaunchError || nativePlayerInfoError) && (
          <div
            role="alert"
            className="absolute inset-x-3 top-16 z-30 rounded border border-red-800 bg-red-950/95 p-3 text-sm text-red-200"
          >
            <p>
              외부 플레이어를 열 수 없습니다: {nativeLaunchError || nativePlayerInfoError.message}
            </p>
            <p className="mt-1 text-xs">
              {mediaPlaybackError || '인앱 플레이어를 사용할 수 있습니다.'} 라이브러리의 설정에서
              실행 파일을 확인하세요.
            </p>
          </div>
        )}
        {useInAppPlayback && !view.isFullscreen && (
          <div
            className={
              'absolute inset-x-0 bottom-0 z-20 border-t border-white/10 bg-black/75 px-4 py-3 text-white'
            }
            onMouseDown={focusPlayerContainer}
          >
            <div className={'grid grid-cols-[6.75rem_3rem_minmax(0,1fr)_3rem] items-center gap-3'}>
              <div className={'flex gap-2'}>
                <button
                  type={'button'}
                  onClick={() => void togglePlayback()}
                  className={
                    'flex h-8 min-w-0 flex-1 items-center justify-center rounded bg-white/10 text-xs font-semibold hover:bg-white/20'
                  }
                  aria-label={isPaused ? '재생' : '일시정지'}
                >
                  {isPaused ? '재생' : '정지'}
                </button>
                <button
                  type={'button'}
                  onClick={toggleSubtitles}
                  disabled={!selectedSubtitleTrack}
                  aria-pressed={isSubtitleEnabled}
                  aria-label={isSubtitleEnabled ? '자막 끄기' : '자막 켜기'}
                  className={`h-8 w-12 shrink-0 rounded text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${isSubtitleEnabled ? 'bg-indigo-500/80 text-white hover:bg-indigo-400' : 'bg-white/10 text-zinc-300 hover:bg-white/20'}`}
                >
                  {'자막'}
                </button>
              </div>
              <span className={'text-right text-xs tabular-nums text-zinc-300'}>
                {formatTime(currentTimeSec)}
              </span>
              <input
                type={'range'}
                min={0}
                max={seekBarMax}
                step={0.1}
                value={Math.min(currentTimeSec, seekBarMax)}
                disabled={seekBarMax <= 0}
                aria-label={'재생 위치'}
                onPointerDown={(event) => {
                  stopSmoothSeek(false)
                  mouseSeekingRef.current = true
                  setIsSeekingWithMouse(true)
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerUp={finishMouseSeek}
                onPointerCancel={finishMouseSeek}
                onBlur={finishMouseSeek}
                onChange={handleSeekChange}
                className={
                  'h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-400 disabled:cursor-not-allowed disabled:opacity-50'
                }
                style={{
                  background: `linear-gradient(to right, #818cf8 0%, #818cf8 ${seekBarProgress}%, #3f3f46 ${seekBarProgress}%, #3f3f46 100%)`,
                }}
              />
              <span className={'text-xs tabular-nums text-zinc-400'}>{formatTime(seekBarMax)}</span>
            </div>
            {orderedSubtitles.length > 1 && (
              <label className="mt-2 flex items-center justify-end gap-2 text-xs text-zinc-300">
                자막 선택
                <select
                  aria-label="자막 선택"
                  value={selectedSubtitleId ?? ''}
                  onMouseDown={(event) => event.stopPropagation()}
                  onChange={(event) => selectSubtitleTrack(event.target.value)}
                  className="h-7 max-w-[70%] rounded border border-zinc-600 bg-zinc-900 px-2 text-zinc-100"
                >
                  {orderedSubtitles.map((subtitle) => (
                    <option key={subtitle.id} value={subtitle.id}>
                      {subtitleTrackLabel(subtitle, video.filePath)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {!useInAppPlayback && nativePlayerInfo && (
          <div
            className={
              'absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center text-sm text-white'
            }
          >
            <p>{'이 형식은 외부 플레이어에서 더 안정적으로 재생됩니다.'}</p>
            <div className={'flex gap-3'}>
              <button
                onClick={requestNativePlayback}
                disabled={openInNativePlayer.isPending}
                className={
                  'rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500'
                }
              >
                {openInNativePlayer.isPending
                  ? '외부 플레이어 여는 중...'
                  : `${formatPlayerName(nativePlayerInfo)}로 열기`}
              </button>
              <button
                disabled={openInNativePlayer.isPending}
                onClick={enableInAppPlayback}
                className={
                  'rounded bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700'
                }
              >
                {'인앱 플레이어로 시도'}
              </button>
            </div>
          </div>
        )}
        {(isPlaybackSourceLoading || showConversionJob) && (
          <div
            className={
              'absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-y-auto bg-black/70 px-6 py-12 text-center text-sm text-white'
            }
          >
            <p className="max-w-lg">
              {conversionJob?.status === 'queued'
                ? '영상 변환 순서를 기다리고 있습니다. 홈에서 다른 영상을 둘러볼 수 있습니다.'
                : conversionJob?.status === 'paused'
                  ? '영상 변환을 일시정지했습니다.'
                  : conversionJob?.status === 'failed'
                    ? '영상 변환에 실패했습니다. 다시 시도하거나 홈에서 대기열을 관리할 수 있습니다.'
                    : needsCompatiblePlayback(video.filePath, video.codec) || conversionJob
                      ? '인앱 재생을 위해 영상을 변환하고 있습니다. 처음 변환할 때는 시간이 걸릴 수 있으며, 다음 재생부터는 저장된 변환본을 사용합니다.'
                      : '재생 가능한 소스를 준비하고 있습니다...'}
            </p>
            {showConversionJob && (
              <div className="w-full max-w-lg">
                <ConversionQueueItem job={conversionJob} compact />
              </div>
            )}
            <button
              type="button"
              onClick={() => navigate('/')}
              className="rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-100 hover:bg-zinc-700"
            >
              홈에서 진행상황 보기
            </button>
          </div>
        )}
        {isPlaybackSourceError && !showConversionJob && (
          <div
            className={
              'absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center text-sm text-red-300'
            }
          >
            <p>{'이 영상을 재생할 수 없습니다.'}</p>
            {playbackSourceError && (
              <p className="max-w-lg text-xs">{playbackSourceError.message}</p>
            )}
            <button
              type="button"
              onClick={() => setPlaybackSourceEpoch((value) => value + 1)}
              className="rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500"
            >
              다시 시도
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="rounded bg-zinc-800 px-4 py-2 text-zinc-100 hover:bg-zinc-700"
            >
              홈으로 돌아가기
            </button>
            {nativePlayerInfo && (
              <button
                onClick={requestNativePlayback}
                disabled={openInNativePlayer.isPending}
                className={
                  'rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500'
                }
              >
                {openInNativePlayer.isPending
                  ? '외부 플레이어 여는 중...'
                  : `${formatPlayerName(nativePlayerInfo)}로 열기`}
              </button>
            )}
          </div>
        )}
      </div>
      {durationSec > 0 && (!view.isFullscreen || view.fullscreenMode === 'highlights') && (
        <div
          role="group"
          aria-label="하이라이트 위치"
          className={
            view.isFullscreen
              ? 'absolute inset-x-0 bottom-0 z-20 h-8 border-t border-white/10 bg-black/40'
              : 'h-8 shrink-0 border-t border-zinc-700 bg-zinc-900 px-4'
          }
        >
          <div
            className={
              view.isFullscreen
                ? 'h-full'
                : 'grid h-full grid-cols-[6.75rem_3rem_minmax(0,1fr)_3rem] gap-3'
            }
          >
            <div
              className={view.isFullscreen ? 'relative mx-3 h-full' : 'relative col-start-3 h-full'}
            >
              {orderedHighlights.map((highlight) => (
                <HighlightMarker
                  highlight={highlight}
                  durationSec={durationSec}
                  onJump={(timeSec) => void jumpToTime(timeSec)}
                  onDelete={() => deleteHighlight.mutate(highlight.id)}
                  key={highlight.id}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      {!view.isFullscreen && orderedHighlights.length > 0 && (
        <div
          className={
            'max-h-40 shrink-0 overflow-y-auto border-t border-zinc-700 bg-zinc-900 px-3 py-2'
          }
        >
          <p className={'mb-1 text-xs font-semibold text-zinc-400'}>{'하이라이트'}</p>
          <div className={'flex flex-col gap-1'}>
            {orderedHighlights.map((highlight) => (
              <div className={'flex items-center gap-2 text-xs'} key={highlight.id}>
                <span
                  className={'h-2 w-2 shrink-0 rounded-full'}
                  style={{
                    backgroundColor: colorToHex(highlight.color),
                  }}
                />
                <button
                  onClick={() => void jumpToTime(highlight.timeStart)}
                  className={'text-zinc-300 hover:text-white'}
                >
                  {formatTime(highlight.timeStart)}
                </button>
                {highlight.label && <span className={'text-zinc-500'}>{highlight.label}</span>}
                <button
                  onClick={() => deleteHighlight.mutate(highlight.id)}
                  className={'ml-auto text-zinc-600 hover:text-red-400'}
                >
                  {'삭제'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
function HighlightMarker({ highlight, durationSec, onJump, onDelete }) {
  const pct = (highlight.timeStart / durationSec) * 100
  return (
    <button
      title={`${formatTime(highlight.timeStart)}${highlight.label ? ` - ${highlight.label}` : ''}`}
      onClick={() => onJump(highlight.timeStart)}
      onContextMenu={(event) => {
        event.preventDefault()
        onDelete()
      }}
      className={'absolute top-1 h-6 w-1.5 -translate-x-1/2 rounded-xs'}
      style={{
        left: `${pct}%`,
        backgroundColor: colorToHex(highlight.color),
      }}
    />
  )
}
function findPreviousHighlight(highlights, baseTime) {
  const previousHighlights = [...highlights]
    .filter((highlight) => highlight.timeStart < baseTime - 0.05)
    .sort((a2, b2) => b2.timeStart - a2.timeStart)
  const nearestPrevious = previousHighlights[0]
  if (!nearestPrevious) return void 0
  if (baseTime - nearestPrevious.timeStart > 1) {
    return nearestPrevious
  }
  return previousHighlights[1] ?? nearestPrevious
}
function colorToHex(color2) {
  const map2 = {
    yellow: '#facc15',
    red: '#ef4444',
    blue: '#3b82f6',
    green: '#22c55e',
    purple: '#a855f7',
  }
  return map2[color2] ?? '#facc15'
}
function formatTime(sec) {
  const safeSec = Math.max(0, Math.floor(sec))
  const hours = Math.floor(safeSec / 3600)
  const minutes = Math.floor((safeSec % 3600) / 60)
  const seconds = Math.floor(safeSec % 60)
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
function formatPlayerName(player) {
  const map2 = {
    ffplay: 'FFplay',
    mpv: 'mpv',
    vlc: 'VLC',
  }
  return map2[player.name]
}
function stopInAppPlayback(videoElement) {
  if (!videoElement) return
  videoElement.pause()
  videoElement.removeAttribute('src')
  videoElement.load()
}
function getAcceleratedSeekStep(baseDeltaSec, elapsedMs) {
  const magnitude = Math.abs(baseDeltaSec)
  const initialStep = magnitude === 1 ? 0.1 : magnitude >= 30 ? 2 : magnitude >= 5 ? 0.75 : 0.2
  const accelerationRatio = Math.min(1, Math.max(0, elapsedMs - 250) / 1750)
  return initialStep + (5 - initialStep) * accelerationRatio
}
function getVideoDuration(videoElement, fallbackDurationSec) {
  if (Number.isFinite(videoElement.duration) && videoElement.duration > 0) {
    return videoElement.duration
  }
  return Number.isFinite(fallbackDurationSec) && fallbackDurationSec > 0 ? fallbackDurationSec : 0
}
function clampTime(timeSec, durationSec) {
  const safeTime = Number.isFinite(timeSec) ? timeSec : 0
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return Math.max(0, safeTime)
  }
  return Math.max(0, Math.min(safeTime, durationSec))
}
function isTextEditingTarget(target) {
  if (target instanceof HTMLElement && target.isContentEditable) return true
  if (target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLTextAreaElement) return true
  if (!(target instanceof HTMLInputElement)) return false
  return ['email', 'number', 'password', 'search', 'tel', 'text', 'url'].includes(target.type)
}
function generatedSubtitleInfo(filePath, videoPath) {
  if (!filePath) return null
  const fileName = filePath.split(/[\\/]/).pop()
  const videoName = videoPath.split(/[\\/]/).pop()
  const stem = fileName.replace(/\.[^.]+$/, '')
  const videoStem = videoName.replace(/\.[^.]+$/, '')
  if (!stem.toLowerCase().startsWith(videoStem.toLowerCase() + '.ai')) return null
  const suffix = stem.slice(videoStem.length).match(/^\.ai(?:\.([1-9]\d*))?(\.ko)?$/i)
  return suffix ? { version: Number(suffix[1] ?? 1), korean: Boolean(suffix[2]) } : null
}
function orderSubtitleTracks(subtitles, videoPath) {
  return [...subtitles].sort((a, b) => {
    const first = generatedSubtitleInfo(a.filePath, videoPath)
    const second = generatedSubtitleInfo(b.filePath, videoPath)
    const priority = (track) => (track ? (track.korean ? 2 : 1) : 0)
    return (
      priority(second) - priority(first) ||
      (second?.version ?? 0) - (first?.version ?? 0) ||
      (a.filePath ?? '').localeCompare(b.filePath ?? '')
    )
  })
}
function subtitleTrackLabel(subtitle, videoPath) {
  const generated = generatedSubtitleInfo(subtitle.filePath, videoPath)
  const language =
    { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어' }[subtitle.lang] ??
    subtitle.lang ??
    (generated?.korean ? '한국어' : generated ? '원어' : '자막')
  const fileName = subtitle.isEmbedded ? '내장 자막' : subtitle.filePath?.split(/[\\/]/).pop()
  return `${language} · ${fileName || '파일 위치 없음'}`
}
function findDuplicateHighlight(highlights, timeSec) {
  for (const highlight of highlights) {
    if (Math.abs(highlight.timeStart - timeSec) <= 0.5) {
      return highlight
    }
  }
  return null
}
function findPreviousSubtitleCue(cues, baseTime) {
  const previousCues = cues
    .filter((cue) => cue.startSec < baseTime - 0.05)
    .sort((a2, b2) => b2.startSec - a2.startSec)
  const nearestPrevious = previousCues[0]
  if (!nearestPrevious) return void 0
  if (baseTime - nearestPrevious.startSec > 1) {
    return nearestPrevious
  }
  return previousCues[1] ?? nearestPrevious
}
function parseSubtitleCues(rawText) {
  const normalized = rawText
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (!normalized) return []
  const withoutHeader = normalized.startsWith('WEBVTT')
    ? normalized.replace(/^WEBVTT[^\n]*\n+/, '')
    : normalized
  const blocks = withoutHeader.split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length < 2) continue
    if (lines[0].startsWith('NOTE') || lines[0] === 'STYLE' || lines[0] === 'REGION') continue
    const timelineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timelineIndex === -1) continue
    const [startRaw, endRaw] = lines[timelineIndex].split('-->').map((value) => value.trim())
    const startSec = parseSubtitleTimestamp(startRaw)
    const endSec = parseSubtitleTimestamp(endRaw.split(/\s+/)[0])
    const text = decodeSubtitleEntities(
      lines
        .slice(timelineIndex + 1)
        .join('\n')
        .trim(),
    )
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !text) continue
    cues.push({
      startSec,
      endSec,
      text,
    })
  }
  return cues
}
function decodeSubtitleEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    lrm: '\u200e',
    rlm: '\u200f',
  }
  // Decode once to plain text; React still renders angle brackets as text, never HTML.
  return text.replace(
    /&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi,
    (entity, value) => {
      if (value[0] !== '#') return named[value.toLowerCase()]
      const hexadecimal = value[1].toLowerCase() === 'x'
      const code = Number.parseInt(value.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity
    },
  )
}
function parseSubtitleTimestamp(value) {
  const match = value.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/)
  if (!match) return Number.NaN
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2] ?? 0)
  const seconds = Number(match[3] ?? 0)
  const milliseconds = Number(match[4] ?? 0)
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1e3
}
export default VideoPlayer
export {
  parseSubtitleCues,
  parseSubtitleTimestamp,
  clampTime,
  getAcceleratedSeekStep,
  findPreviousHighlight,
}
