// HiveWorm — main entrypoint.
//
// Wires identity + network + world + renderer + input + audio together,
// runs the game loop, handles UI state (splash, spawn, respawn, hints,
// score popup, KO banner, eat-chomp trigger).

import { config } from './config.js'
import { loadOrCreate, downloadBackup, importBackup } from './identity.js'
import { Network } from './network.js'
import { World } from './world.js'
import { Renderer } from './renderer.js'
import { Input } from './input.js'
import { AudioEngine } from './audio.js'
import { SCHEMAS, randomNonce } from './schema.js'

const $ = (sel) => document.querySelector(sel)

// ─── DOM mount points ──────────────────────────────────────
const canvas = $('#world')
const miniMap = $('#mini-map')
const splash = $('#splash')
const hud = $('#hud')
const scoreEl = $('#score')
const cooldownEl = $('#cooldown')
const hintEl = $('#hint')
const statusEl = $('#status')
const wormCountEl = $('#worm-count')
const muteBtn = $('#mute-btn')
const backupBtn = $('#backup-btn')
const importBtn = $('#import-btn')
const importInput = $('#import-input')
const pubkeyLabel = $('#pubkey-label')
const spawnBtn = $('#spawn-btn')
const respawnBtn = $('#respawn-btn')
const tooltip = $('#first-tooltip')
const touchPadHost = $('#touch-pad-host')
const moveHint = $('#move-hint')
const reasonToast = $('#reason-toast')
const koBanner = $('#ko-banner')

let identity, network, world, renderer, input, audio
let myWormSpawned = false
let lastReasonToastTimer = null
let lastChimeLength = 0
let lastScoreShown = 0
let scoreBumpTimer = null

async function main () {
  setStatus('loading meadow...')
  const { identity: id, fresh } = await loadOrCreate()
  identity = id
  pubkeyLabel.textContent = id.publicKeyHex.slice(0, 6) + '…' + id.publicKeyHex.slice(-4)

  if (fresh || config.promptBackup) {
    setTimeout(() => showHint('tip: back up your worm so you can restore it later', 4500), 2000)
  }

  // ─── World + network ─────────────────────────────────────
  world = new World()
  world.on('died', (e) => onDeath(e))
  world.on('ate', (e) => onEat(e))
  world.on('spawned', (e) => onSpawn(e))

  network = new Network({
    relayBase: config.relayBase,
    biome: config.defaultBiome,
    onState: (st) => world.loadState(st, performance.now()),
    onEntry: (entry) => {
      world.applyEntry(entry, performance.now())
      const me = world.worms.get(identity.publicKeyHex)
      myWormSpawned = !!(me && me.alive)
      updateUiForWormState()
    },
    onError: (err) => {
      setStatus('relay error: ' + err.message, 'warn')
    }
  })

  // ─── Renderer + input + audio ───────────────────────────
  renderer = new Renderer(canvas, world)
  renderer.setMyPubkey(identity.publicKeyHex)
  resize()
  window.addEventListener('resize', resize)

  audio = new AudioEngine()
  input = new Input({
    onMove: (direction, ack) => submitMove(direction, ack),
    onMute: () => toggleMute()
  })
  input.start()

  if (isTouchDevice()) {
    touchPadHost.classList.remove('hidden')
    input.mountTouchPad(touchPadHost)
  }

  // ─── Initial state pull ─────────────────────────────────
  try {
    const initialState = await network.getState()
    world.loadState(initialState, performance.now())
    setStatus('connected')
  } catch (err) {
    setStatus('cant reach relay (' + config.relayBase + ')', 'warn')
    showHint(
      'no relay at ' + config.relayBase + '. start one with enableHiveworm:true, or pass ?relay=… in the URL.',
      8000
    )
  }
  network.start()

  // Splash off, HUD on — slight delay so the splash bounces in
  setTimeout(() => {
    splash.classList.add('hidden')
    hud.classList.remove('hidden')
    showFirstTimeTooltip()
  }, 1000)

  // ─── Wire UI buttons ────────────────────────────────────
  spawnBtn.addEventListener('click', () => trySpawn())
  respawnBtn.addEventListener('click', () => trySpawn())
  muteBtn.addEventListener('click', () => toggleMute())
  backupBtn.addEventListener('click', () => {
    audio.unlock()
    audio.play('click')
    downloadBackup(identity)
    showHint('saved backup file. keep it safe.', 3000)
  })
  importBtn.addEventListener('click', () => importInput.click())
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0]
    if (!file) return
    if (!confirm('Import this backup? It will REPLACE your current worm permanently.')) return
    try {
      const newId = await importBackup(file)
      identity = newId
      renderer.setMyPubkey(identity.publicKeyHex)
      pubkeyLabel.textContent = identity.publicKeyHex.slice(0, 6) + '…' + identity.publicKeyHex.slice(-4)
      showHint('imported. your old worm has been replaced.', 4000)
      const st = await network.getState()
      world.loadState(st, performance.now())
    } catch (err) {
      showHint('import failed: ' + err.message, 5000)
    }
    importInput.value = ''
  })

  // Initial state check after load
  const me = world.worms.get(identity.publicKeyHex)
  myWormSpawned = !!(me && me.alive)
  updateUiForWormState()

  // ─── Start the loop ─────────────────────────────────────
  requestAnimationFrame(frame)
}

function frame (now) {
  renderer.draw(now)
  renderer.drawMiniMap(miniMap)

  const me = world.worms.get(identity.publicKeyHex)
  if (me && me.alive) {
    if (me.length !== lastScoreShown) {
      scoreEl.textContent = me.length
      bumpScore()
      lastScoreShown = me.length
    }
    if (me.length >= lastChimeLength + 10) {
      lastChimeLength = Math.floor(me.length / 10) * 10
      audio.play('chime')
    }
  } else {
    if (lastScoreShown !== 0) {
      scoreEl.textContent = '0'
      lastScoreShown = 0
    }
  }
  wormCountEl.textContent = [...world.worms.values()].filter(w => w.alive).length

  // Cooldown indicator
  const remain = input.cooldownRemaining()
  if (remain > 0) {
    cooldownEl.textContent = (remain / 1000).toFixed(1) + 's'
    cooldownEl.style.opacity = '1'
  } else {
    cooldownEl.textContent = 'ready'
    cooldownEl.style.opacity = '0.7'
  }

  requestAnimationFrame(frame)
}

function bumpScore () {
  scoreEl.classList.add('bump')
  clearTimeout(scoreBumpTimer)
  scoreBumpTimer = setTimeout(() => scoreEl.classList.remove('bump'), 200)
}

// ─── Spawning + moving ────────────────────────────────────

async function trySpawn () {
  audio.unlock()
  audio.play('click')
  // Hide KO banner if it was up
  if (koBanner) {
    koBanner.classList.remove('show')
    koBanner.classList.add('hidden')
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const x = Math.floor(Math.random() * (world.config.width - 4)) + 2
    const y = Math.floor(Math.random() * (world.config.height - 4)) + 2
    const entry = {
      schema: SCHEMAS.SPAWN,
      worm: identity.publicKeyHex,
      biome: config.defaultBiome,
      ts: Date.now(),
      nonce: randomNonce(),
      atPos: [x, y]
    }
    await identity.sign(entry)
    try {
      const result = await network.submitMove(entry)
      if (result.ok) {
        myWormSpawned = true
        audio.play('spawn')
        world.applyEntry(entry, performance.now())
        renderer.triggerSpawn([x, y])
        updateUiForWormState()
        return
      }
      if (result.reason === 'spawn-occupied') continue
      showReason('spawn rejected: ' + result.reason)
      return
    } catch (err) {
      showReason('spawn error: ' + err.message)
      return
    }
  }
  showReason('couldnt find a free spawn cell — try again')
}

async function submitMove (direction, ack) {
  if (!myWormSpawned) {
    showHint('click SPAWN first', 1800)
    return
  }
  audio.unlock()
  const me = world.worms.get(identity.publicKeyHex)
  if (!me || !me.alive) {
    showHint('your worm is dead. press RESPAWN.', 1800)
    return
  }
  const entry = {
    schema: SCHEMAS.MOVE,
    worm: identity.publicKeyHex,
    biome: config.defaultBiome,
    ts: Date.now(),
    nonce: randomNonce(),
    direction
  }
  await identity.sign(entry)
  try {
    audio.play('swoosh')
    const result = await network.submitMove(entry)
    if (!result.ok) {
      showReason("can't move there: " + result.reason)
      return
    }
    ack && ack()
    world.applyEntry(entry, performance.now())
  } catch (err) {
    showReason('move error: ' + err.message)
  }
}

// ─── Event hooks ──────────────────────────────────────────

function onDeath (event) {
  audio.play('splat')
  // Play KO stinger after the slide-whistle starts
  setTimeout(() => audio.play('ko'), 320)
  renderer.triggerDeath({ atPos: event.atPos, worm: event.worm })
  if (event.pubkey === identity.publicKeyHex) {
    myWormSpawned = false
    showKoBanner()
    setTimeout(() => updateUiForWormState(), 800)
  }
}

function onEat (event) {
  // Trigger chomp face on the worm whose head landed there
  const worm = world.worms.get(event.pubkey)
  const isRare = !!event.rare
  if (worm) worm.chomp(performance.now())
  if (isRare) {
    audio.play('rare')
  } else {
    audio.play('blip', { variance: ((event.atPos?.[0] || 0) % 5 - 2) * 0.05 })
  }
  renderer.triggerEat(event.atPos, { rare: isRare })
}

function onSpawn (event) {
  if (event.pubkey !== identity.publicKeyHex) {
    audio.play('spawn')
  }
  renderer.triggerSpawn(event.atPos)
}

function showKoBanner () {
  if (!koBanner) return
  koBanner.classList.remove('hidden')
  // restart animation by toggling the class
  koBanner.classList.remove('show')
  // Force reflow so the keyframes re-trigger
  void koBanner.offsetWidth
  koBanner.classList.add('show')
  setTimeout(() => {
    koBanner.classList.add('hidden')
    koBanner.classList.remove('show')
  }, 2200)
}

// ─── UI helpers ───────────────────────────────────────────

function updateUiForWormState () {
  const me = world.worms.get(identity.publicKeyHex)
  const alive = !!(me && me.alive)
  myWormSpawned = alive
  if (alive) {
    spawnBtn.classList.add('hidden')
    respawnBtn.classList.add('hidden')
    moveHint.classList.remove('hidden')
  } else {
    moveHint.classList.add('hidden')
    if (me && !me.alive) {
      spawnBtn.classList.add('hidden')
      respawnBtn.classList.remove('hidden')
      respawnBtn.classList.remove('bounce-in')
      void respawnBtn.offsetWidth
      respawnBtn.classList.add('bounce-in')
    } else {
      spawnBtn.classList.remove('hidden')
      spawnBtn.classList.remove('bounce-in')
      void spawnBtn.offsetWidth
      spawnBtn.classList.add('bounce-in')
      respawnBtn.classList.add('hidden')
    }
  }
}

function showHint (text, ms = 3000) {
  hintEl.textContent = text
  hintEl.classList.remove('hidden')
  clearTimeout(hintEl._t)
  hintEl._t = setTimeout(() => hintEl.classList.add('hidden'), ms)
}

function showReason (text) {
  reasonToast.textContent = text
  reasonToast.classList.remove('hidden')
  // restart shimmy animation
  reasonToast.classList.remove('hidden')
  void reasonToast.offsetWidth
  clearTimeout(lastReasonToastTimer)
  lastReasonToastTimer = setTimeout(() => reasonToast.classList.add('hidden'), 2200)
}

function setStatus (text, kind = 'ok') {
  statusEl.textContent = text
  statusEl.dataset.kind = kind
}

function toggleMute () {
  audio.unlock()
  audio.toggleMute()
  muteBtn.textContent = audio.muted ? '♪ OFF' : '♪ ON'
  muteBtn.dataset.muted = audio.muted ? '1' : '0'
}

function showFirstTimeTooltip () {
  try {
    if (localStorage.getItem('hiveworm/seen-tooltip/v2') === '1') return
  } catch (_) {}
  tooltip.classList.remove('hidden')
  setTimeout(() => {
    tooltip.classList.add('hidden')
    try { localStorage.setItem('hiveworm/seen-tooltip/v2', '1') } catch (_) {}
  }, 6000)
}

function isTouchDevice () {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0)
}

function resize () {
  renderer && renderer.resize()
}

main().catch((err) => {
  console.error('hiveworm fatal:', err)
  setStatus('fatal: ' + err.message, 'error')
  if (splash) {
    const m = splash.querySelector('.splash-msg')
    if (m) m.textContent = 'something went wrong: ' + err.message
  }
})
