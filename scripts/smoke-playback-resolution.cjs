// Real Electron playback of synthetic resolutions; user media and settings are never opened.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const appCode = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources/app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
for (const marker of ['DVM_USER_DATA_DIR', 'DVM_SMOKE_TEST'])
  assert.ok(appCode.includes(marker), `Build lacks isolation support: ${marker}`)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-playback-resolution-'))
const media = path.join(temporary, 'media')
const userData = path.join(temporary, 'user-data')
const output = path.join(root, 'test-results')
for (const directory of [media, output]) fs.mkdirSync(directory, { recursive: true })
const fixtures = [
  { name: 'near-four-three', width: 792, height: 592 },
  { name: 'portrait', width: 720, height: 1280 },
  { name: 'ultra-hd', width: 3840, height: 2160 },
].map((fixture) => ({ ...fixture, filePath: path.join(media, `${fixture.name}.mp4`) }))
for (const fixture of fixtures) {
  execFileSync(
    require('./media-paths.cjs').getFfmpegPath(),
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=${fixture.width}x${fixture.height}:r=2:d=3`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      fixture.filePath,
    ],
    { windowsHide: true, stdio: 'ignore' },
  )
}
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const originalHashes = fixtures.map((fixture) => hash(fixture.filePath))
const pageErrors = []
const passed = []
const layouts = []
const reportPath = path.join(
  output,
  executablePath ? 'playback-resolution-packaged.json' : 'playback-resolution-electron.json',
)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(label, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

function assertInside(rect, boundary, label) {
  assert.ok(rect, `${label} missing`)
  assert.ok(rect.width > 0 && rect.height > 0, `${label} has no visible area`)
  const tolerance = 1
  assert.ok(
    rect.left >= boundary.left - tolerance &&
      rect.top >= boundary.top - tolerance &&
      rect.right <= boundary.right + tolerance &&
      rect.bottom <= boundary.bottom + tolerance,
    `${label} exceeds bounds: ${JSON.stringify({ rect, boundary })}`,
  )
}

async function inspectLayout(page, fixture, mode) {
  const layout = await page.evaluate(() => {
    const video = document.querySelector('video')
    const stage = video.parentElement
    const player = stage.parentElement
    const seekBar = player.querySelector('[aria-label="재생 위치"]')
    const playbackControls = seekBar?.parentElement?.parentElement
    const rect = (element) => {
      if (!element) return null
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
      return { left, top, right, bottom, width, height }
    }
    const controls = [...stage.querySelectorAll('button, input')]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => ({
        label: element.getAttribute('aria-label') || element.textContent.trim(),
        bounds: rect(element),
      }))
    const highlights = [...player.querySelectorAll('span')]
      .filter((element) => element.textContent.startsWith('Resolution smoke highlight '))
      .map((element) => ({ text: element.textContent, bounds: rect(element) }))
    return {
      viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      source: video.currentSrc,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      readyState: video.readyState,
      error: video.error && { code: video.error.code, message: video.error.message },
      objectFit: getComputedStyle(video).objectFit,
      stage: rect(stage),
      video: rect(video),
      player: rect(player),
      sidebar: rect(document.querySelector('aside')),
      seekBar: rect(seekBar),
      playbackControls: rect(playbackControls),
      controls,
      highlights,
    }
  })
  const context = `${fixture.width}x${fixture.height} ${mode}`
  assert.equal(layout.videoWidth, fixture.width, `${context}: natural width`)
  assert.equal(layout.videoHeight, fixture.height, `${context}: natural height`)
  assert.equal(layout.error, null, `${context}: decoder error`)
  assert.ok(layout.readyState >= 2, `${context}: decoded frame unavailable`)
  assert.ok(layout.source.startsWith('local-media://'), `${context}: local-media protocol unused`)
  assert.equal(new URL(layout.source).searchParams.get('path'), fixture.filePath)
  assert.equal(layout.objectFit, 'contain', `${context}: aspect ratio must be preserved`)
  assertInside(layout.player, layout.viewport, `${context}: player`)
  assertInside(layout.stage, layout.player, `${context}: video stage`)
  assertInside(layout.video, layout.stage, `${context}: video element`)
  assertInside(layout.playbackControls, layout.player, `${context}: playback controls`)
  assertInside(layout.seekBar, layout.playbackControls, `${context}: seek bar`)
  assert.ok(
    layout.video.bottom <= layout.playbackControls.top + 1,
    `${context}: playback controls overlap the video`,
  )
  assert.ok(layout.stage.height >= 100, `${context}: video stage collapsed`)
  assert.ok(
    layout.controls.some((control) => control.label === '닫기'),
    `${context}: close missing`,
  )
  for (const control of layout.controls)
    assertInside(control.bounds, layout.stage, `${context}: ${control.label}`)
  assert.equal(layout.highlights.length, 3, `${context}: highlight list missing`)
  for (const highlight of layout.highlights)
    assertInside(highlight.bounds, layout.player, `${context}: ${highlight.text}`)
  if (layout.sidebar) assertInside(layout.sidebar, layout.viewport, `${context}: sidebar`)
  assert.ok(layout.document.width <= layout.viewport.right + 1, `${context}: horizontal overflow`)
  assert.ok(layout.document.height <= layout.viewport.bottom + 1, `${context}: vertical overflow`)
  layouts.push({ fixture: fixture.name, mode, ...layout })
  passed.push(context)
}

async function main() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_USER_DATA_DIR: userData,
    DVM_SMOKE_TEST: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60_000,
  })
  let failure
  try {
    assert.equal(
      path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))).toLowerCase(),
      path.resolve(userData).toLowerCase(),
      'App did not honor the isolated user-data directory',
    )
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
    })
    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await until('preload API', () => page.evaluate(() => !!window.api?.videos?.getPlaybackSource))
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${result.error}`)
      return result.value
    }
    const library = await invoke('library', 'create', 'Playback resolution smoke', media)
    await invoke('library', 'open', library.id)
    assert.equal(
      (await invoke('library', 'importFolder', library.id, media)).added,
      fixtures.length,
    )
    const videos = (await invoke('videos', 'search', library.id, { page: 1, pageSize: 20 })).videos
    for (const fixture of fixtures) {
      const video = videos.find((candidate) => candidate.filePath === fixture.filePath)
      assert.ok(video, `Imported fixture missing: ${fixture.name}`)
      assert.equal(video.codec, 'h264')
      assert.equal(video.width, fixture.width)
      assert.equal(video.height, fixture.height)
      for (let index = 1; index <= 3; index++)
        await invoke('highlights', 'create', library.id, {
          videoId: video.id,
          timeStart: index * 0.5,
          label: `Resolution smoke highlight ${index}`,
          color: 'yellow',
        })
      await page.evaluate(
        ({ libraryId, videoId }) => {
          location.hash = `/player/${libraryId}/${videoId}`
        },
        { libraryId: library.id, videoId: video.id },
      )
      await until(`decoded ${fixture.name} frame`, () =>
        page.evaluate((expectedPath) => {
          const video = document.querySelector('video')
          if (
            !video?.currentSrc ||
            new URL(video.currentSrc).searchParams.get('path') !== expectedPath
          )
            return false
          if (video.error)
            throw new Error(`Decoder error ${video.error.code}: ${video.error.message}`)
          if (video.readyState < 2 || video.videoWidth === 0) return false
          video.pause()
          return true
        }, fixture.filePath),
      )
      await until('highlight list', () =>
        page.evaluate(() => {
          const player = document.querySelector('video')?.parentElement?.parentElement
          return (
            player &&
            [...player.querySelectorAll('span')].filter((element) =>
              element.textContent.startsWith('Resolution smoke highlight '),
            ).length === 3
          )
        }),
      )
      // A route change can retain the previous maximized state; restore the sidebar first.
      if ((await page.getByRole('button', { name: '상세 보기', exact: true }).count()) > 0)
        await page.getByRole('button', { name: '상세 보기', exact: true }).click()
      for (const [width, height] of [
        [1280, 800],
        [900, 600],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, { width, height }) => {
            BrowserWindow.getAllWindows()[0].setContentSize(width, height)
          },
          { width, height },
        )
        await until(`${width}x${height} content size`, () =>
          page.evaluate(({ width, height }) => innerWidth === width && innerHeight === height, {
            width,
            height,
          }),
        )
        await inspectLayout(page, fixture, `${width}x${height} with sidebar`)
        await page.getByRole('button', { name: '플레이어 최대화', exact: true }).click()
        await until('maximized player', () => page.evaluate(() => !document.querySelector('aside')))
        await inspectLayout(page, fixture, `${width}x${height} maximized player`)
        await page.getByRole('button', { name: '상세 보기', exact: true }).click()
        await until('restored sidebar', () =>
          page.evaluate(() => !!document.querySelector('aside')),
        )
      }
    }
    assert.deepEqual(
      fixtures.map((fixture) => hash(fixture.filePath)),
      originalHashes,
    )
    assert.deepEqual(pageErrors, [])
    passed.push('source videos unchanged; no renderer exceptions')
  } catch (error) {
    failure = error
    throw error
  } finally {
    const report = {
      passed,
      layouts,
      temporary,
      packaged: !!executablePath,
      pageErrors,
      ...(failure ? { error: String(failure.stack || failure) } : {}),
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    await app.close()
    if (!failure)
      console.log(JSON.stringify({ reportPath, passed, temporary, pageErrors }, null, 2))
  }
}
main().catch((error) => {
  console.error(`Isolated test data: ${temporary}`)
  console.error(error)
  process.exitCode = 1
})
