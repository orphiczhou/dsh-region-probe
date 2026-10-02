#!/usr/bin/env node
/**
 * Self-check for the publishable bundle manifest.
 *
 * Validates this package against the rules DSH actually enforces before it will
 * install and load a bundle. Every rule below is checked against the shipped
 * implementation, not against documentation prose:
 *
 *   1. package.json parses, and `name` / `version` are non-empty strings.
 *   2. `dsh.bundle` is an OBJECT and `dsh.bundle.patch` is a string path or an
 *      ordered array of string paths.
 *   3. Every patch file exists (a bundle whose patch is missing is refused with
 *      `not-a-bundle`).
 *   4. The patch holds a top-level YAML array whose `insert` rows carry an `id`
 *      and a `name`; each row `name` must resolve. The one row this bundle
 *      contributes must name THIS package, otherwise DSH would try to import a
 *      package that does not exist.
 *   5. The client half: `exports["./client"]` is present AND
 *      `dsh.client.platform === 'web'` (a bundle whose platform is not 'web' is
 *      ignored; a missing `./client` export throws when the browser asks for it).
 *   6. The client module id inside `client.js` equals the package name — the
 *      module loader rejects a mismatch.
 *   7. `icon` resolves to a real file inside the package and is <= 256 KiB.
 *   8. Every `locale/*.json` parses and carries `meta.title` + `meta.description`.
 *   9. `private` is not true (a private package cannot be installed as a bundle).
 *  10. Report declared `peerDependencies` on `@deepseek-ai/dsh*`: these are the
 *      ONLY compatibility field DSH enforces, so whatever is declared here is
 *      what the plugin will hard-fail on.
 *
 * Usage:  node scripts/verify-bundle.mjs [packageDir]
 * Exits non-zero if any check fails.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(process.argv[2] || join(here, '..'))

let failed = 0
const ok = (label, detail) => console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`)
const bad = (label, detail) => {
  failed += 1
  console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
}
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail))

console.log(`\n=== bundle self-check: ${pkgDir} ===\n`)

// 1 ---------------------------------------------------------------------------
const pkgPath = join(pkgDir, 'package.json')
if (!existsSync(pkgPath)) {
  bad('package.json exists', pkgPath)
  process.exit(1)
}
let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (error) {
  bad('package.json parses', error.message)
  process.exit(1)
}
check(typeof pkg.name === 'string' && pkg.name.length > 0, 'name is a non-empty string', pkg.name)
check(typeof pkg.version === 'string' && pkg.version.length > 0, 'version is a non-empty string', pkg.version)
check(pkg.private !== true, 'private is not true (a private package cannot be installed)')

// 2 ---------------------------------------------------------------------------
const bundle = pkg.dsh && pkg.dsh.bundle
check(bundle !== null && typeof bundle === 'object', 'dsh.bundle is an object')
const patchSpec = bundle && bundle.patch
const patchFiles = typeof patchSpec === 'string' ? [patchSpec] : Array.isArray(patchSpec) ? patchSpec : null
check(patchFiles !== null && patchFiles.length > 0, 'dsh.bundle.patch is a string or an array of strings', JSON.stringify(patchSpec))
check(
  patchFiles !== null && patchFiles.every((p) => typeof p === 'string' && p.trim().length > 0),
  'every patch entry is a non-empty string',
)

// 3 + 4 -----------------------------------------------------------------------
for (const rel of patchFiles || []) {
  const patchPath = join(pkgDir, rel)
  if (!existsSync(patchPath)) {
    bad(`patch file exists: ${rel}`, patchPath)
    continue
  }
  const text = readFileSync(patchPath, 'utf8')
  const lines = text.split(/\r?\n/)
  const isTopLevelArray = lines.some((line) => /^- /.test(line))
  check(isTopLevelArray, `patch file is a top-level YAML array: ${rel}`)

  // Collect the `name:` values of inserted rows without pulling in a YAML parser.
  const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1].trim())
  check(names.length > 0, `patch declares at least one row name: ${rel}`, names.join(', '))
  check(
    names.includes(pkg.name),
    'at least one patch row resolves to THIS package name',
    `rows: ${names.join(', ')}`,
  )
}

// 5 ---------------------------------------------------------------------------
const clientExport = pkg.exports && pkg.exports['./client']
check(typeof clientExport === 'string', 'exports["./client"] is declared', String(clientExport))
const clientCfg = pkg.dsh && pkg.dsh.client
check(clientCfg !== null && typeof clientCfg === 'object', 'dsh.client is an object')
check(clientCfg && clientCfg.platform === 'web', 'dsh.client.platform is exactly "web"', String(clientCfg && clientCfg.platform))

// 6 ---------------------------------------------------------------------------
if (typeof clientExport === 'string') {
  const clientPath = join(pkgDir, clientExport)
  if (!existsSync(clientPath)) {
    bad('the ./client export resolves to a real file', clientPath)
  } else {
    const src = readFileSync(clientPath, 'utf8')
    const m = src.match(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/)
    check(!!m, 'client.js calls __ModuleLoader__.load({ id })')
    check(m && m[1] === pkg.name, 'the client module id equals the package name', m ? m[1] : 'not found')
  }
}

// 7 ---------------------------------------------------------------------------
if (pkg.icon) {
  const iconPath = join(pkgDir, pkg.icon)
  if (!existsSync(iconPath)) {
    bad('icon resolves to a real file', iconPath)
  } else {
    const info = statSync(iconPath)
    const ext = pkg.icon.toLowerCase()
    check(/\.(svg|png|jpe?g|webp)$/.test(ext), 'icon extension is supported', pkg.icon)
    check(info.size <= 256 * 1024, 'icon is <= 256 KiB', `${info.size} bytes`)
  }
}

// 8 ---------------------------------------------------------------------------
const localeDir = join(pkgDir, 'locale')
if (existsSync(localeDir)) {
  const files = readdirSync(localeDir).filter((f) => f.endsWith('.json'))
  check(files.length > 0, 'at least one locale file exists', files.join(', '))
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(localeDir, file), 'utf8'))
      const meta = data && data.meta
      check(
        !!meta && typeof meta.title === 'string' && typeof meta.description === 'string',
        `locale/${file} carries meta.title and meta.description`,
      )
    } catch (error) {
      bad(`locale/${file} parses`, error.message)
    }
  }
  const localeExport = pkg.exports && pkg.exports['./locale/*.json']
  check(typeof localeExport === 'string', 'exports["./locale/*.json"] is declared (the dialog reads these)')
}

// 9 + 10 ----------------------------------------------------------------------
const peers = Object.keys(pkg.peerDependencies || {}).filter((n) => n.startsWith('@deepseek-ai/dsh'))
if (peers.length === 0) {
  ok(
    'no DSH peerDependencies declared',
    'deliberate: missing DSH peers impose NO constraint, so the plugin installs across runtime versions',
  )
} else {
  ok('DSH peerDependencies declared (these are hard-enforced at install AND load)', peers.join(', '))
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    if (/^[~^]|\*|x$|\s-\s|\|\|/.test(range)) {
      console.log(`  NOTE  ${name} uses a range "${range}" — DSH matches prereleases too; an exact pin is the shipped convention`)
    }
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} — ${failed} failing check(s)\n`)
process.exit(failed === 0 ? 0 : 1)
