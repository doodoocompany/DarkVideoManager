// Actual packaged IPC checks for #90/#92/#93, using only disposable fixtures.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { _electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const executable = path.resolve(
  process.argv[2] || 'dist-electron/win-unpacked/DarkVideoManager.exe',
)
const packagedRoot = path.dirname(executable)
const code = require('@electron/asar')
  .extractFile(path.join(packagedRoot, 'resources/app.asar'), path.join('out', 'main', 'index.js'))
  .toString('utf8')
assert.ok(code.includes('DVM_USER_DATA_DIR') && code.includes('DVM_SMOKE_TEST'))
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-release-035-'))
const media = path.join(fixture, 'media')
const video = path.join(media, 'sample.mp4')
const offline = path.join(media, 'sample.offline')
fs.mkdirSync(media)

async function main() {
  let app
  const passed = []
  try {
    execFileSync(
      path.join(packagedRoot, 'resources/media/win32-x64/ffmpeg.exe'),
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x180:r=10:d=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        video,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    const env = {
      ...process.env,
      DVM_USER_DATA_DIR: path.join(fixture, 'profile'),
      DVM_SMOKE_TEST: '1',
    }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: executable,
      args: [],
      cwd: root,
      env,
      timeout: 60000,
    })
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), '0.3.5')
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), env.DVM_USER_DATA_DIR)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const invoke = (group, method, ...args) =>
      page.evaluate(({ group, method, args }) => window.api[group][method](...args), {
        group,
        method,
        args,
      })
    const value = (result) => {
      assert.equal(result.ok, true, result.error)
      return result.value
    }
    const library = value(await invoke('library', 'create', 'Release 0.3.5 test', media))
    value(await invoke('library', 'open', library.id))
    assert.equal(value(await invoke('library', 'importFolder', library.id, media)).added, 1)
    const item = value(await invoke('videos', 'search', library.id, { page: 1, pageSize: 10 }))
      .videos[0]
    assert.equal(value(await invoke('videos', 'getPlaybackSource', library.id, item.id)), video)
    passed.push('version, isolated profile and ordinary H.264 source')

    value(await invoke('videos', 'updateMeta', library.id, item.id, { rating: 4.5 }))
    assert.equal(value(await invoke('videos', 'get', library.id, item.id)).rating, 4.5)
    const stats = value(await invoke('stats', 'get', library.id))
    assert.equal(stats.avgRating, 4.5)
    assert.equal(stats.distributions.ratings.find((bucket) => bucket.key === '4.5').count, 1)
    assert.equal(
      (await invoke('videos', 'updateMeta', library.id, item.id, { rating: 4.25 })).ok,
      false,
    )
    assert.equal(
      (await invoke('videos', 'updateMeta', library.id, item.id, { playCount: 1.5 })).ok,
      false,
    )
    passed.push('half-star persistence and statistics, invalid fractions/counts rejected')

    fs.renameSync(video, offline)
    for (const method of ['getPlaybackSource', 'openInNativePlayer']) {
      const result = await invoke('videos', method, library.id, item.id)
      assert.equal(result.ok, false)
      assert.match(result.error, /원본 파일을 찾을 수 없습니다/)
    }
    passed.push('missing file diagnosis before direct/native playback')
    fs.renameSync(offline, video)
    assert.equal(value(await invoke('videos', 'getPlaybackSource', library.id, item.id)), video)
    passed.push('source retry succeeds after file restoration')

    const worker = fs.readFileSync(path.join(packagedRoot, 'resources/subtitles/generate.py'))
    assert.deepEqual(worker, fs.readFileSync(path.join(root, 'resources/subtitles/generate.py')))
    assert.match(worker.toString('utf8'), /READ_TIMEOUT_SECONDS = 120/)
    assert.match(worker.toString('utf8'), /ATTEMPT_TIMEOUT_SECONDS = 300/)
    assert.match(worker.toString('utf8'), /"think": False, "stream": True/)
    passed.push('packaged translation worker matches the tested streaming source')

    const result = { version: '0.3.5', passed }
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'test-results/release-035-packaged.json'),
      JSON.stringify(result, null, 2),
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await app?.close()
    const target = path.resolve(fixture)
    assert.equal(path.dirname(target).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
    assert.ok(path.basename(target).startsWith('dvm-release-035-'))
    fs.rmSync(target, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
