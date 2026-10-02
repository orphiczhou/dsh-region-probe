/**
 * Contract test for the region-probe client half.
 *
 * Runs the REAL `client.js` in this process against a miniature DOM that models
 * exactly what the shell produces (`data-slot` anchors, `data-slot-error`
 * anchors, a 0x0 anchor with the content in its children, a list slot rendered
 * twice, an empty region, a shadow host, a same-origin frame, a canvas), then
 * judges every answer with the SHIPPED schema engine lifted out of the running
 * app's own `@deepseek-ai/dsh-tools` when that extraction is available.
 *
 * Usage:
 *   node test/contract.cjs [<asar-out-dir>]
 * Default asar-out dir: %TEMP%\dsh-asar-inspect\out
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const CLIENT = path.resolve(__dirname, '..', 'client.js')
const PKGS = path.join(process.argv[2] || path.join(os.tmpdir(), 'dsh-asar-inspect', 'out'), 'dsh', 'node_modules', '@deepseek-ai')

let failures = 0
let skips = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
}
const skip = (name, why) => {
  skips++
  console.log(`  SKIP  ${name}  — ${why}`)
}

// ------------------------------------------------------- shipped schema engine
/** Verbatim `HarnessError` (dsh-llm/lib/index.js). */
class HarnessError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

function loadShippedEngine() {
  const toolsPath = path.join(PKGS, 'dsh-tools', 'lib', 'index.js')
  const utilsPath = path.join(PKGS, 'dsh-util-values', 'lib', 'index.js')
  const toolsSrc = fs.readFileSync(toolsPath, 'utf8')
  const lines = toolsSrc.split(/\r?\n/)
  const start = lines.indexOf('//#region lib/types/json-schema.js')
  const declaredAt = lines.findIndex((line) => line.startsWith('function validateJsonSchemaValue('))
  const end = declaredAt < 0 ? -1 : lines.indexOf('//#endregion', declaredAt)
  if (start < 0 || end < 0) throw new Error('json-schema region not found')
  const region = lines.slice(start, end).join('\n')
  const utilsSrc = fs
    .readFileSync(utilsPath, 'utf8')
    .replace(/^export \{[^}]*\};\s*$/m, '')
    .replace(/^\/\/#region .*$/gm, '')
    .replace(/^\/\/#endregion$/gm, '')
  const mod = new Function(
    'HarnessError',
    `${utilsSrc}
     ${region}
     return { assertSupportedJsonSchema, validateJsonSchemaValue, snapshotJsonValue, JsonSchemaError }`,
  )
  return mod(HarnessError)
}

// ------------------------------------------------------------------ mini DOM
const documentStub = {
  documentElement: null,
  querySelectorAll(selector) {
    return queryAll(documentStub.documentElement, selector)
  },
}

function matches(el, selector) {
  let m
  if (selector === '*') return true
  if ((m = /^\[([A-Za-z-]+)\]$/.exec(selector))) return Object.prototype.hasOwnProperty.call(el.attrs, m[1])
  if ((m = /^\[([A-Za-z-]+)="((?:[^"\\]|\\.)*)"\]$/.exec(selector))) {
    const wanted = m[2].replace(/\\(["\\])/g, '$1')
    return el.attrs[m[1]] === wanted
  }
  if ((m = /^\.([A-Za-z0-9_-]+)$/.exec(selector))) return String(el.attrs.class || '').split(/\s+/).includes(m[1])
  if ((m = /^#([A-Za-z0-9_-]+)$/.exec(selector))) return el.attrs.id === m[1]
  if ((m = /^([A-Za-z][A-Za-z0-9-]*)$/.exec(selector))) return el.tagName.toLowerCase() === selector.toLowerCase()
  throw new Error(`invalid selector: ${selector}`)
}

function descendants(el, out = []) {
  for (const kid of el.children) {
    out.push(kid)
    descendants(kid, out)
  }
  return out
}

function queryAll(root, selector) {
  if (!root) return []
  return descendants(root).filter((el) => matches(el, selector))
}

function makeEl(tag, opts = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: Object.assign({}, opts.attrs),
    children: [],
    childNodes: [],
    parentElement: null,
    shadowRoot: opts.shadowRoot || null,
    contentDocument: opts.contentDocument || null,
    innerText: opts.text === undefined ? '' : opts.text,
    computed: Object.assign(
      { fontSize: '13px', color: 'rgb(230, 232, 238)', backgroundColor: 'rgba(0, 0, 0, 0)' },
      opts.computed,
    ),
    rect: Object.assign({ x: 0, y: 0, width: 0, height: 0 }, opts.rect),
    __shadowRoot: null,
  }
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }
  el.getBoundingClientRect = function () {
    const r = this.rect
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.x + r.width, bottom: r.y + r.height, top: r.y, left: r.x }
  }
  el.querySelectorAll = function (selector) {
    return queryAll(this, selector)
  }
  el.getRootNode = function () {
    if (this.__shadowRoot) return this.__shadowRoot
    return documentStub
  }
  return el
}

function append(parent, child) {
  child.parentElement = parent
  parent.children.push(child)
  parent.childNodes.push(child)
  return child
}

function appendText(parent, value) {
  parent.childNodes.push({ nodeType: 3, nodeValue: value })
  parent.innerText = (parent.innerText || '') + value
  return parent
}

/** Remove a node from its parent — the fixture equivalent of React replacing it. */
function detach(el) {
  const parent = el.parentElement
  if (!parent) return el
  parent.children = parent.children.filter((child) => child !== el)
  parent.childNodes = parent.childNodes.filter((child) => child !== el)
  el.parentElement = null
  return el
}

function attachShadow(host, kids) {
  const root = { host, children: kids, querySelectorAll: (sel) => queryAll({ children: kids }, sel) }
  for (const kid of kids) {
    kid.parentElement = null
    kid.__shadowRoot = root
  }
  host.shadowRoot = root
  return host
}

/** A slot anchor: 0x0 by design, content in the children. */
function anchor(slot, kids, opts = {}) {
  const el = makeEl('div', Object.assign({ attrs: { 'data-slot': slot } }, opts))
  for (const kid of kids || []) append(el, kid)
  return el
}

/** A region the shell rendered as FAILED. */
function failedAnchor(slot) {
  return makeEl('div', { attrs: { 'data-slot-error': slot } })
}

function buildFixture() {
  // sidebar.workspaces: three rows with real text and geometry.
  const row = (label, y, cls = 'rp-row') => {
    const el = makeEl('div', { attrs: { class: cls }, rect: { x: 18, y, width: 256, height: 30 } })
    const labelEl = makeEl('span', { attrs: { class: 'rp-label' }, rect: { x: 28, y, width: 200, height: 30 } })
    appendText(labelEl, label)
    append(el, labelEl)
    return el
  }
  /** A row that carries its text directly, to pin the "own text" semantics. */
  const directRow = (label, y) => {
    const el = makeEl('div', { attrs: { class: 'rp-row' }, rect: { x: 18, y, width: 256, height: 30 } })
    appendText(el, label)
    return el
  }
  const tree = anchor('sidebar.workspaces', [
    row('重构会话树的工作区分组', 269),
    row('分析工作区项目用途', 299),
    row('树形会话菜单修改', 329),
    directRow('直接文本行', 359),
  ])
  tree.innerText = '会话树 重构会话树的工作区分组'

  // A list slot rendered twice (expanded + collapsed rail): one region, two anchors.
  const panellistA = anchor('sidebar.panellist', [makeEl('div', { rect: { x: 12, y: 120, width: 256, height: 76 } })])
  const panellistB = anchor('sidebar.panellist', [makeEl('div', { rect: { x: 12, y: 120, width: 28, height: 76 } })])

  // Declared but nothing rendered inside.
  const emptyRegion = anchor('conversation.input.left', [])

  // A region whose content lives in a shadow root.
  const shadowChild1 = makeEl('span', { rect: { x: 100, y: 200, width: 40, height: 20 } })
  appendText(shadowChild1, 'shadow-text')
  const shadowHost = makeEl('div', { rect: { x: 100, y: 200, width: 60, height: 20 } })
  attachShadow(shadowHost, [shadowChild1])
  const shadowRegion = anchor('sidebar.right.pane', [shadowHost])

  // A region whose content lives in a same-origin frame.
  const frameInner = makeEl('html', { rect: { x: 10, y: 20, width: 300, height: 150 } })
  const frameEl = makeEl('iframe', { rect: { x: 10, y: 20, width: 300, height: 150 }, contentDocument: { documentElement: frameInner } })
  const frameRegion = anchor('sidebar.right.tab.document', [frameEl])

  // A canvas: readable as an element, opaque inside.
  const canvasRegion = anchor('conversation.view', [makeEl('canvas', { rect: { x: 400, y: 100, width: 300, height: 200 } })])

  // A region whose child is ANOTHER transparent wrapper (the live shell nests them:
  // keyed/chain slots put another anchor under the anchor). The box must be found
  // through the boxless level, not reported as 0x0.
  const wrapper = makeEl('div', { rect: { x: 0, y: 0, width: 0, height: 0 } })
  append(wrapper, makeEl('div', { rect: { x: 640, y: 48, width: 400, height: 120 } }))
  const nestedRegion = anchor('conversation.header', [wrapper])

  // The conversation column and the sidebar, with their own anchors.
  const composerInput = makeEl('div', { attrs: { class: 'composer-input' }, rect: { x: 469, y: 451, width: 770, height: 52 } })
  const composer = anchor('conversation.composer', [composerInput])
  const mainPanel = makeEl('div', { rect: { x: 360, y: 0, width: 1080, height: 900 } })
  append(mainPanel, composer)
  const main = anchor('main', [mainPanel])

  const sidebarCol = makeEl('div', { rect: { x: 0, y: 0, width: 280, height: 900 } })
  for (const el of [tree, panellistA, panellistB, emptyRegion, shadowRegion, frameRegion]) append(sidebarCol, el)
  const sidebar = anchor('sidebar', [sidebarCol])
  const shell = makeEl('div', { rect: { x: 0, y: 0, width: 1440, height: 900 } })
  append(shell, main)
  append(shell, sidebar)
  append(shell, canvasRegion)
  append(shell, nestedRegion)
  const broken = failedAnchor('tool.view.demo')
  broken.rect = { x: 0, y: 0, width: 0, height: 0 }
  append(shell, broken)

  const root = anchor('root', [shell], { rect: { x: 0, y: 0, width: 0, height: 0 } })
  // The real documentElement is <html>; the shell's root anchor is a DESCENDANT of
  // it, which is why document.querySelectorAll('[data-slot]') finds it too.
  const html = makeEl('html', { rect: { x: 0, y: 0, width: 1440, height: 900 } })
  append(html, root)
  documentStub.documentElement = html
  return { root, shell, broken }
}

/** Fake MutationObserver: records its callback so the test can drive it by hand. */
const observers = []
function installObserverStub() {
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback
      this.observed = null
      observers.push(this)
    }
    observe(target, options) {
      this.observed = { target, options }
    }
    disconnect() {}
  }
}

function fireMutations(added, removed) {
  for (const observer of observers) observer.callback([{ addedNodes: added || [], removedNodes: removed || [] }])
}

function installBrowser() {
  globalThis.window = globalThis
  globalThis.document = documentStub
  globalThis.getComputedStyle = (el) => el.computed
}

let seq = 0
function loadClient() {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const tmp = path.join(os.tmpdir(), `region-probe-contract-${process.pid}-${seq++}.mjs`)
  fs.writeFileSync(tmp, `${src}\nexport default globalThis.__CAPTURED_REGION_PROBE__\n`)
  return import(pathToFileURL(tmp).href + `?n=${seq}`).then((mod) => {
    fs.unlinkSync(tmp)
    return mod.default
  })
}

function capture(plugin, injectImpl) {
  const registry = {
    registered: [],
    register(registration) {
      this.registered.push(registration)
      return () => {}
    },
  }
  const ctx = { inject: injectImpl ? injectImpl(registry) : undefined }
  plugin.apply(ctx)
  return registry
}

async function main() {
  console.log('=== region-probe client half: contract test ===')
  let engine = null
  try {
    engine = loadShippedEngine()
    console.log(`  engine: shipped schema engine loaded from ${PKGS}`)
  } catch (error) {
    skip('shipped schema validation', `extraction unavailable (${error.message})`)
  }

  const fixture = buildFixture()
  installObserverStub()
  installBrowser()
  globalThis.__CAPTURED_REGION_PROBE__ = null
  globalThis.window.__ModuleLoader__ = {
    load({ id, factory }) {
      globalThis.__CAPTURED_REGION_PROBE__ = { id, exported: factory() }
    },
  }

  const plugin = await loadClient()

  // --------------------------------------------------------------- A. manifest
  console.log('\n=== A. module identity and plugin shape ===')
  const captured = globalThis.__CAPTURED_REGION_PROBE__
  check('client.js calls __ModuleLoader__.load', !!captured, captured && captured.id)
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'))
  check('module id equals the package name', captured.id === pkg.name, `${captured.id} vs ${pkg.name}`)
  check('plugin declares an inject array', Array.isArray(captured.exported.inject), JSON.stringify(captured.exported.inject))
  check('the hard inject array is EMPTY (nothing this bundle needs)', captured.exported.inject.length === 0)
  check('cordisInspect is NOT in the hard inject array', !captured.exported.inject.includes('cordisInspect'))
  check('apply is a function', typeof captured.exported.apply === 'function')

  // -------------------------------------------------- B. registration behaviour
  console.log('\n=== B. optional injection ===')
  const neverCalls = capture(captured.exported, () => (keys, cb) => void keys && void cb)
  check('service absent (callback never runs): nothing registered, no throw', neverCalls.registered.length === 0)
  const emptyScope = capture(captured.exported, () => (keys, cb) => cb({}))
  check('scoped miss (callback without the service): nothing registered, no throw', emptyScope.registered.length === 0)
  const noInject = capture(captured.exported, () => undefined)
  check('ctx without inject(): no throw', noInject.registered.length === 0)

  let askedKeys = null
  const registry = { registered: [], register(registration) { this.registered.push(registration); return () => {} } }
  captured.exported.apply({
    inject(keys, cb) {
      askedKeys = keys
      cb({ cordisInspect: registry })
    },
  })
  check('inject asks for exactly cordisInspect', JSON.stringify(askedKeys) === '["cordisInspect"]', JSON.stringify(askedKeys))
  check('exactly one provider registered', registry.registered.length === 1, String(registry.registered.length))
  const registration = registry.registered[0]
  const manifest = registration.manifest
  check('manifest id is "Regions"', manifest.id === 'Regions', manifest.id)
  check('manifest description is non-empty (Host requires it)', typeof manifest.description === 'string' && manifest.description.trim() !== '')
  check(
    'three methods: outline + snapshot + failures',
    manifest.methods.length === 3 &&
      manifest.methods[0].name === 'outline' &&
      manifest.methods[1].name === 'snapshot' &&
      manifest.methods[2].name === 'failures',
    manifest.methods.map((m) => m.name).join(', '),
  )
  for (const method of manifest.methods) {
    check(`${method.name}: description is non-empty`, typeof method.description === 'string' && method.description.trim() !== '')
  }
  let schemaError = null
  try {
    if (engine) {
      for (const method of manifest.methods) {
        engine.assertSupportedJsonSchema(method.inputSchema)
        engine.assertSupportedJsonSchema(method.outputSchema)
      }
    }
  } catch (error) {
    schemaError = error
  }
  if (engine) check('both schemas pass the shipped subset checker', schemaError === null, schemaError && schemaError.message)
  else skip('both schemas pass the shipped subset checker', 'engine unavailable')

  check('unknown method is rejected loudly', (() => {
    try {
      registration.query('nope', {})
      return false
    } catch (error) {
      return /unknown Regions inspect method/.test(String(error && error.message))
    }
  })())

  // ------------------------------------------------------------------ C. outline
  console.log('\n=== C. outline(): what the shell actually rendered ===')
  const outline = registration.query('outline', {})
  const bySlot = new Map(outline.regions.map((r) => [r.slot, r]))
  check('every region present in the DOM is reported', outline.total === 12, `${outline.total} regions`)
  check('exactly one region is reported failed', outline.failed === 1, String(outline.failed))
  check('the failed region is flagged', bySlot.get('tool.view.demo') && bySlot.get('tool.view.demo').failed === true)
  check('a list slot rendered twice becomes ONE region with anchors=2', bySlot.get('sidebar.panellist').anchors === 2)
  check(
    'the multi-anchor region reports the union box',
    JSON.stringify([bySlot.get('sidebar.panellist').x, bySlot.get('sidebar.panellist').y, bySlot.get('sidebar.panellist').width, bySlot.get('sidebar.panellist').height]) ===
      JSON.stringify([12, 120, 256, 76]),
    JSON.stringify(bySlot.get('sidebar.panellist')),
  )
  check('a declared-but-unrendered region is reported empty', bySlot.get('conversation.input.left').empty === true)
  check('an occupied region is not empty', bySlot.get('sidebar.workspaces').empty === false)
  check(
    'the region box is the union of the anchor children (the anchor itself is 0x0)',
    bySlot.get('sidebar.workspaces').x === 18 &&
      bySlot.get('sidebar.workspaces').y === 269 &&
      bySlot.get('sidebar.workspaces').width === 256 &&
      bySlot.get('sidebar.workspaces').height === 120,
    JSON.stringify(bySlot.get('sidebar.workspaces')),
  )
  check('a text sample is included for occupied regions', /重构会话树/.test(bySlot.get('sidebar.workspaces').text), bySlot.get('sidebar.workspaces').text)
  check(
    'a box is found through a nested transparent wrapper (0x0 child, real grandchild)',
    bySlot.get('conversation.header').x === 640 &&
      bySlot.get('conversation.header').y === 48 &&
      bySlot.get('conversation.header').width === 400 &&
      bySlot.get('conversation.header').height === 120,
    JSON.stringify(bySlot.get('conversation.header')),
  )
  const boxed = outline.regions.filter((r) => r.width > 0 || r.height > 0)
  const unboxed = outline.regions.filter((r) => !(r.width > 0 || r.height > 0))
  check(
    'regions with a box are listed first, in screen order',
    outline.regions.slice(0, boxed.length).every((r) => r.width > 0 || r.height > 0) &&
      boxed.every((r, i) => i === 0 || boxed[i - 1].y <= r.y),
    boxed.map((r) => `${r.slot}@${r.y}`).join(' '),
  )
  check(
    'boxless regions are listed last',
    outline.regions.slice(boxed.length).every((r) => !(r.width > 0 || r.height > 0)),
    unboxed.map((r) => r.slot).join(' '),
  )
  check('root region is reported', !!bySlot.get('root'))

  // ----------------------------------------------------------------- D. snapshot
  console.log('\n=== D. snapshot(): reading one region ===')
  const treeSnap = registration.query('snapshot', { slot: 'sidebar.workspaces' })
  check('slot addressing works', treeSnap.available === true, treeSnap.reason)
  check('matched counts the anchors', treeSnap.matched === 1, String(treeSnap.matched))
  check('anchor + 4 rows + 3 label spans = 8 nodes at depth 2', treeSnap.nodes.length === 8, String(treeSnap.nodes.length))
  check(
    'node 0 is the region anchor and reports the region box, not its own 0x0',
    treeSnap.nodes[0].width === 256 && treeSnap.nodes[0].height === 120 && treeSnap.nodes[0].visible === true,
    JSON.stringify(treeSnap.nodes[0]),
  )
  check('node 0 records the owning slot key', treeSnap.nodes[0].slot === 'sidebar.workspaces', treeSnap.nodes[0].slot)
  check('children report their own geometry', treeSnap.nodes[1].x === 18 && treeSnap.nodes[1].y === 269, JSON.stringify(treeSnap.nodes[1]))
  check(
    'a row whose text sits in a child reports no own text (one level deeper carries it)',
    treeSnap.nodes[1].text === '' && treeSnap.nodes.some((n) => n.tag === 'span' && /重构会话树/.test(n.text)),
    JSON.stringify(treeSnap.nodes.slice(1, 3).map((n) => [n.tag, n.text])),
  )
  check(
    'a row with direct text reports it',
    treeSnap.nodes.some((n) => n.text === '直接文本行'),
    JSON.stringify(treeSnap.nodes.map((n) => n.text).filter(Boolean)),
  )

  const shallow = registration.query('snapshot', { slot: 'sidebar.workspaces', depth: 0 })
  check('depth 0 returns the anchor only', shallow.nodes.length === 1, String(shallow.nodes.length))
  const limited = registration.query('snapshot', { slot: 'sidebar.workspaces', limit: 2 })
  check('limit caps the node count', limited.nodes.length === 2, String(limited.nodes.length))
  const capped = registration.query('snapshot', { slot: 'sidebar.workspaces', limit: 100000 })
  check(
    'an oversized limit is clamped to the server-side maximum, not obeyed blindly',
    capped.nodes.length === treeSnap.nodes.length && capped.nodes.length <= 300,
    `${capped.nodes.length} nodes`,
  )

  const bySelector = registration.query('snapshot', { selector: '.rp-row' })
  check('selector addressing works', bySelector.available === true && bySelector.matched === 4, `${bySelector.matched}`)
  check('selector results carry geometry', bySelector.nodes[0].y === 269 && bySelector.nodes[0].height === 30, JSON.stringify(bySelector.nodes[0]))

  const shadowSnap = registration.query('snapshot', { slot: 'sidebar.right.pane', depth: 3 })
  check('shadow content is traversed and marked', shadowSnap.nodes.some((n) => n.path.includes('#shadow')), shadowSnap.nodes.map((n) => n.path).join(','))
  check('shadow text is readable', shadowSnap.nodes.some((n) => /shadow-text/.test(n.text)), JSON.stringify(shadowSnap.nodes.map((n) => n.text)))

  const frameSnap = registration.query('snapshot', { slot: 'sidebar.right.tab.document', depth: 3 })
  check('same-origin frame content is traversed and marked', frameSnap.nodes.some((n) => n.path.includes('#frame')), frameSnap.nodes.map((n) => n.path).join(','))

  const canvasSnap = registration.query('snapshot', { slot: 'conversation.view', depth: 2 })
  check('a canvas region is reported as its host element (no pretence of reading pixels)', canvasSnap.nodes.some((n) => n.tag === 'canvas'))

  console.log('\n=== E. honest failure reasons ===')
  const cases = [
    ['no arguments', {}, /pass exactly one of/],
    ['both arguments', { slot: 'main', selector: 'div' }, /pass exactly one of/],
    ['unknown slot', { slot: 'sidebar.nope' }, /no region is rendered/],
    ['slot that failed to render', { slot: 'tool.view.demo' }, /render-error/],
    ['selector matching nothing', { selector: '.definitely-not-here' }, /matched nothing/],
    ['invalid selector', { selector: 'div(' }, /invalid-selector/],
  ]
  for (const [name, input, pattern] of cases) {
    const answer = registration.query('snapshot', input)
    check(`${name}: available=false with a specific reason`, answer.available === false && pattern.test(answer.reason), answer.reason)
    check(`${name}: matched is 0 and nodes is empty`, answer.matched === 0 && answer.nodes.length === 0)
  }

  // -------------------------------------------------- F. failure history (ledger)
  console.log('\n=== F. failure history: crashed -> recovered -> crashed again ===')
  check('a MutationObserver was installed at apply time', observers.length === 1, `${observers.length} observer(s)`)
  check(
    'the observer watches the document for childList changes',
    !!observers[0] &&
      !!observers[0].observed &&
      observers[0].observed.options.childList === true &&
      observers[0].observed.options.subtree === true,
    JSON.stringify(observers[0] && observers[0].observed && observers[0].observed.options),
  )
  const startFailures = registration.query('failures', {})
  check(
    'the failure present when the plugin started is recorded',
    startFailures.total === 1 && startFailures.entries[0].slot === 'tool.view.demo',
    JSON.stringify(startFailures.entries),
  )
  check('it counts as active, not recovered', startFailures.entries[0].active === true && startFailures.entries[0].recovered === false)
  check('count starts at 1', startFailures.entries[0].count === 1, String(startFailures.entries[0].count))
  check('outline reports failedEver', outline.failedEver === 1, String(outline.failedEver))
  check('the failed region row carries failedBefore', bySlot.get('tool.view.demo').failedBefore === true)

  // The shell replaces the failed anchor with a working occupant.
  detach(fixture.broken)
  const recoveredAnchor = anchor('tool.view.demo', [makeEl('div', { rect: { x: 10, y: 446, width: 200, height: 24 } })])
  append(fixture.shell, recoveredAnchor)
  fireMutations([recoveredAnchor], [fixture.broken])
  const afterRecovery = registration.query('failures', {})
  check(
    'recovery flips active to false and marks it recovered',
    afterRecovery.entries[0].active === false && afterRecovery.entries[0].recovered === true,
    JSON.stringify(afterRecovery.entries[0]),
  )
  check('recovery does NOT erase the event', afterRecovery.total === 1 && afterRecovery.entries[0].count === 1, JSON.stringify(afterRecovery.entries[0]))
  const outlineAfterRecovery = registration.query('outline', {})
  const recoveredRow = outlineAfterRecovery.regions.find((r) => r.slot === 'tool.view.demo')
  check('the region renders normally again', !!recoveredRow && recoveredRow.failed === false, JSON.stringify(recoveredRow))
  check('...and still carries failedBefore', !!recoveredRow && recoveredRow.failedBefore === true)
  check(
    'currently-failed is 0 while failedEver stays 1 — the whole point',
    outlineAfterRecovery.failed === 0 && outlineAfterRecovery.failedEver === 1,
    `${outlineAfterRecovery.failed}/${outlineAfterRecovery.failedEver}`,
  )

  // The SAME slot fails a second time.
  detach(recoveredAnchor)
  const brokenAgain = failedAnchor('tool.view.demo')
  append(fixture.shell, brokenAgain)
  fireMutations([brokenAgain], [recoveredAnchor])
  const secondFailure = registration.query('failures', {})
  check('a second failure of the same slot increments count', secondFailure.entries[0].count === 2, JSON.stringify(secondFailure.entries[0]))
  check('and it is active again', secondFailure.entries[0].active === true && secondFailure.entries[0].recovered === false)
  check(
    'age timestamps are numbers, first >= last',
    typeof secondFailure.entries[0].firstSeenAgoMs === 'number' &&
      secondFailure.entries[0].firstSeenAgoMs >= secondFailure.entries[0].lastSeenAgoMs,
    JSON.stringify(secondFailure.entries[0]),
  )

  // A different slot is tracked separately, and sorts by newest activity.
  const otherBroken = failedAnchor('sidebar.workspaces')
  append(fixture.shell, otherBroken)
  fireMutations([otherBroken], [])
  const twoSlots = registration.query('failures', {})
  check('a second slot is tracked separately', twoSlots.total === 2 && twoSlots.active === 2, JSON.stringify(twoSlots.entries.map((e) => [e.slot, e.count])))
  check(
    'newest activity sorts first',
    // The contract is the ORDERING INVARIANT, not a fixed row order: ages are
    // relative to "now", so two entries can tie in the same millisecond and then
    // the slot key breaks the tie.
    twoSlots.entries[0].lastSeenAgoMs <= twoSlots.entries[1].lastSeenAgoMs,
    JSON.stringify(twoSlots.entries.map((e) => [e.slot, e.lastSeenAgoMs])),
  )
  detach(otherBroken)
  fireMutations([], [otherBroken])
  const recoveredOne = registration.query('failures', {})
  check(
    'it recovers too, while the other stays active',
    recoveredOne.total === 2 && recoveredOne.active === 1,
    JSON.stringify(recoveredOne.entries.map((e) => [e.slot, e.active])),
  )
  check(
    'an unrelated mutation does not touch the ledger',
    (() => {
      // Compare the STABLE fields as a SET: the age fields are relative to "now",
      // and row order legitimately follows them, so neither belongs in this check.
      const stable = () =>
        JSON.stringify(
          registration
            .query('failures', {})
            .entries.map((e) => [e.slot, e.count, e.active, e.recovered])
            .sort(),
        )
      const before = stable()
      fireMutations([makeEl('div', {})], [])
      return stable() === before
    })(),
  )

  // ------------------------------------------------------- G. schema conformance
  console.log('\n=== G. every answer judged by the shipped output validator ===')
  const finalOutline = registration.query('outline', {})
  const finalFailures = registration.query('failures', {})
  const answers = [
    ['outline', manifest.methods[0].outputSchema, finalOutline],
    ['snapshot slot', manifest.methods[1].outputSchema, registration.query('snapshot', { slot: 'sidebar.workspaces' })],
    ['snapshot selector', manifest.methods[1].outputSchema, bySelector],
    ['snapshot shadow', manifest.methods[1].outputSchema, shadowSnap],
    ['snapshot frame', manifest.methods[1].outputSchema, frameSnap],
    ['snapshot failure', manifest.methods[1].outputSchema, registration.query('snapshot', { slot: 'sidebar.nope' })],
    ['failures (with history)', manifest.methods[2].outputSchema, finalFailures],
    ['failures (empty page)', manifest.methods[2].outputSchema, { entries: [], total: 0, active: 0 }],
  ]
  if (engine) {
    for (const [name, schema, value] of answers) {
      const snap = engine.snapshotJsonValue(value)
      if (snap === undefined) {
        check(`${name}: answer is lossless JSON`, false, 'snapshotJsonValue returned undefined')
        continue
      }
      const violations = engine.validateJsonSchemaValue(schema, snap, 'output')
      check(`${name}: passes the shipped output validator`, violations.length === 0, violations.join('; '))
    }
    console.log('\n=== H. negative controls: the validator must reject tampering ===')
    const outlineSchema = manifest.methods[0].outputSchema
    const snapshotSchema = manifest.methods[1].outputSchema
    const failuresSchema = manifest.methods[2].outputSchema
    const tampered = JSON.parse(JSON.stringify(engine.snapshotJsonValue(finalOutline)))
    tampered.regions[0].unexpected = 1
    check('extra region field is rejected', engine.validateJsonSchemaValue(outlineSchema, tampered, 'output').length > 0)
    const missing = JSON.parse(JSON.stringify(engine.snapshotJsonValue(finalOutline)))
    delete missing.regions[0].failedBefore
    check('missing failedBefore is rejected', engine.validateJsonSchemaValue(outlineSchema, missing, 'output').length > 0)
    const missingEver = JSON.parse(JSON.stringify(engine.snapshotJsonValue(finalOutline)))
    delete missingEver.failedEver
    check('missing failedEver is rejected', engine.validateJsonSchemaValue(outlineSchema, missingEver, 'output').length > 0)
    const wrongType = JSON.parse(JSON.stringify(engine.snapshotJsonValue(finalOutline)))
    wrongType.failedEver = '1'
    check('wrong scalar type is rejected', engine.validateJsonSchemaValue(outlineSchema, wrongType, 'output').length > 0)
    const snapMissing = JSON.parse(JSON.stringify(engine.snapshotJsonValue(treeSnap)))
    delete snapMissing.nodes[0].visible
    check('missing node field is rejected', engine.validateJsonSchemaValue(snapshotSchema, snapMissing, 'output').length > 0)
    const ledgerTampered = JSON.parse(JSON.stringify(engine.snapshotJsonValue(finalFailures)))
    ledgerTampered.entries[0].note = 'why'
    check('extra ledger field is rejected', engine.validateJsonSchemaValue(failuresSchema, ledgerTampered, 'output').length > 0)
    const ledgerMissing = JSON.parse(JSON.stringify(engine.snapshotJsonValue(finalFailures)))
    delete ledgerMissing.entries[0].recovered
    check('missing recovered is rejected', engine.validateJsonSchemaValue(failuresSchema, ledgerMissing, 'output').length > 0)
  } else {
    skip('output validation and negative controls', 'engine unavailable')
  }

  console.log(
    `\n==================== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}${skips ? ` (${skips} skipped)` : ''} ====================`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('contract run crashed:', error)
  process.exit(1)
})
