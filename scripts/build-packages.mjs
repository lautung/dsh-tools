// dsh-tools: 把 plugins/cc-*/ 的动态 Cordis 源码转成可持久安装的 npm 包插件。
// 用法: node scripts/build-packages.mjs
// 策略: harness.* 调用通过本地垫片桥接到包插件 API（ctx.tools.register / defineTool），
//       cc-market 的 cm.* RPC 经 ctx.webServer HTTP 路由暴露，client 的 host.call 改为 fetch。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = join(ROOT, 'plugins')

function stripReturn(src) {
  return src.replace(/^return\s+/, '').replace(/\s*$/, '\n')
}

/** 把 host.js 转成 lib/index.js（命名导出 name/inject/apply + harness 垫片）。 */
function buildHost(pluginDir, outFile, { shim, injectExtra, wrapApply = false }) {
  let body = stripReturn(readFileSync(join(PLUGINS, pluginDir, 'host.js'), 'utf8'))
  const imports = shim.includes('defineTool') ? "import { defineTool } from '@deepseek-ai/dsh-tools'\n" : ''
  const extra = JSON.stringify(injectExtra).slice(1, -1)
  const applyExport = wrapApply
    ? ''
    : 'export const apply = definition.apply\n'
  const out =
    imports +
    '// dsh-tools package build (auto-generated from plugins/' + pluginDir + '/host.js by scripts/build-packages.mjs)\n' +
    shim +
    '\nconst definition = ' + body + '\n' +
    'export const name = definition.name\n' +
    'export const inject = [...(definition.inject || []), ' + extra + ']\n' +
    applyExport +
    (wrapApply ? WRAP_APPLY : '')
  writeFileSync(outFile, out)
}

const HARNESS_FULL = `const harnessHandlers = {}
const harness = {
  registerTool: (ctx, tool) => ctx.tools.register(tool),
  defineTool: (d) => defineTool(d),
  handle: (method, handler) => { harnessHandlers[method] = handler; return () => {} },
}
`
const HARNESS_HANDLE = `const harnessHandlers = {}
const harness = {
  handle: (method, handler) => { harnessHandlers[method] = handler; return () => {} },
}
`

const WRAP_APPLY = `
// ---- RPC over HTTP (package-plugin replacement for host.call) ----
const CC_MARKET_API = '/api/cc-market'
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) return undefined
    chunks.push(chunk)
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
  } catch {
    return undefined
  }
}
const baseApply = definition.apply
export const apply = function (ctx) {
  const disposers = []
  const ret = baseApply(ctx)
  const mount = () => {
    for (const method of Object.keys(harnessHandlers)) {
      const action = method.replace(/^cm\\./, '')
      try {
        const dispose = ctx.webServer.register({
          kind: 'exact',
          path: CC_MARKET_API + '/' + action,
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const r = await harnessHandlers[method](body || {})
              writeJson(res, 200, r)
            } catch (e) {
              writeJson(res, 200, { ok: false, output: (e && e.message) || String(e) })
            }
          },
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (e) {
        // route already registered — ignore
      }
    }
  }
  if (ret && typeof ret.then === 'function') return ret.then(mount)
  mount()
  return ret
}
`

// ---- dsh-cc-bridge (host-only) ----
mkdirSync(join(ROOT, 'packages/dsh-cc-bridge/lib'), { recursive: true })
buildHost('cc-bridge', join(ROOT, 'packages/dsh-cc-bridge/lib/index.js'), {
  shim: HARNESS_FULL,
  injectExtra: ['tools'],
})

// ---- dsh-cc-file-installer (host-only) ----
mkdirSync(join(ROOT, 'packages/dsh-cc-file-installer/lib'), { recursive: true })
buildHost('cc-file-installer', join(ROOT, 'packages/dsh-cc-file-installer/lib/index.js'), {
  shim: HARNESS_FULL,
  injectExtra: ['tools'],
})

// ---- dsh-cc-market (host + client) ----
mkdirSync(join(ROOT, 'packages/dsh-cc-market/lib'), { recursive: true })
buildHost('cc-market', join(ROOT, 'packages/dsh-cc-market/lib/index.js'), {
  shim: HARNESS_HANDLE,
  injectExtra: ['webServer'],
  wrapApply: true,
})

buildClient(join(ROOT, 'packages/dsh-cc-market/lib/client.js'))

function buildClient(outFile) {
  const src = readFileSync(join(PLUGINS, 'cc-market', 'client.js'), 'utf8')
  let body = stripReturn(src)
  // 包客户端里没有裸全局: React 从模块表 require, styles 换成本地 helper, host.call 改为 fetch
  body = body
    .replace('styles.insert(', 'insertCss(')
    .replace("const slots = ctx.get('slots')", "const slots = ctx.slots || ctx.get('slots')")
    .replaceAll('host.call(', 'apiCall(')
  const out = `// dsh-tools package build (auto-generated from plugins/cc-market/client.js by scripts/build-packages.mjs)
window.__ModuleLoader__.load({
  id: 'dsh-cc-market',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const CC_MARKET_API = '/api/cc-market'
    let cssInserted = false
    function insertCss(css) {
      if (cssInserted || typeof document === 'undefined') return
      cssInserted = true
      const el = document.createElement('style')
      el.textContent = css
      document.head.appendChild(el)
    }
    async function apiCall(method, args) {
      const res = await fetch(CC_MARKET_API + '/' + String(method).replace(/^cm\\./, ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const definition = ${body}
    exports.name = definition.name
    exports.inject = ['slots']
    exports.apply = definition.apply
    return module.exports
  },
})
`
  writeFileSync(outFile, out)
}

console.log('packages built:', join(ROOT, 'packages'))
