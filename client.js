/**
 * Client half of the region-probe bundle.
 *
 * Registers ONE read-only Cordis Inspect provider, `Regions`, that answers from
 * the live DOM rather than from any registry:
 *
 *   outline()                                   -> which UI regions the shell actually rendered
 *   snapshot({ slot | selector, depth, limit })  -> the rendered content of one region
 *
 * Why the DOM is the right source: the shell's own slot renderer
 * (`dsh-client-ui-renderer`) renders every slot as
 *
 *     <div data-slot={slotKey}>        ...the occupant's output...
 *     <div data-slot-error={slotKey}>  ...when that occupant failed to render...
 *
 * so EVERY region — the ones the shell ships, the ones later DSH versions add,
 * and the ones third-party plugins contribute — carries a stable slot key in
 * the DOM without that region needing to cooperate. That is the difference
 * between this provider and a per-plugin one: it needs no list of regions, no
 * per-region code, and no class names (the shell's CSS-module class names, e.g.
 * `BynINW_frame`, change with every build; slot keys do not).
 *
 * What it deliberately cannot see: content inside a cross-origin iframe, and
 * anything painted into a canvas. It reports the host element for those and
 * never pretends to have read more. Shadow roots and same-origin frames ARE
 * traversed, and the node path says so (`#shadow`, `#frame`).
 *
 * Guarantees this provider keeps:
 *   - read-only: no clicks, no writes, no storage, no cookies, no network;
 *   - bounded: every answer is capped (nodes, depth, text length);
 *   - honest: "not found", "not rendered", "render failed" and "exception" are
 *     distinct `reason` values, never a silent empty list — a region that
 *     vanished must not look like a region that is simply empty.
 *
 * Every returned field is declared in the method's outputSchema and is always
 * present, because the Host rejects an answer with an undeclared field
 * (`additionalProperties: false`) exactly as it rejects a missing required one.
 */
window.__ModuleLoader__.load({
  id: '@orphiczhou/dsh-region-probe',
  factory() {
    const INSPECT_ID = 'Regions'
    const OUTLINE_METHOD = 'outline'
    const SNAPSHOT_METHOD = 'snapshot'
    const FAILURES_METHOD = 'failures'

    /** Answer bounds. The caller may lower them, never raise them past these. */
    const DEFAULT_NODES = 60
    const MAX_NODES = 300
    /**
     * Depth 3 is the useful default: the shell renders a region as
     * anchor -> surface -> row -> label, so depth 2 stops before the text a
     * reader is looking for (measured in the harness and in the live sidebar).
     */
    const DEFAULT_DEPTH = 3
    const MAX_DEPTH = 8
    const TEXT_LIMIT = 140
    const SLOT_ATTR = 'data-slot'
    const SLOT_ERROR_ATTR = 'data-slot-error'

    const REASON_OK = ''
    const REASON_ARGS = 'pass exactly one of `slot` or `selector`'
    const REASON_SELECTOR = 'invalid-selector: the browser rejected that CSS selector'
    const REASON_NO_MATCH = 'selector matched nothing in the live DOM'
    const REASON_NO_SLOT = 'no region is rendered for that slot key right now'
    const REASON_SLOT_FAILED = 'render-error: the shell rendered that slot as a failed slot'
    const REASON_NO_DOCUMENT = 'no document: this provider is answering outside a browser page'

    // ---------------------------------------------------------------- primitives

    function doc() {
      return typeof document === 'undefined' ? null : document
    }

    function text(value) {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return ''
      return String(value)
    }

    function clip(value) {
      const s = text(value).replace(/\s+/g, ' ').trim()
      return s.length > TEXT_LIMIT ? s.slice(0, TEXT_LIMIT - 1) + '\u2026' : s
    }

    function attr(el, name) {
      if (!el || typeof el.getAttribute !== 'function') return ''
      return text(el.getAttribute(name))
    }

    function bound(value, fallback, max) {
      const n = typeof value === 'number' && isFinite(value) ? Math.floor(value) : fallback
      if (n < 0) return 0
      return n > max ? max : n
    }

    /**
     * The box a slot ANCHOR occupies is 0x0 on purpose — the shell renders the
     * anchor with `display: contents` and lets the occupant lay itself out. The
     * region's real box is therefore the union of the boxes of the elements that
     * DO have a box underneath it, which is what a reader actually wants ("where
     * is this region on screen").
     *
     * The search is recursive and bounded because the transparency nests: a
     * keyed/chain slot's occupant is frequently another slot anchor, so a single
     * level of children finds only more 0x0 wrappers (measured live: `main`,
     * `rightbar` and `conversation.composer` were all reported boxless until this
     * walked through them).
     */
    const BOX_SEARCH_DEPTH = 4

    /** One element's own box; a slot anchor is 0x0 by construction. */
    function boxOf(el) {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    }

    function mergeRect(union, rect) {
      if (rect.width === 0 && rect.height === 0) return union
      if (!union) return { x1: rect.x, y1: rect.y, x2: rect.right, y2: rect.bottom }
      if (rect.x < union.x1) union.x1 = rect.x
      if (rect.y < union.y1) union.y1 = rect.y
      if (rect.right > union.x2) union.x2 = rect.right
      if (rect.bottom > union.y2) union.y2 = rect.bottom
      return union
    }

    /** Union of the boxes below `el`, walking through the boxless wrappers. */
    function unionBox(el, depthLeft) {
      let union = null
      for (const kid of elementChildren(el)) {
        const rect = kid.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) {
          union = mergeRect(union, rect)
        } else if (depthLeft > 0) {
          const inner = unionBox(kid, depthLeft - 1)
          if (inner) {
            union = mergeRect(union, {
              x: inner.x1,
              y: inner.y1,
              right: inner.x2,
              bottom: inner.y2,
              width: inner.x2 - inner.x1,
              height: inner.y2 - inner.y1,
            })
          }
        }
      }
      return union
    }

    function regionBox(el) {
      const union = unionBox(el, BOX_SEARCH_DEPTH)
      if (!union) return boxOf(el)
      return {
        x: Math.round(union.x1),
        y: Math.round(union.y1),
        width: Math.round(union.x2 - union.x1),
        height: Math.round(union.y2 - union.y1),
      }
    }

    /** Computed styles, guarded: a node can belong to another (same-origin) document. */
    function styleOf(el) {
      try {
        const cs = getComputedStyle(el)
        return { fontSize: text(cs.fontSize), color: text(cs.color), background: text(cs.backgroundColor) }
      } catch (error) {
        return { fontSize: '', color: '', background: '' }
      }
    }

    /** Direct text only: a row's own label, without duplicating its descendants. */
    function directText(el) {
      let out = ''
      const kids = el && el.childNodes ? el.childNodes : []
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i]
        if (node && node.nodeType === 3) out += ' ' + text(node.nodeValue)
      }
      return clip(out)
    }

    /** Children plus shadow-root children plus a readable same-origin frame root. */
    function elementChildren(el) {
      const out = []
      if (!el) return out
      const kids = el.children
      if (kids) for (let i = 0; i < kids.length; i++) out.push(kids[i])
      try {
        const shadow = el.shadowRoot
        if (shadow && shadow.children) for (let i = 0; i < shadow.children.length; i++) out.push(shadow.children[i])
      } catch (error) {}
      try {
        if (el.tagName === 'IFRAME') {
          const inner = el.contentDocument
          if (inner && inner.documentElement) out.push(inner.documentElement)
        }
      } catch (error) {}
      return out
    }

    /** The nearest slot key at or above this element, for context in a node row. */
    function ownerSlot(el) {
      let node = el
      let hops = 0
      while (node && hops < 40) {
        const key = attr(node, SLOT_ATTR)
        if (key) return key
        let next = node.parentElement
        if (!next && typeof node.getRootNode === 'function') {
          try {
            const root = node.getRootNode()
            if (root && root.host) next = root.host
          } catch (error) {}
        }
        node = next
        hops++
      }
      return ''
    }

    /** CSS attribute selector for an arbitrary key, quoted safely. */
    function slotSelector(attrName, key) {
      const escaped = String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return '[' + attrName + '="' + escaped + '"]'
    }

    function unavailable(reason) {
      return { available: false, reason: reason, matched: 0, nodes: [] }
    }

    // ------------------------------------------------------------------- outline

    /** Fold every anchor of one slot key into the single row a reader wants. */
    function regionRow(slot, anchors, failed) {
      let x1 = Infinity
      let y1 = Infinity
      let x2 = -Infinity
      let y2 = -Infinity
      let nodes = 0
      let sample = ''
      for (const el of anchors) {
        const b = regionBox(el)
        if (b.width > 0 || b.height > 0) {
          if (b.x < x1) x1 = b.x
          if (b.y < y1) y1 = b.y
          if (b.x + b.width > x2) x2 = b.x + b.width
          if (b.y + b.height > y2) y2 = b.y + b.height
        }
        nodes += el.querySelectorAll('*').length
        if (!sample && !failed) sample = clip(el.innerText)
      }
      const hasBox = isFinite(x1) && isFinite(y1) && isFinite(x2) && isFinite(y2)
      return {
        slot: slot,
        failed: failed,
        failedBefore: hasFailedBefore(slot),
        empty: !failed && nodes === 0,
        anchors: anchors.length,
        nodes: nodes,
        x: hasBox ? Math.round(x1) : 0,
        y: hasBox ? Math.round(y1) : 0,
        width: hasBox ? Math.round(x2 - x1) : 0,
        height: hasBox ? Math.round(y2 - y1) : 0,
        text: failed ? '' : sample,
      }
    }

    /**
     * Failure LEDGER.
     *
     * `outline()` alone can only see what is failing right now, so a region that
     * rendered broken for a moment and then recovered leaves no trace at all —
     * exactly the "it looked wrong once" class of bug that a single snapshot
     * misses. This keeps a bounded history per page: which slot failed, how many
     * separate times, and whether it is failing right now or has recovered.
     *
     * The watcher starts with the plugin (`immediately: true`), so it sees the
     * whole life of the page; every answer also re-syncs, so the ledger is
     * correct even where `MutationObserver` is unavailable.
     *
     * The reason a region failed is NOT here — the shell only leaves an empty
     * `data-slot-error` marker. The error itself goes to the page console.
     */
    const LEDGER_MAX = 200
    const ledger = new Map()
    let ledgerStarted = false
    let ledgerObserver = null

    function hasFailedBefore(slot) {
      const entry = slot ? ledger.get(slot) : undefined
      return !!entry && entry.count > 0
    }

    function syncFailureLedger() {
      const d = doc()
      if (!d) return
      const now = Date.now()
      const live = new Set()
      const nodes = d.querySelectorAll('[' + SLOT_ERROR_ATTR + ']')
      for (let i = 0; i < nodes.length; i++) {
        const slot = attr(nodes[i], SLOT_ERROR_ATTR)
        if (!slot) continue
        live.add(slot)
        const entry = ledger.get(slot)
        if (!entry) {
          ledger.set(slot, { count: 1, firstSeenAt: now, lastSeenAt: now, active: true })
        } else {
          if (!entry.active) entry.count += 1
          entry.active = true
          entry.lastSeenAt = now
        }
      }
      // A slot that is no longer failing has RECOVERED; keep it, that is the point.
      for (const [slot, entry] of ledger) {
        if (entry.active && !live.has(slot)) entry.active = false
      }
      while (ledger.size > LEDGER_MAX) {
        let oldestSlot = null
        let oldestAt = Infinity
        for (const [slot, entry] of ledger) {
          if (entry.lastSeenAt < oldestAt) {
            oldestAt = entry.lastSeenAt
            oldestSlot = slot
          }
        }
        if (oldestSlot === null) break
        ledger.delete(oldestSlot)
      }
    }

    /** Does a mutated node itself carry, or contain, a failed-region marker? */
    function mentionsFailure(node) {
      if (!node) return false
      if (attr(node, SLOT_ERROR_ATTR) !== '') return true
      if (typeof node.querySelectorAll === 'function') {
        try {
          return node.querySelectorAll('[' + SLOT_ERROR_ATTR + ']').length > 0
        } catch (error) {
          return true
        }
      }
      return false
    }

    function recordTouchesFailure(record) {
      const lists = [record && record.addedNodes, record && record.removedNodes]
      for (const list of lists) {
        if (!list) continue
        for (let i = 0; i < list.length; i++) if (mentionsFailure(list[i])) return true
      }
      return false
    }

    /** Start the history once per page. Idempotent. */
    function watchFailures() {
      if (ledgerStarted) return
      ledgerStarted = true
      syncFailureLedger()
      const d = doc()
      if (!d || typeof MutationObserver !== 'function' || !d.documentElement) return
      try {
        ledgerObserver = new MutationObserver((records) => {
          for (let i = 0; i < records.length; i++) {
            if (recordTouchesFailure(records[i])) {
              syncFailureLedger()
              return
            }
          }
        })
        ledgerObserver.observe(d.documentElement, { childList: true, subtree: true })
      } catch (error) {
        ledgerObserver = null
      }
    }

    /** The history, newest activity first. */
    function failures() {
      syncFailureLedger()
      const now = Date.now()
      const entries = []
      for (const [slot, entry] of ledger) {
        entries.push({
          slot: slot,
          count: entry.count,
          active: entry.active,
          recovered: !entry.active,
          firstSeenAgoMs: Math.max(0, Math.round(now - entry.firstSeenAt)),
          lastSeenAgoMs: Math.max(0, Math.round(now - entry.lastSeenAt)),
        })
      }
      entries.sort((a, b) => a.lastSeenAgoMs - b.lastSeenAgoMs || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))
      let active = 0
      for (const entry of entries) if (entry.active) active++
      return { entries: entries, total: entries.length, active: active }
    }

    /**
     * Every region the shell has in the DOM right now, grouped by slot key.
     * A list slot can render the same key in more than one place (the sidebar
     * panel list renders once expanded and once in the collapsed rail), so
     * `anchors` says how many anchors back that row.
     */
    function outline() {
      const d = doc()
      if (!d) return { regions: [], total: 0, failed: 0, failedEver: 0, reason: REASON_NO_DOCUMENT }
      syncFailureLedger()
      const byKey = new Map()
      const normal = d.querySelectorAll('[' + SLOT_ATTR + ']')
      for (let i = 0; i < normal.length; i++) {
        const key = attr(normal[i], SLOT_ATTR)
        if (!key) continue
        if (!byKey.has(key)) byKey.set(key, { slot: key, failed: false, anchors: [] })
        byKey.get(key).anchors.push(normal[i])
      }
      const broken = d.querySelectorAll('[' + SLOT_ERROR_ATTR + ']')
      for (let i = 0; i < broken.length; i++) {
        const key = attr(broken[i], SLOT_ERROR_ATTR)
        if (!key) continue
        const id = '!' + key
        if (!byKey.has(id)) byKey.set(id, { slot: key, failed: true, anchors: [] })
        byKey.get(id).anchors.push(broken[i])
      }
      const regions = []
      for (const group of byKey.values()) regions.push(regionRow(group.slot, group.anchors, group.failed))
      // Regions that occupy space first, in screen order; regions with no box
      // (nothing rendered, or rendered off-layout) last, so a reader sees what is
      // actually on screen before the empty declarations.
      const boxless = (r) => (r.width > 0 || r.height > 0 ? 0 : 1)
      regions.sort(
        (a, b) =>
          boxless(a) - boxless(b) ||
          a.y - b.y ||
          a.x - b.x ||
          (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0),
      )
      let failed = 0
      for (const r of regions) if (r.failed) failed++
      return { regions: regions, total: regions.length, failed: failed, failedEver: ledger.size, reason: REASON_OK }
    }

    // ------------------------------------------------------------------ snapshot

    /**
     * One node row.
     *
     * A slot ANCHOR reports the region box (the union of its children) instead of
     * its own 0x0 box, so a snapshot and an outline describe the same region the
     * same way; every other node reports its own box. `text` is the element's OWN
     * text: a row's label normally lives in a child element, so a row node is
     * often text-free while the element one level down carries the label.
     */
    function nodeRow(el, path) {
      const cs = styleOf(el)
      const isAnchor = attr(el, SLOT_ATTR) !== ''
      const box = isAnchor ? regionBox(el) : boxOf(el)
      return {
        path: path,
        tag: text(el.tagName).toLowerCase(),
        role: attr(el, 'role'),
        label: attr(el, 'aria-label'),
        slot: isAnchor ? attr(el, SLOT_ATTR) : ownerSlot(el),
        text: directText(el),
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        visible: box.width > 0 && box.height > 0,
        fontSize: cs.fontSize,
        color: cs.color,
        background: cs.background,
      }
    }

    function walk(el, path, level, maxDepth, out, limit) {
      if (out.length >= limit) return
      out.push(nodeRow(el, path))
      if (level >= maxDepth) return
      const kids = el.children || []
      for (let i = 0; i < kids.length && out.length < limit; i++) {
        walk(kids[i], path + '.' + i, level + 1, maxDepth, out, limit)
      }
      try {
        const shadow = el.shadowRoot
        if (shadow && shadow.children) {
          for (let i = 0; i < shadow.children.length && out.length < limit; i++) {
            walk(shadow.children[i], path + '#shadow.' + i, level + 1, maxDepth, out, limit)
          }
        }
      } catch (error) {}
      try {
        if (el.tagName === 'IFRAME') {
          const inner = el.contentDocument
          if (inner && inner.documentElement) {
            walk(inner.documentElement, path + '#frame.0', level + 1, maxDepth, out, limit)
          }
        }
      } catch (error) {}
    }

    function snapshot(input) {
      const d = doc()
      if (!d) return unavailable(REASON_NO_DOCUMENT)
      const args = input && typeof input === 'object' ? input : {}
      const slot = typeof args.slot === 'string' ? args.slot.trim() : ''
      const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
      if ((slot && selector) || (!slot && !selector)) return unavailable(REASON_ARGS)
      const depth = bound(args.depth, DEFAULT_DEPTH, MAX_DEPTH)
      const limit = bound(args.limit, DEFAULT_NODES, MAX_NODES)

      let targets = null
      if (slot) {
        const rendered = d.querySelectorAll(slotSelector(SLOT_ATTR, slot))
        if (rendered.length === 0) {
          const failedRegion = d.querySelectorAll(slotSelector(SLOT_ERROR_ATTR, slot))
          if (failedRegion.length > 0) return unavailable(REASON_SLOT_FAILED + ': ' + slot)
          return unavailable(REASON_NO_SLOT + ': ' + slot)
        }
        targets = rendered
      } else {
        try {
          targets = d.querySelectorAll(selector)
        } catch (error) {
          return unavailable(REASON_SELECTOR)
        }
        if (targets.length === 0) return unavailable(REASON_NO_MATCH + ': ' + selector)
      }

      const nodes = []
      for (let i = 0; i < targets.length && nodes.length < limit; i++) {
        walk(targets[i], String(i), 0, depth, nodes, limit)
      }
      return { available: true, reason: REASON_OK, matched: targets.length, nodes: nodes }
    }

    // ------------------------------------------------------------------- provider

    /** Declared once: the Host validates both schemas when the manifest is published. */
    const MANIFEST = {
      id: INSPECT_ID,
      description: 'Which UI regions the running shell actually rendered, read from the live DOM.',
      methods: [
        {
          name: OUTLINE_METHOD,
          description:
            'Every region present in the DOM right now, grouped by slot key, with occupancy, current failure state, past failure state and on-screen box.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: {
              regions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    slot: { type: 'string' },
                    failed: { type: 'boolean' },
                    failedBefore: { type: 'boolean' },
                    empty: { type: 'boolean' },
                    anchors: { type: 'number' },
                    nodes: { type: 'number' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    text: { type: 'string' },
                  },
                  required: [
                    'slot',
                    'failed',
                    'failedBefore',
                    'empty',
                    'anchors',
                    'nodes',
                    'x',
                    'y',
                    'width',
                    'height',
                    'text',
                  ],
                  additionalProperties: false,
                },
              },
              total: { type: 'number' },
              failed: { type: 'number' },
              failedEver: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['regions', 'total', 'failed', 'failedEver', 'reason'],
            additionalProperties: false,
          },
        },
        {
          name: SNAPSHOT_METHOD,
          description:
            'The rendered content of one region, addressed by slot key (preferred) or by a CSS selector, as a bounded node list.',
          inputSchema: {
            type: 'object',
            properties: {
              slot: { type: 'string' },
              selector: { type: 'string' },
              depth: { type: 'number' },
              limit: { type: 'number' },
            },
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: {
              available: { type: 'boolean' },
              reason: { type: 'string' },
              matched: { type: 'number' },
              nodes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    tag: { type: 'string' },
                    role: { type: 'string' },
                    label: { type: 'string' },
                    slot: { type: 'string' },
                    text: { type: 'string' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    visible: { type: 'boolean' },
                    fontSize: { type: 'string' },
                    color: { type: 'string' },
                    background: { type: 'string' },
                  },
                  required: [
                    'path',
                    'tag',
                    'role',
                    'label',
                    'slot',
                    'text',
                    'x',
                    'y',
                    'width',
                    'height',
                    'visible',
                    'fontSize',
                    'color',
                    'background',
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ['available', 'reason', 'matched', 'nodes'],
            additionalProperties: false,
          },
        },
        {
          name: FAILURES_METHOD,
          description:
            'Failure history for this page: which slots failed to render, how many separate times, and whether each is failing now or has recovered.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: {
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    slot: { type: 'string' },
                    count: { type: 'number' },
                    active: { type: 'boolean' },
                    recovered: { type: 'boolean' },
                    firstSeenAgoMs: { type: 'number' },
                    lastSeenAgoMs: { type: 'number' },
                  },
                  required: ['slot', 'count', 'active', 'recovered', 'firstSeenAgoMs', 'lastSeenAgoMs'],
                  additionalProperties: false,
                },
              },
              total: { type: 'number' },
              active: { type: 'number' },
            },
            required: ['entries', 'total', 'active'],
            additionalProperties: false,
          },
        },
      ],
    }

    /**
     * Publish the provider through an OPTIONAL injection.
     *
     * `cordisInspect` exists only where the client runner is part of the
     * composition, so it must never join the plugin's hard `inject` list: one
     * missing service there stops the whole plugin from loading. With
     * `ctx.inject([...], cb)` the callback simply never runs where the service is
     * absent, and this bundle stays a no-op instead of a load failure.
     */
    function registerInspectProvider(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return
      try {
        ctx.inject(['cordisInspect'], (scoped) => {
          const inspect =
            (scoped && scoped.cordisInspect) ||
            (typeof ctx.get === 'function' ? ctx.get('cordisInspect') : undefined)
          if (!inspect || typeof inspect.register !== 'function') return
          return inspect.register({
            manifest: MANIFEST,
            query(method, input) {
              if (method === OUTLINE_METHOD) return outline()
              if (method === SNAPSHOT_METHOD) return snapshot(input)
              if (method === FAILURES_METHOD) return failures()
              throw new Error('unknown ' + INSPECT_ID + ' inspect method "' + method + '"')
            },
          })
        })
      } catch (error) {
        try {
          console.error('[region-probe] inspect provider registration failed', error)
        } catch (ignored) {}
      }
    }

    return {
      // This bundle needs no service at all: it renders nothing and reads only
      // the DOM. `cordisInspect` is requested optionally inside `apply`.
      inject: [],
      apply(ctx) {
        // Start the failure history as early as possible: this bundle is declared
        // `immediately: true`, so the ledger sees the whole life of the page.
        watchFailures()
        registerInspectProvider(ctx)
      },
    }
  },
})
