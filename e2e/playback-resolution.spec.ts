import { execFileSync } from 'node:child_process'
import { getFfmpegPath } from '../scripts/media-paths.cjs'
import { expect, test, type Page } from '@playwright/test'

const resolutions = [
  { name: 'fdiHks-sized', width: 792, height: 592 },
  { name: 'portrait', width: 360, height: 640 },
  { name: 'widescreen', width: 1280, height: 720 },
  { name: '4K', width: 3840, height: 2160 },
]

async function openDecodedVideo(page: Page, size: (typeof resolutions)[number]) {
  const ffmpegPath = getFfmpegPath()
  // Generate synthetic frames in memory; never read or modify a user's videos.
  const fixture = execFileSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${size.width}x${size.height}:rate=1`,
      '-frames:v',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  await page.route('**/resolution-fixture.mp4', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: fixture }),
  )
  // Chrome has no Electron local-media protocol. Replace only the URL adapter;
  // all video decoding, intrinsic dimensions, events, and layout remain real.
  await page.route('**/utils/media.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'export function toLocalMediaUrl(path) { return path }',
    }),
  )
  await page.goto('/')
  await page.evaluate(async (dimensions) => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing video fixture')
    Object.assign(result.value, {
      width: dimensions.width,
      height: dimensions.height,
      durationSec: 2,
      resumePosSec: 0,
      codec: 'h264',
    })
    window.api.videos.getPlaybackSource = async () => ({
      ok: true,
      value: '/resolution-fixture.mp4',
    })
    window.api.videos.getNativePlayerInfo = async () => ({ ok: true, value: null })
    window.api.highlights.list = async () => ({
      ok: true,
      value: Array.from({ length: 8 }, (_, index) => ({
        id: `resolution-highlight-${index}`,
        videoId: 'mock-video-1',
        timeStart: index / 10,
        label: `Layout highlight ${index + 1}`,
        color: 'yellow',
        createdAt: '2026-10-10T00:00:00.000Z',
      })),
    })
  }, size)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await page
    .getByRole('button')
    .filter({
      has: page.getByText('Sample video', { exact: true }),
    })
    .dblclick()
  await expect
    .poll(() =>
      page.locator('video').evaluate((video: HTMLVideoElement) => ({
        width: video.videoWidth,
        height: video.videoHeight,
        decoded: video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
        error: video.error?.message ?? null,
      })),
    )
    .toEqual({ width: size.width, height: size.height, decoded: true, error: null })
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause())
}

async function expectPlayerFits(page: Page, detailVisible: boolean) {
  const bounds = await page.locator('video').evaluate((video: HTMLVideoElement) => {
    const rect = video.getBoundingClientRect()
    const stage = video.parentElement!.getBoundingClientRect()
    const controls = document
      .querySelector('[aria-label="재생 위치"]')
      ?.parentElement?.parentElement?.getBoundingClientRect()
    const panel = document.querySelector('aside')?.getBoundingClientRect()
    return {
      video: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      stage: { left: stage.left, top: stage.top, right: stage.right, bottom: stage.bottom },
      controls: controls
        ? {
            left: controls.left,
            top: controls.top,
            right: controls.right,
            bottom: controls.bottom,
            height: controls.height,
          }
        : null,
      panel: panel ? { left: panel.left, right: panel.right } : null,
      width: window.innerWidth,
      height: window.innerHeight,
    }
  })
  expect(bounds.video.left).toBeGreaterThanOrEqual(-1)
  expect(bounds.video.top).toBeGreaterThanOrEqual(-1)
  expect(bounds.video.right).toBeLessThanOrEqual(bounds.width + 1)
  expect(bounds.video.bottom).toBeLessThanOrEqual(bounds.height + 1)
  expect(bounds.stage.bottom).toBeLessThanOrEqual(bounds.height + 1)
  expect(bounds.video.right).toBeLessThanOrEqual(bounds.stage.right + 1)
  expect(bounds.video.bottom).toBeLessThanOrEqual(bounds.stage.bottom + 1)
  expect(bounds.controls).not.toBeNull()
  expect(bounds.controls!.height).toBeGreaterThan(0)
  expect(bounds.video.bottom).toBeLessThanOrEqual(bounds.controls!.top + 1)
  expect(bounds.controls!.left).toBeGreaterThanOrEqual(-1)
  expect(bounds.controls!.right).toBeLessThanOrEqual(bounds.width + 1)
  expect(bounds.controls!.bottom).toBeLessThanOrEqual(bounds.height + 1)
  if (detailVisible) {
    expect(bounds.panel).not.toBeNull()
    expect(bounds.video.right).toBeLessThanOrEqual(bounds.panel!.left + 1)
    expect(bounds.controls!.right).toBeLessThanOrEqual(bounds.panel!.left + 1)
    expect(bounds.panel!.right).toBeLessThanOrEqual(bounds.width + 1)
  } else {
    expect(bounds.panel).toBeNull()
  }
  await expect(page.getByRole('slider', { name: '재생 위치' })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: '재생', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: '자막 끄기', exact: true })).toBeInViewport({
    ratio: 1,
  })
  await expect(page.getByText('Layout highlight 1', { exact: true }).first()).toBeInViewport({
    ratio: 1,
  })
}

for (const resolution of resolutions) {
  test(`${resolution.name} decoded video fits with highlights, maximize, and window resize`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await openDecodedVideo(page, resolution)
    await expectPlayerFits(page, true)
    await page.screenshot({ path: `test-results/playback-resolution-${resolution.name}.png` })

    await page.getByRole('button', { name: '플레이어 최대화', exact: true }).click()
    await expect(page.getByRole('button', { name: '상세 보기', exact: true })).toBeVisible()
    await expectPlayerFits(page, false)

    await page.setViewportSize({ width: 900, height: 600 })
    await expectPlayerFits(page, false)
    await page.getByRole('button', { name: '상세 보기', exact: true }).click()
    await expectPlayerFits(page, true)

    await page.setViewportSize({ width: 1600, height: 900 })
    await expectPlayerFits(page, true)
  })
}
