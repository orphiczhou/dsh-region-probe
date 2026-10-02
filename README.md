# dsh-region-probe

A read-only [Cordis Inspect](https://github.com/orphiczhou/dsh-session-tree) provider for **DeepSeek Harness**: it tells an agent **which UI regions the running shell actually rendered — and what they rendered** — so a rendering bug can be found by the agent itself, in the real app, without a screenshot or a human looking at the screen.

No UI. No tools. No network. One provider, three read-only methods.

## Why this can work at all

The Harness shell renders **every** UI region as a slot anchor:

```html
<div data-slot="sidebar.workspaces">…what the occupant rendered…</div>
<div data-slot-error="tool.view.demo">…when that occupant failed to render…</div>
```

(The anchor itself is `display: contents` — it has no box; the occupant supplies the layout.)

So every region — the ones this DSH version ships, the ones a later version adds, and the ones third-party plugins contribute — carries a **stable slot key** in the DOM without that region needing to cooperate. This provider reads those anchors, which is why it needs **no list of regions, no per-region code, and no CSS class names** (the shell's own class names are CSS-module hashes like `BynINW_frame` and change with every build; slot keys do not).

## What an agent can ask

| Method | Answers |
|---|---|
| `outline()` | Every region present in the DOM right now: `slot`, `failed`, `failedBefore`, `empty`, `anchors`, `nodes`, on-screen box (`x,y,width,height`), a text sample. Plus `total`, `failed`, `failedEver`. |
| `snapshot({ slot \| selector, depth?, limit? })` | The rendered content of one region as a bounded node list: `path`, `tag`, `role`, `aria-label`, owning `slot`, own text, geometry, `visible`, `fontSize`, `color`, `background`. |
| `failures()` | **Failure history for this page**: which slots failed to render, how many separate times, and whether each is failing now or has recovered (`active` / `recovered` / `firstSeenAgoMs` / `lastSeenAgoMs`). |

Addressed by **slot key** (preferred) or by any CSS selector (fallback). `depth` defaults to 3 (anchor → surface → row → label), capped at 8; `limit` defaults to 60 nodes, capped at 300.

Reading through the agent's existing inspection tool:

```jsonc
// cordis_inspect_query({ platform: "client", provider: "Regions", method: "outline" })
{
  "total": 36, "failed": 0, "failedEver": 1,
  "regions": [
    { "slot": "sidebar",        "nodes": 137, "x": 0,   "y": 0, "width": 280,  "height": 900, … },
    { "slot": "main",           "nodes": 110, "x": 280, "y": 0, "width": 1160, "height": 900, … },
    { "slot": "sidebar.workspaces", "nodes": 49, "x": 12, "y": 204, "width": 268, "height": 640,
      "failed": false, "failedBefore": true, "empty": false,
      "text": "会话树 + ⋯ ▶ xiaomi-power-key-proj …" }
  ]
}
```

A slot that is a `list` can render the same key in more than one place (the sidebar panel list renders once expanded and once in the collapsed rail); those anchors are folded into **one** region with `anchors: 2` and the union box.

## Failure history

`outline()` can only see what is broken **right now**, so a region that rendered broken for a moment and then recovered leaves no trace — exactly the class of bug a single snapshot misses. The provider therefore keeps a bounded ledger (200 entries) for the life of the page:

- it starts with the plugin (`immediately: true`), so it sees the page from boot;
- a `MutationObserver` on `childList` re-syncs when a failed anchor appears or disappears, and every answer re-syncs as well, so the ledger is correct even where `MutationObserver` is unavailable;
- a slot that is no longer failing is marked `recovered: true` and **kept**;
- a slot that fails a second time gets `count: 2`.

The reason a region failed is not here — the shell only leaves an empty `data-slot-error` marker; the error itself goes to the page console.

## What it can and cannot see

- ✅ Every region that is in the DOM, including regions contributed by other plugins, plus regions added by future DSH versions — nothing needs to opt in.
- ✅ Shadow roots and same-origin frames are traversed; the node path says so (`#shadow`, `#frame`).
- ✅ Regions that are declared but rendered nothing (`empty: true`) and regions that failed (`failed: true`) are distinguished from regions that are missing — the provider never answers a silent empty list: "no region is rendered", "render-error", "selector matched nothing" and "invalid-selector" are different reasons.
- ❌ Content inside a **cross-origin iframe**, and anything painted into a **canvas**, cannot be read; the provider reports the host element and does not pretend otherwise.
- ⚠️ `data-slot` / `data-slot-error` are renderer implementation details, not a documented contract. If a future shell stops emitting them, `outline()` returns nothing — use `snapshot({ selector })` instead, which does not depend on them.
- ⚠️ Which page answered is not determined by this plugin: a Harness host broadcasts an inspect query to every connected page and takes the first valid answer, so in a multi-window setup the geometry you read describes the page that answered.

## Install

DSH installs plugins as **profile bundles**. Plain ESM, no build step, no dependencies.

**From the GUI:** Plugins page → **Add plugin** → paste `https://github.com/orphiczhou/dsh-region-probe`.

**From the CLI:**

```sh
dsh plugin add orphiczhou/dsh-region-probe
```

**From a local checkout:** add the directory as the spec in the same dialog.

The client half loads with the page. Install it and reload the Harness page once; from then on `cordis_inspect_list` shows the `Regions` provider on the `client` platform.

## Privacy and safety

This bundle gives an agent the ability to **read** the Harness UI: region names, visible text, computed colours and geometry. It does not click, write, or navigate; it touches no cookie, no `localStorage`, and makes no network request; every answer is bounded (nodes, depth, text length) and text is truncated. It exists for self-verification, so treat it as a development tool: disable it if you do not want a session to be able to read its own interface.

## Compatibility & version policy

This bundle declares **no `peerDependencies`**. That is deliberate: `peerDependencies` on `@deepseek-ai/dsh*` is the only compatibility field DSH enforces, so declaring none means the plugin does not hard-fail on a runtime upgrade. It talks to exactly one optional client service, `cordisInspect`, requested with an **optional** injection (`ctx.inject([...], cb)`) so that in a composition without the client runner the plugin simply does nothing instead of failing to load.

## Development

```sh
node test/contract.cjs        # 100+ assertions, no DSH install required
node scripts/verify-bundle.mjs
```

`test/contract.cjs` runs the real `client.js` against a miniature DOM that models exactly what the shell produces — `data-slot` anchors, a `data-slot-error` anchor, a 0×0 anchor whose content is in its children, a list slot rendered twice, a nested transparent wrapper, an empty region, a shadow host, a same-origin frame, a canvas — then drives a **crash → recovery → crash again** sequence through the ledger, and judges every answer with the shipped DSH schema engine when one is available locally (it skips that part rather than pretending to pass when it is not).

## License

MIT
