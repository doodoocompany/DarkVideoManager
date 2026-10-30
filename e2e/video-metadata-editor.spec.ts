import { expect, test, type Page } from '@playwright/test'
import type { Video, VideoMeta } from '../src/shared/types'

interface MetadataHarness {
  videos: Video[]
  updates: { videoId: string; meta: VideoMeta }[]
  failNext: boolean
  holdNext: boolean
  releaseSave?: () => void
  optionsCalls: number
}
type MetadataWindow = Window & { metadataHarness: MetadataHarness }

function card(page: Page, title = 'Sample video') {
  return page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
}

function editor(page: Page) {
  return page.getByRole('form', { name: '영상 분류 편집', exact: true })
}

async function prepare(page: Page, removed = false) {
  await page.goto('/')
  await page.evaluate(async (isRemoved) => {
    const result = await window.api.videos.get('mock-library', 'mock-video-1')
    if (!result.ok || !result.value) throw new Error('Missing video fixture')
    const first: Video = {
      ...result.value,
      category: '기존 분류',
      tags: '기존, sample',
      memo: '처음 메모',
      removalMode: isRemoved ? 'remove' : undefined,
    }
    const state: MetadataHarness = {
      videos: [
        first,
        {
          ...first,
          id: 'metadata-video-2',
          title: 'Second video',
          fileName: 'second.mp4',
          category: '다른 분류',
          tags: 'other',
          memo: '다른 메모',
        },
      ],
      updates: [],
      failNext: false,
      holdNext: false,
      optionsCalls: 0,
    }
    ;(window as unknown as MetadataWindow).metadataHarness = state
    window.api.videos.get = async (_libraryId, videoId) => ({
      ok: true,
      value: structuredClone(state.videos.find((video) => video.id === videoId) ?? null),
    })
    window.api.videos.search = async (_libraryId, query) => {
      const videos = state.videos.filter(
        (video) => Boolean(video.removalMode) === Boolean(query.removed),
      )
      return {
        ok: true,
        value: { videos: structuredClone(videos), total: videos.length, page: 1, pageSize: 500 },
      }
    }
    window.api.videos.metadataOptions = async (_libraryId, showRemoved = false) => {
      state.optionsCalls += 1
      return {
        ok: true,
        value: {
          categories: [
            ...new Set(
              state.videos
                .filter((video) => Boolean(video.removalMode) === showRemoved)
                .map((video) => video.category ?? '')
                .filter(Boolean),
            ),
          ],
          tags: ['기존', 'sample', 'other'],
        },
      }
    }
    window.api.videos.updateMeta = async (_libraryId, videoId, meta) => {
      state.updates.push({ videoId, meta: structuredClone(meta) })
      if (state.failNext) {
        state.failNext = false
        return { ok: false, error: '분류 저장 테스트 오류' }
      }
      if (state.holdNext) {
        state.holdNext = false
        await new Promise<void>((resolve) => {
          state.releaseSave = resolve
        })
      }
      const video = state.videos.find((item) => item.id === videoId)
      if (!video) return { ok: false, error: '영상을 찾을 수 없습니다.' }
      Object.assign(video, meta)
      return { ok: true, value: null }
    }
    window.api.videos.delete = async (_libraryId, videoId, mode = 'trash') => {
      const video = state.videos.find((item) => item.id === videoId)
      if (video) video.removalMode = mode
      return { ok: true, value: null }
    }
  }, removed)
  await page.getByRole('button', { name: '열기', exact: true }).click()
  if (removed) await page.getByRole('button', { name: '제거한 항목', exact: true }).click()
  await card(page).click()
  await expect(editor(page)).toBeVisible()
}

async function storedVideo(page: Page, id = 'mock-video-1') {
  return page.evaluate(
    (videoId) =>
      (window as unknown as MetadataWindow).metadataHarness.videos.find(
        (video) => video.id === videoId,
      ),
    id,
  )
}

test('classification normalizes input, reuses categories and never overwrites memo or rating', async ({
  page,
}) => {
  await prepare(page)
  const form = editor(page)
  const category = form.getByLabel('카테고리', { exact: true })
  const tags = form.getByLabel('태그', { exact: true })
  const listId = await category.getAttribute('list')
  await expect(page.locator(`datalist[id="${listId}"] option[value="기존 분류"]`)).toHaveCount(1)
  const optionsBefore = await page.evaluate(
    () => (window as unknown as MetadataWindow).metadataHarness.optionsCalls,
  )
  await category.fill('  야구  ')
  await tags.fill('#선수명 #리그, 선수명')
  await form.getByRole('button', { name: '분류 저장', exact: true }).click()
  await expect(form.getByRole('status')).toHaveText('분류를 저장했습니다.')
  await form.screenshot({ path: test.info().outputPath('video-metadata-editor.png') })
  expect(await storedVideo(page)).toMatchObject({
    category: '야구',
    tags: '선수명, 리그',
    memo: '처음 메모',
    rating: 4,
  })
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as MetadataWindow).metadataHarness.optionsCalls),
    )
    .toBeGreaterThan(optionsBefore)

  await page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...').fill('따로 저장한 메모')
  await expect.poll(async () => (await storedVideo(page))?.memo).toBe('따로 저장한 메모')
  await page.getByRole('button', { name: '4.5점', exact: true }).click()
  await expect.poll(async () => (await storedVideo(page))?.rating).toBe(4.5)
  expect(
    await page.evaluate(() => (window as unknown as MetadataWindow).metadataHarness.updates),
  ).toEqual([
    { videoId: 'mock-video-1', meta: { category: '야구', tags: '선수명, 리그' } },
    { videoId: 'mock-video-1', meta: { memo: '따로 저장한 메모' } },
    { videoId: 'mock-video-1', meta: { rating: 4.5 } },
  ])
  await category.fill('')
  await tags.fill('')
  await form.getByRole('button', { name: '분류 저장', exact: true }).click()
  await expect.poll(async () => (await storedVideo(page))?.category).toBe('')
  expect(await storedVideo(page)).toMatchObject({ tags: '', memo: '따로 저장한 메모', rating: 4.5 })
})

test('failed saves preserve drafts and input typed during a retry remains unsaved', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepare(page)
  const form = editor(page)
  await page.evaluate(() => {
    ;(window as unknown as MetadataWindow).metadataHarness.failNext = true
  })
  await form.getByLabel('카테고리', { exact: true }).fill('첫 입력')
  await form.getByRole('button', { name: '분류 저장', exact: true }).click()
  await expect(form.getByRole('alert')).toContainText('분류 저장 테스트 오류')
  await expect(form.getByLabel('카테고리', { exact: true })).toHaveValue('첫 입력')
  expect((await storedVideo(page))?.category).toBe('기존 분류')

  await page.evaluate(() => {
    ;(window as unknown as MetadataWindow).metadataHarness.holdNext = true
  })
  await form.getByRole('button', { name: '분류 저장', exact: true }).click()
  await expect(form.getByRole('button', { name: '분류 저장', exact: true })).toBeDisabled()
  await form.getByLabel('카테고리', { exact: true }).fill('저장 중 새 입력')
  await form.getByLabel('태그', { exact: true }).fill('#새태그')
  await page.evaluate(() => (window as unknown as MetadataWindow).metadataHarness.releaseSave?.())
  await expect.poll(async () => (await storedVideo(page))?.category).toBe('첫 입력')
  await expect(form.getByLabel('카테고리', { exact: true })).toHaveValue('저장 중 새 입력')
  await expect(form.getByLabel('태그', { exact: true })).toHaveValue('#새태그')
  await expect(form.getByRole('status')).toHaveText('저장하지 않은 변경 사항이 있습니다.')
  await form.getByRole('button', { name: '분류 저장', exact: true }).click()
  await expect.poll(async () => (await storedVideo(page))?.tags).toBe('새태그')
  expect((await storedVideo(page))?.category).toBe('저장 중 새 입력')
  expect(errors).toEqual([])
})

test('switching videos keeps separate drafts and a late save updates only its original video', async ({
  page,
}) => {
  await prepare(page)
  await page.evaluate(() => {
    ;(window as unknown as MetadataWindow).metadataHarness.holdNext = true
  })
  await editor(page).getByLabel('카테고리', { exact: true }).fill('첫 영상 저장값')
  await editor(page).getByRole('button', { name: '분류 저장', exact: true }).click()
  await expect(editor(page).getByRole('button', { name: '분류 저장', exact: true })).toBeDisabled()
  await card(page, 'Second video').click()
  await expect(editor(page).getByLabel('카테고리', { exact: true })).toHaveValue('다른 분류')
  await editor(page).getByLabel('카테고리', { exact: true }).fill('둘째 영상 초안')
  await page.evaluate(() => (window as unknown as MetadataWindow).metadataHarness.releaseSave?.())
  await expect.poll(async () => (await storedVideo(page))?.category).toBe('첫 영상 저장값')
  await expect(editor(page).getByLabel('카테고리', { exact: true })).toHaveValue('둘째 영상 초안')
  expect((await storedVideo(page, 'metadata-video-2'))?.category).toBe('다른 분류')
  await card(page).click()
  await expect(editor(page).getByLabel('카테고리', { exact: true })).toHaveValue('첫 영상 저장값')
  await card(page, 'Second video').click()
  await expect(editor(page).getByLabel('카테고리', { exact: true })).toHaveValue('둘째 영상 초안')
  await editor(page).getByRole('button', { name: '분류 저장', exact: true }).click()
  await expect
    .poll(async () => (await storedVideo(page, 'metadata-video-2'))?.category)
    .toBe('둘째 영상 초안')
})

test('server refresh preserves edited fields and refreshes untouched fields', async ({ page }) => {
  await prepare(page)
  await editor(page).getByLabel('카테고리', { exact: true }).fill('아직 저장 안 함')
  await page.evaluate(() => {
    ;(window as unknown as MetadataWindow).metadataHarness.videos[0].tags = '갱신된 태그'
  })
  // Memo autosave refreshes the same video query, as real background updates do.
  await page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...').fill('분류와 별도인 메모')
  await expect(editor(page).getByLabel('태그', { exact: true })).toHaveValue('갱신된 태그')
  await expect(editor(page).getByLabel('카테고리', { exact: true })).toHaveValue('아직 저장 안 함')
  await expect(editor(page).getByRole('button', { name: '분류 저장', exact: true })).toBeEnabled()
})

test('removed videos keep their metadata visible but cannot be edited', async ({ page }) => {
  await prepare(page, true)
  await expect(editor(page).getByLabel('카테고리', { exact: true })).toHaveValue('기존 분류')
  await expect(editor(page).getByLabel('카테고리', { exact: true })).toBeDisabled()
  await expect(editor(page).getByLabel('태그', { exact: true })).toBeDisabled()
  await expect(editor(page).getByRole('button', { name: '분류 저장', exact: true })).toBeDisabled()
  await expect(page.getByPlaceholder('이 영상에 대한 메모를 적어보세요...')).toBeDisabled()
  await expect(page.getByRole('button', { name: '5점', exact: true })).toBeDisabled()
  expect(
    await page.evaluate(() => (window as unknown as MetadataWindow).metadataHarness.updates),
  ).toEqual([])
})
