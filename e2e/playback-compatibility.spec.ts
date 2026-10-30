import { expect, test, type Page } from '@playwright/test'
import type { NativePlayerInfo, NativePlayerOptions } from '../src/shared/types'

interface CompatibilityHarness {
  sources: number
  sourceError?: string
  launches: NativePlayerOptions[]
  finishDetection: () => void
  finishSource: () => void
}
type CompatibilityWindow = Window & { compatibilityHarness: CompatibilityHarness }

async function preparePlayback(
  page: Page,
  options: {
    codec?: string
    extension?: string
    noNative?: boolean
    deferDetection?: boolean
    deferSource?: boolean
    failLaunch?: boolean
    sourceError?: string
  } = {},
): Promise<void> {
  await page.goto('/')
  await page.evaluate(async (settings) => {
    const video = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!video.ok || !video.value) throw new Error('Missing video fixture')
    video.value.codec = settings.codec ?? 'mpeg4'
    video.value.filePath = `C:\\영상 폴더\\[SHANA] 샘플.${settings.extension ?? 'mp4'}`
    video.value.resumePosSec = 73.4
    const state: CompatibilityHarness = {
      sources: 0,
      sourceError: settings.sourceError,
      launches: [],
      finishDetection: () => undefined,
      finishSource: () => undefined,
    }
    ;(window as unknown as CompatibilityWindow).compatibilityHarness = state
    const player: NativePlayerInfo = { name: 'vlc', path: 'C:\\Players\\vlc.exe' }
    window.api.videos.getNativePlayerInfo = async () => {
      if (settings.deferDetection)
        await new Promise<void>((resolve) => {
          state.finishDetection = resolve
        })
      return { ok: true, value: settings.noNative ? null : player }
    }
    window.api.videos.getPlaybackSource = async () => {
      state.sources += 1
      if (state.sourceError) return { ok: false, error: state.sourceError }
      if (settings.deferSource)
        await new Promise<void>((resolve) => {
          state.finishSource = resolve
        })
      return { ok: true, value: '/cache/compatible.mp4' }
    }
    window.api.videos.openInNativePlayer = async (_libraryId, _videoId, launchOptions) => {
      state.launches.push(launchOptions ?? {})
      if (settings.failLaunch) return { ok: false, error: 'VLC 실행 테스트 실패' }
      return { ok: true, value: player }
    }
  }, options)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({ has: page.getByText('Sample video', { exact: true }) })
    .dblclick()
  await expect(page.locator('video')).toBeVisible()
}

async function playbackState(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as CompatibilityWindow).compatibilityHarness
    return { sources: state.sources, launches: state.launches }
  })
}

async function dispatchMediaError(page: Page, code: number): Promise<void> {
  await page.locator('video').evaluate((video: HTMLVideoElement, errorCode) => {
    Object.defineProperty(video, 'error', { configurable: true, value: { code: errorCode } })
    video.dispatchEvent(new Event('error'))
  }, code)
}

test('missing drive explains file access and can retry after reconnection', async ({ page }) => {
  await preparePlayback(page, {
    codec: 'h264',
    sourceError:
      '영상 원본 파일을 찾을 수 없습니다. 외장 드라이브 또는 네트워크 드라이브 연결과 파일 위치를 확인한 뒤 다시 시도해 주세요.',
  })
  await expect(page.getByText('이 영상을 재생할 수 없습니다.', { exact: true })).toBeVisible()
  await expect(page.getByText('영상 원본 파일을 찾을 수 없습니다.', { exact: false })).toBeVisible()
  await expect(
    page.getByText('이 영상의 코덱을 인앱 플레이어에서 재생할 수 없습니다.', { exact: true }),
  ).toHaveCount(0)
  await expect(page.locator('video')).not.toHaveAttribute('src')
  await page.evaluate(() => {
    ;(window as unknown as CompatibilityWindow).compatibilityHarness.sourceError = undefined
  })
  await page.getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(page.locator('video')).toHaveAttribute('src', /compatible.mp4/)
  await expect(page.getByText('이 영상을 재생할 수 없습니다.', { exact: true })).toHaveCount(0)
  expect(await playbackState(page)).toEqual({ sources: 2, launches: [] })
})

test('MPEG-4 MP4 starts in-app before native discovery and preserves resume through a manual native round trip', async ({
  page,
}) => {
  await preparePlayback(page, { deferDetection: true })
  await expect(page.locator('video')).toHaveAttribute('src', /compatible.mp4/)
  expect(await playbackState(page)).toEqual({ sources: 1, launches: [] })
  await page.evaluate(() =>
    (window as unknown as CompatibilityWindow).compatibilityHarness.finishDetection(),
  )
  await expect(page.getByRole('button', { name: 'VLC로 열기', exact: true })).toBeVisible()
  expect((await playbackState(page)).launches).toHaveLength(0)
  await page.getByRole('button', { name: 'VLC로 열기', exact: true }).click()
  await expect.poll(async () => (await playbackState(page)).launches.length).toBe(1)
  expect((await playbackState(page)).launches[0].startTimeSec).toBe(73.4)
  expect((await playbackState(page)).sources).toBe(1)
  await page.locator('video').evaluate((video) => {
    // Reset events from unloading the in-app element must not erase native resume.
    video.dispatchEvent(new Event('timeupdate'))
    video.dispatchEvent(new Event('seeked'))
  })
  await page.getByRole('button', { name: '인앱 플레이어로 시도', exact: true }).click()
  await expect(page.locator('video')).toHaveAttribute('src', /compatible.mp4/)
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    Object.defineProperty(video, 'duration', { configurable: true, value: 125 })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    video.dispatchEvent(new Event('loadedmetadata'))
  })
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBe(73.4)
  await dispatchMediaError(page, 4)
  await dispatchMediaError(page, 4)
  await expect(page.getByRole('alert')).toContainText('코덱을 인앱 플레이어에서 재생할 수 없습니다')
  expect((await playbackState(page)).launches).toHaveLength(1)
  expect((await playbackState(page)).sources).toBe(2)
})

test('compatible in-app conversion explains the initial wait and cache reuse', async ({ page }) => {
  await preparePlayback(page, { deferSource: true })
  await expect(
    page.getByText('인앱 재생을 위해 영상을 변환하고 있습니다.', { exact: false }),
  ).toContainText('다음 재생부터는 저장된 변환본을 사용합니다')
  expect(await playbackState(page)).toEqual({ sources: 1, launches: [] })
  await page.evaluate(() =>
    (window as unknown as CompatibilityWindow).compatibilityHarness.finishSource(),
  )
  await expect(page.locator('video')).toHaveAttribute('src', /compatible.mp4/)
  await expect(
    page.getByText('인앱 재생을 위해 영상을 변환하고 있습니다.', { exact: false }),
  ).toHaveCount(0)
})

test('MPEG-4 MP4 requests a compatible in-app source when no native player exists', async ({
  page,
}) => {
  await preparePlayback(page, { noNative: true })
  await expect(page.locator('video')).toHaveAttribute('src', /compatible.mp4/)
  expect(await playbackState(page)).toEqual({ sources: 1, launches: [] })
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    Object.defineProperty(video, 'duration', { configurable: true, value: 125 })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    video.dispatchEvent(new Event('loadedmetadata'))
  })
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBe(73.4)
})

test('failed manual native launch retains in-app playback without a relaunch loop', async ({
  page,
}) => {
  await preparePlayback(page, { failLaunch: true })
  await expect(page.locator('video')).toHaveAttribute('src', /compatible.mp4/)
  await page.getByRole('button', { name: 'VLC로 열기', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'VLC 실행 테스트 실패' })).toBeVisible()
  await expect(page.locator('video')).toHaveAttribute('src', /compatible.mp4/)
  await dispatchMediaError(page, 4)
  await dispatchMediaError(page, 3)
  expect((await playbackState(page)).launches).toHaveLength(1)
  expect((await playbackState(page)).sources).toBe(1)
})

test('AVI preserves the explicit native choice and its saved resume position', async ({ page }) => {
  await preparePlayback(page, { extension: 'avi' })
  await expect(
    page.getByRole('button', { name: '인앱 플레이어로 시도', exact: true }),
  ).toBeVisible()
  expect(await playbackState(page)).toEqual({ sources: 0, launches: [] })
  await page.getByRole('button', { name: 'VLC로 열기', exact: true }).first().click()
  await expect.poll(async () => (await playbackState(page)).launches.length).toBe(1)
  expect((await playbackState(page)).launches[0].startTimeSec).toBe(73.4)
})

test('unknown codec failures remain visible and allow manual native recovery without losing resume', async ({
  page,
}) => {
  await page.clock.install()
  await preparePlayback(page, { codec: 'hevc' })
  await expect(page.locator('video')).toHaveAttribute('src', /compatible.mp4/)
  await dispatchMediaError(page, 4)
  await page.clock.fastForward(6000)
  await expect(page.getByRole('alert')).toContainText('코덱을 인앱 플레이어에서 재생할 수 없습니다')
  expect((await playbackState(page)).launches).toHaveLength(0)
  await page.getByRole('button', { name: '외부 플레이어로 다시 재생', exact: true }).click()
  await expect.poll(async () => (await playbackState(page)).launches.length).toBe(1)
  expect((await playbackState(page)).launches[0].startTimeSec).toBe(73.4)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
