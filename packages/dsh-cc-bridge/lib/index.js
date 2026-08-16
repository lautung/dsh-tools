import { defineTool } from '@deepseek-ai/dsh-tools'
// dsh-tools package build (auto-generated from plugins/cc-bridge/host.js by scripts/build-packages.mjs)
const harnessHandlers = {}
const harness = {
  registerTool: (ctx, tool) => ctx.tools.register(tool),
  defineTool: (d) => defineTool(d),
  handle: (method, handler) => { harnessHandlers[method] = handler; return () => {} },
}

const definition = {
  name: 'claude-code-bridge',
  inject: ['subprocess', 'sandboxPolicy', 'timer', 'skills'],
  async apply(ctx) {
    const DEFAULT_TIMEOUT = 180000
    const renderText = (args, v) => [{ type: 'text', text: v }]
    const decoder = new TextDecoder()

    // ---------- shared exec helpers ----------
    function textOf(reader) {
      if (!reader) return ''
      const r = reader.readFrom(0)
      return r && r.text ? r.text : ''
    }
    function limit(s, n) {
      if (!s) return s
      return s.length > n ? s.slice(0, n) + '\n…[truncated ' + (s.length - n) + ' chars]' : s
    }
    function kebab(s) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    }
    async function resolveClaude() {
      try {
        return await ctx.subprocess.resolveExecutable('claude')
      } catch (e) {
        return undefined
      }
    }
    async function cliBin() {
      const bin = await resolveClaude()
      return bin || ''
    }

    async function spawnCli(argv, opts) {
      opts = opts || {}
      const env = {}
      if (opts.apiKey) env.ANTHROPIC_API_KEY = String(opts.apiKey)
      if (opts.baseUrl) env.ANTHROPIC_BASE_URL = String(opts.baseUrl)
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: opts.cwd || ctx.sandboxPolicy.workspaceRoot,
          stdio: {
            stdin: opts.stdinData !== undefined ? { data: opts.stdinData } : { data: '' },
            stdout: { maxBytes: opts.stdoutMax || 200 * 1024, spill: { maxBytes: 2 * 1024 * 1024 } },
            stderr: { maxBytes: opts.stderrMax || 64 * 1024 },
          },
          graceMs: 1500,
          env: Object.keys(env).length ? env : undefined,
        })
      } catch (e) {
        return { ok: false, error: 'spawn failed: ' + (e && e.message ? e.message : String(e)) }
      }
      const timeoutMs = opts.timeoutMs || 120000
      let timedOut = false
      const disc = ctx.timeout(() => { timedOut = true; handle.terminate() }, Math.min(timeoutMs, 2147483647))
      let outcome
      try {
        outcome = await handle.done
      } catch (e) {
        disc()
        return { ok: false, error: (e && e.message) ? e.message : String(e) }
      }
      disc()
      return {
        ok: true, exitCode: outcome.exitCode, signal: outcome.signal, timedOut,
        stdout: textOf(handle.collected.stdout), stderr: textOf(handle.collected.stderr),
      }
    }

    async function shOut(argv, opts) {
      const r = await spawnCli(argv, Object.assign({ stdoutMax: 64 * 1024, stderrMax: 16 * 1024, timeoutMs: 30000 }, opts))
      return r.ok ? r.stdout.trim() : ''
    }
    let homeCache
    async function homeDir() {
      if (homeCache !== undefined) return homeCache
      homeCache = await shOut(['/bin/sh', '-c', 'printf %s "$HOME"'])
      if (!homeCache) homeCache = ctx.sandboxPolicy.workspaceRoot
      return homeCache
    }
    async function pluginsDir() {
      return (await homeDir()) + '/.dsh/ccbridge/plugins'
    }
    async function readFile(p) {
      const r = await spawnCli(['/bin/cat', p], { stdoutMax: 1024 * 1024, stderrMax: 8192, timeoutMs: 20000 })
      return r.ok ? r.stdout : ''
    }
    async function parseJson(p) {
      try {
        return JSON.parse((await readFile(p)) || 'null')
      } catch (e) {
        return null
      }
    }
    async function existsPath(p) {
      const r = await spawnCli(['/bin/ls', '-d', p], { stdoutMax: 4096, stderrMax: 1024, timeoutMs: 5000 })
      return r.ok && r.exitCode === 0
    }
    async function listDir(p) {
      const r = await spawnCli(['/bin/ls', '-1', p], { stdoutMax: 64 * 1024, stderrMax: 4096, timeoutMs: 10000 })
      return r.ok ? r.stdout.split('\n').map(function (s) { return s.trim() }).filter(Boolean) : []
    }
    async function knownMarketplaces() {
      return (await parseJson((await pluginsDir()) + '/known_marketplaces.json')) || {}
    }
    async function runCliForward(argv, timeoutMs) {
      const bin = await cliBin()
      if (!bin) return { ok: false, error: 'claude CLI not found on PATH — install it with: npm install -g @anthropic-ai/claude-code' }
      return spawnCli([bin].concat(argv), { timeoutMs: timeoutMs || 120000 })
    }
    function cliResult(r) {
      if (!r.ok) return 'FAILED — ' + r.error
      const head = 'exit ' + r.exitCode + (r.signal ? ' (signal ' + r.signal + ')' : '') + (r.timedOut ? ' [TIMEOUT]' : '')
      const parts = []
      if (r.stdout && r.stdout.trim()) parts.push(r.stdout.trim())
      if (r.stderr && r.stderr.trim()) parts.push('--- stderr ---\n' + r.stderr.trim())
      return parts.length ? parts.join('\n') + '\n[' + head + ']' : head
    }

    async function queryVersion(bin) {
      const r = await spawnCli([bin, '--version'], { stdoutMax: 8192, stderrMax: 4096, timeoutMs: 20000 })
      const out = r.ok ? r.stdout.trim() : ''
      if (out) return out
      return r.ok ? r.stderr.trim() : ''
    }
    async function apiKeyState() {
      try {
        const h2 = ctx.subprocess.spawn({
          argv: ['/bin/sh', '-c', 'if [ -n "$ANTHROPIC_API_KEY" ]; then echo set; else echo unset; fi'],
          cwd: ctx.sandboxPolicy.workspaceRoot,
          stdio: { stdin: { data: '' }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
          graceMs: 1000,
        })
        await h2.done
        return (textOf(h2.collected.stdout) || '').trim() === 'set'
      } catch (e) {
        return false
      }
    }

    // ---------- claude -p runner ----------
    async function runClaude(opts) {
      const bin = await cliBin()
      if (!bin) return { ok: false, error: 'claude CLI not found on PATH — install it with: npm install -g @anthropic-ai/claude-code' }
      const prompt = opts.prompt == null ? '' : String(opts.prompt)
      if (!prompt.trim()) return { ok: false, error: 'prompt must not be empty' }
      const argv = [bin, '-p', prompt, '--output-format', opts.outputFormat || 'text']
      if (opts.model) argv.push('--model', String(opts.model))
      if (opts.permissionMode) argv.push('--permission-mode', String(opts.permissionMode))
      for (const flag of opts.extraArgs || []) argv.push(String(flag))
      const r = await spawnCli(argv, {
        cwd: opts.cwd, timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT,
        apiKey: opts.apiKey, baseUrl: opts.baseUrl,
      })
      if (!r.ok) return r
      return {
        ok: true, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut,
        stdout: limit(r.stdout || '', 16000), stderr: limit(r.stderr || '', 4000),
      }
    }
    const summarizeRun = (r) => {
      if (!r.ok) return 'Claude Code: FAILED — ' + r.error
      const head = 'Claude Code — exit ' + r.exitCode + (r.signal ? ' (signal ' + r.signal + ')' : '') + (r.timedOut ? ' [TIMEOUT]' : '')
      const parts = [head]
      if (r.stdout) parts.push('--- stdout ---\n' + r.stdout)
      if (r.stderr) parts.push('--- stderr ---\n' + r.stderr)
      return parts.join('\n')
    }

    // ---------- marketplace discovery (DSH-owned) ----------
    async function searchPlugins(query, marketplaceName) {
      const known = await knownMarketplaces()
      const q = String(query || '').toLowerCase().trim()
      const out = []
      const names = Object.keys(known)
      for (let i = 0; i < names.length; i++) {
        const mName = names[i]
        if (marketplaceName && mName !== marketplaceName) continue
        const mk = known[mName] || {}
        const mp = await parseJson(mk.installLocation + '/.claude-plugin/marketplace.json')
        const list = mp && Array.isArray(mp.plugins) ? mp.plugins : []
        for (let j = 0; j < list.length; j++) {
          const p = list[j] || {}
          const id = p.name + '@' + mName
          const hay = String(p.name + ' ' + (p.description || '') + ' ' + (p.category || '') + ' ' + ((p.author && p.author.name) || '')).toLowerCase()
          if (q && hay.indexOf(q) === -1) continue
          out.push({
            id, name: p.name, marketplace: mName,
            description: p.description || '',
            category: p.category || '',
            author: (p.author && p.author.name) || '',
            homepage: p.homepage || '',
            sourceKind: typeof p.source === 'string' ? 'local' : (p.source ? (p.source.source || 'git') : ''),
          })
        }
      }
      return out
    }
    function fmtPlugin(p) {
      let s = p.id
      if (p.description) s += '\n  ' + p.description
      const meta = []
      if (p.category) meta.push('category: ' + p.category)
      if (p.author) meta.push('author: ' + p.author)
      if (p.sourceKind) meta.push('source: ' + p.sourceKind)
      if (meta.length) s += '\n  ' + meta.join(' | ')
      if (p.homepage) s += '\n  ' + p.homepage
      return s
    }

    // ---------- skill file helpers (kept; bridge registration disabled) ----------
    async function resolveSkillFile(dir) {
      if (String(dir).slice(-3) === '.md') {
        if (await existsPath(dir)) {
          return { file: dir, baseDir: String(dir).replace(/\/[^/]+$/, '') }
        }
        return null
      }
      const cands = ['/SKILL.md', '/COMMAND.md', '/AGENTS.md']
      for (let i = 0; i < cands.length; i++) {
        const p = dir + cands[i]
        if (await existsPath(p)) return { file: p, baseDir: dir }
      }
      if (await existsPath(dir + '.md')) return { file: dir + '.md', baseDir: dir }
      return null
    }
    function parseSkill(raw) {
      let desc = ''
      let allowedTools = ''
      let hasParams = false
      let rest = raw
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
      if (m) {
        const fm = m[1]
        const dm = fm.match(/^description:\s*(.+)$/m)
        if (dm) desc = String(dm[1]).trim().replace(/^["']|["']$/g, '')
        const am = fm.match(/^allowed-tools:\s*(.+)$/m)
        if (am) allowedTools = String(am[1]).trim().slice(0, 200)
        if (/^params:/m.test(fm)) hasParams = true
        rest = raw.slice(m[0].length)
      }
      return { desc, allowedTools, hasParams, rest: rest.trim() }
    }
    function scanClaudeisms(text) {
      const pats = [
        ['Haiku/Sonnet/Opus agent', /\b(Haiku|Sonnet|Opus)\s+agent\b/gi],
        ['CLAUDE.md', /\bCLAUDE\.md\b/g],
        ['Task tool/subagent', /\b(Task tool|subagent)\b/gi],
        ['claude 命令', /\bclaude\b/g],
      ]
      const found = []
      for (let i = 0; i < pats.length; i++) {
        if (pats[i][1].test(text)) found.push(pats[i][0])
      }
      return found
    }
    async function buildBridgeIndex() {
      const j = await parseJson((await pluginsDir()) + '/installed_plugins.json')
      const pl = j && j.plugins ? j.plugins : {}
      const out = []
      const seen = {}
      const add = (e) => { if (!seen[e.name]) { seen[e.name] = 1; out.push(e) } }
      const ids = Object.keys(pl)
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        const recs = pl[id] || []
        const rec = recs.length ? recs[0] : {}
        const base = rec.installPath
        if (!base) continue
        const manifest = await parseJson(base + '/.claude-plugin/plugin.json')
        if (!manifest) continue
        const pluginName = manifest.name || String(id).split('@')[0]
        const pdesc = manifest.description || ''
        const entries = []
        const push = (kind, rel) => { if (rel) entries.push({ kind: String(kind), rel: String(rel).replace(/^\.?\//, '') }) }
        for (const s of manifest.skills || []) push('skill', s)
        for (const c of manifest.commands || []) push('command', c)
        for (const a of manifest.agents || []) push('agent', a)
        for (let k = 0; k < entries.length; k++) {
          const e = entries[k]
          const dir = base + '/' + e.rel
          const probe = await resolveSkillFile(dir)
          if (!probe) continue
          const short = String(e.rel.split('/').pop() || '')
          add({
            name: 'cc-' + kebab(pluginName) + '-' + kebab(short),
            pluginId: pluginName,
            kind: e.kind,
            rel: e.rel,
            baseDir: probe.baseDir,
            file: probe.file,
            pluginDesc: pdesc,
          })
        }
        const kindMap = { skills: 'skill', commands: 'command', agents: 'agent' }
        const kindNames = Object.keys(kindMap)
        for (let k = 0; k < kindNames.length; k++) {
          const kn = kindNames[k]
          const kdir = base + '/' + kn
          if (!(await existsPath(kdir))) continue
          const files = await listDir(kdir)
          for (let f = 0; f < files.length; f++) {
            const sub = kdir + '/' + files[f]
            const probe = await resolveSkillFile(sub)
            if (!probe) continue
            const short = String(files[f]).replace(/\.md$/, '')
            add({
              name: 'cc-' + kebab(pluginName) + '-' + kebab(short),
              pluginId: pluginName,
              kind: kindMap[kn],
              rel: kn + '/' + files[f],
              baseDir: probe.baseDir,
              file: probe.file,
              pluginDesc: pdesc,
            })
          }
        }
      }
      return out
    }
    async function loadBridgeBody(e) {
      const raw = await readFile(e.file)
      if (!raw) return null
      const parsed = parseSkill(raw)
      const description = parsed.desc || (e.kind + ' from Claude Code plugin ' + e.pluginId + (e.pluginDesc ? ': ' + e.pluginDesc.slice(0, 100) : ''))
      let content = parsed.rest
      if (e.kind === 'agent') {
        content = 'You are acting as the Claude Code plugin agent 「' + e.rel.split('/').pop() + '」 from plugin ' + e.pluginId + '. Follow its full instructions below using your own tools:\n\n' + content
      }
      const hasScripts = await existsPath(e.baseDir + '/scripts')
      const mainName = String(e.file.split('/').pop() || '').toLowerCase()
      let siblings = []
      const files = await listDir(e.baseDir)
      for (let i = 0; i < files.length; i++) {
        if (!/\.md$/.test(files[i])) continue
        if (files[i].toLowerCase() === mainName) continue
        siblings.push(files[i])
      }
      const isms = scanClaudeisms(raw + ' ' + content)
      let ap = '\n\n---\n### ⚙️ DSH 适配说明（由 claude-plugin-bridge 自动生成）\n'
      ap += '- 来源: Claude Code 插件「' + e.pluginId + '」（' + e.kind + '），原始文件: ' + e.file.split('/').pop() + '\n'
      ap += '- 技能目录: ' + e.baseDir + '（其中相对文档可用 read 工具读取）\n'
      ap += '- scripts/ 目录: ' + (hasScripts ? '存在 — 如技能要求运行脚本，请用 bash 工具执行其绝对路径' : '无') + '\n'
      if (siblings.length) ap += '- 同级参考文档: ' + siblings.join(', ') + '\n'
      if (parsed.allowedTools) ap += '- frontmatter allowed-tools（DSH 不强制，仅供参考）: ' + parsed.allowedTools + '\n'
      if (isms.length) {
        ap += '- 检测到的 Claude 专属引用: ' + isms.join(', ') + '\n'
        ap += '  替换建议: "Haiku/Sonnet/Opus agent" → 用 DSH 自带 subagent 工具或在本会话内联完成; "CLAUDE.md" → 项目根 AGENTS.md/CLAUDE.md（若存在）; "/<skill>" 交叉引用 → 用 DSH skill 工具加载 cc- 前缀同名技能; "gh ..." → 直接用 bash 工具运行\n'
      }
      ap += '- 交互参数: ' + (parsed.hasParams ? '该技能声明了 frontmatter params，涉及用户输入时请先向用户确认' : '无（纯指令型，可直接执行）')
      return { description, content: content + ap, hasScripts, hasParams: parsed.hasParams, allowedTools: parsed.allowedTools, claudeisms: isms, siblings }
    }

    // ---------- MCP bridge (lazy: discover at apply, start on refresh) ----------
    function jsonSchemaToParamSpec(schema) {
      const out = {}
      if (!schema || typeof schema !== 'object') return out
      const props = schema.properties || {}
      const required = Array.isArray(schema.required) ? schema.required : []
      const keys = Object.keys(props)
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]
        const p = props[k] || {}
        const spec = {}
        if (p.description) spec.description = String(p.description).slice(0, 300)
        const t = p.type
        if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean') spec.type = t
        else if (t === 'array') { spec.type = 'array'; if (p.items && (p.items.type === 'string' || p.items.type === 'number' || p.items.type === 'integer' || p.items.type === 'boolean')) spec.items = { type: p.items.type } }
        else spec.type = 'json'
        if (Array.isArray(p.enum) && (spec.type === 'string' || spec.type === 'number' || spec.type === 'integer') && p.enum.every(function (v) { return typeof v === spec.type })) spec.enum = p.enum
        if (required.indexOf(k) !== -1) spec.required = true
        out[k] = spec
      }
      return out
    }
    function mcpToolName(pluginName, toolName) {
      return 'ccmcp-' + kebab(pluginName) + '-' + kebab(toolName)
    }
    function McpClient(serverId, pluginName, spec, baseDir) {
      let handle = null
      let nextId = 1
      let lineBuf = ''
      const pending = {}
      const tools = []
      let toolsLoaded = false
      let initFailed = ''
      function write(s) { if (handle && handle.stdin) { try { handle.stdin.write(s) } catch (e) { /* closed */ } } }
      function start() {
        if (handle) return Promise.resolve()
        if (initFailed) return Promise.reject(new Error(initFailed))
        let cmd = String(spec.command || '')
        if (!cmd) { initFailed = 'no command'; return Promise.reject(new Error(initFailed)) }
        let argv
        if (cmd.indexOf('/') !== -1) {
          if (cmd.charAt(0) !== '/') cmd = baseDir + '/' + cmd
          argv = [cmd].concat(spec.args || [])
        } else {
          argv = [cmd].concat(spec.args || [])
        }
        const env = {}
        const specEnv = spec.env || {}
        const envKeys = Object.keys(specEnv)
        for (let i = 0; i < envKeys.length; i++) {
          const v = String(specEnv[envKeys[i]])
          env[envKeys[i]] = v.split('${CLAUDE_PLUGIN_ROOT}').join(baseDir)
        }
        return new Promise(function (resolve, reject) {
          let spawned
          try {
            spawned = ctx.subprocess.spawn({
              argv,
              cwd: ctx.sandboxPolicy.workspaceRoot,
              stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
              graceMs: 1500,
              env: Object.keys(env).length ? env : undefined,
            })
          } catch (e) {
            initFailed = 'spawn failed: ' + (e && e.message ? e.message : String(e))
            reject(new Error(initFailed))
            return
          }
          handle = spawned
          spawned.stdout.on('data', function (chunk) {
            let text
            try { text = decoder.decode(chunk) } catch (e) { text = String(chunk) }
            lineBuf += text
            let idx
            while ((idx = lineBuf.indexOf('\n')) !== -1) {
              const line = lineBuf.slice(0, idx).trim()
              lineBuf = lineBuf.slice(idx + 1)
              if (!line) continue
              let msg = null
              try { msg = JSON.parse(line) } catch (e) { continue }
              if (msg && msg.id !== undefined && pending[String(msg.id)]) {
                const p = pending[String(msg.id)]
                delete pending[String(msg.id)]
                p(msg)
              }
            }
          })
          spawned.done.then(function () {
            if (handle) { handle = null; toolsLoaded = false }
          }).catch(function () { if (handle) { handle = null; toolsLoaded = false } })
          request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-claude-bridge', version: '0.1' } }, 15000)
            .then(function () {
              write('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n')
              resolve()
            })
            .catch(function (e) {
              initFailed = 'initialize failed: ' + (e && e.message ? e.message : String(e))
              try { spawned.terminate() } catch (err) { /* ignore */ }
              handle = null
              reject(new Error(initFailed))
            })
        })
      }
      function request(method, params, timeoutMs) {
        return new Promise(function (resolve, reject) {
          if (!handle) { reject(new Error('server not started')); return }
          const id = nextId++
          const t = ctx.timeout(function () {
            delete pending[String(id)]
            reject(new Error('MCP request timed out: ' + method))
          }, Math.min(timeoutMs || 120000, 2147483647))
          pending[String(id)] = function (msg) {
            t()
            if (msg.error) reject(new Error((msg.error && msg.error.message) || 'MCP error'))
            else resolve(msg.result)
          }
          try {
            write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n')
          } catch (e) {
            t()
            delete pending[String(id)]
            reject(e)
          }
        })
      }
      async function listTools() {
        await start()
        if (toolsLoaded) return tools
        const r = await request('tools/list', {}, 20000)
        tools.length = 0
        if (r && Array.isArray(r.tools)) {
          for (let i = 0; i < r.tools.length; i++) tools.push(r.tools[i])
        }
        toolsLoaded = true
        return tools
      }
      async function callTool(name, args) {
        await start()
        const r = await request('tools/call', { name: name, arguments: args || {} }, 120000)
        const out = []
        const content = (r && Array.isArray(r.content)) ? r.content : []
        for (let i = 0; i < content.length; i++) {
          const c = content[i] || {}
          if (c.type === 'text') out.push(c.text || '')
          else if (c.type === 'image') out.push('[image result (not shown)]')
          else if (c.type === 'resource') out.push('[resource: ' + ((c.resource && c.resource.uri) || '') + ']')
          else out.push(String(JSON.stringify(c)).slice(0, 500))
        }
        return { text: out.join('\n') || '(no content)', isError: !!(r && r.isError) }
      }
      function stop() {
        if (handle) { try { handle.terminate() } catch (e) { /* ignore */ } handle = null }
      }
      return { start: start, listTools: listTools, callTool: callTool, stop: stop, tools: tools, serverId: serverId, pluginName: pluginName }
    }
    const mcpServers = []
    const mcpRegistry = []
    async function discoverMcpServers() {
      const found = []
      const seen = {}
      const addServer = (serverId, pluginName, serverSpec, baseDir) => {
        if (!serverSpec || !serverSpec.command) return
        if (seen[serverId]) return
        seen[serverId] = 1
        found.push({ serverId: serverId, pluginName: pluginName, spec: serverSpec, baseDir: baseDir })
      }
      const extract = (doc, baseDir, pluginName) => {
        if (!doc) return
        const map = doc.mcpServers || doc
        if (typeof map !== 'object') return
        const keys = Object.keys(map)
        for (let i = 0; i < keys.length; i++) {
          const s = map[keys[i]] || {}
          if (s.type && s.type !== 'stdio') continue
          addServer(keys[i], pluginName, s, baseDir)
        }
      }
      const j = await parseJson((await pluginsDir()) + '/installed_plugins.json')
      const pl = j && j.plugins ? j.plugins : {}
      const ids = Object.keys(pl)
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        const recs = pl[id] || []
        const rec = recs.length ? recs[0] : {}
        const base = rec.installPath
        if (!base) continue
        const manifest = await parseJson(base + '/.claude-plugin/plugin.json')
        if (manifest) extract(manifest.mcpServers, base, manifest.name || String(ids[i]).split('@')[0])
        extract(await parseJson(base + '/.mcp.json'), base, String(ids[i]).split('@')[0])
      }
      const known = await knownMarketplaces()
      const mNames = Object.keys(known)
      for (let i = 0; i < mNames.length; i++) {
        const extRoot = known[mNames[i]].installLocation + '/external_plugins'
        if (!(await existsPath(extRoot))) continue
        const dirs = await listDir(extRoot)
        for (let d = 0; d < dirs.length; d++) {
          const dir = extRoot + '/' + dirs[d]
          extract(await parseJson(dir + '/.mcp.json'), dir, dirs[d])
        }
      }
      const seam = (await homeDir()) + '/.dsh/ccbridge-mcp'
      if (await existsPath(seam)) {
        const dirs = await listDir(seam)
        for (let d = 0; d < dirs.length; d++) {
          const dir = seam + '/' + dirs[d]
          const doc = await parseJson(dir + '/.mcp.json')
          if (doc) extract(doc, dir, dirs[d])
          const manifest = await parseJson(dir + '/plugin.json')
          if (manifest && manifest.mcpServers) extract(manifest.mcpServers, dir, dirs[d])
        }
      }
      return found
    }
    {
      const found = await discoverMcpServers()
      for (let i = 0; i < found.length; i++) {
        const d = found[i]
        mcpRegistry.push({ serverId: d.serverId, pluginName: d.pluginName, status: 'idle', tools: [], spec: d.spec, baseDir: d.baseDir })
      }
    }
    async function refreshMcp() {
      const found = await discoverMcpServers()
      const knownIds = {}
      for (let i = 0; i < mcpRegistry.length; i++) knownIds[mcpRegistry[i].serverId] = 1
      for (let i = 0; i < found.length; i++) {
        if (!knownIds[found[i].serverId]) {
          mcpRegistry.push({ serverId: found[i].serverId, pluginName: found[i].pluginName, status: 'idle', tools: [], spec: found[i].spec, baseDir: found[i].baseDir })
          knownIds[found[i].serverId] = 1
        }
      }
      const out = []
      for (let i = 0; i < mcpRegistry.length; i++) {
        const reg = mcpRegistry[i]
        if (reg.status !== 'idle') { out.push(reg.serverId + ': ' + reg.status); continue }
        const client = McpClient(reg.serverId, reg.pluginName, reg.spec, reg.baseDir)
        mcpServers.push(client)
        let toolList = []
        try {
          toolList = await client.listTools()
          reg.status = 'ok'
        } catch (e) {
          reg.status = 'error: ' + (e && e.message ? e.message : String(e))
        }
        reg.tools = []
        for (let t = 0; t < toolList.length; t++) {
          const tool = toolList[t] || {}
          if (!tool.name) continue
          const toolName = mcpToolName(reg.pluginName, tool.name)
          try {
            harness.registerTool(ctx, harness.defineTool({
              name: toolName,
              description: 'MCP tool「' + tool.name + '」from server ' + reg.serverId + ' (Claude Code plugin ' + reg.pluginName + '): ' + (tool.description || ''),
              parameters: jsonSchemaToParamSpec(tool.inputSchema),
              output: { schema: { type: 'string' }, render: renderText },
              isConcurrencySafe: () => true,
              async execute(args) {
                const r = await client.callTool(tool.name, args || {})
                if (r.isError) return 'MCP error: ' + r.text
                return r.text
              },
            }))
            reg.tools.push({ tool: tool.name, name: toolName })
          } catch (e) {
            reg.tools.push({ tool: tool.name, name: toolName + ' (register failed: ' + ((e && e.message) || String(e)) + ')' })
          }
        }
        out.push(reg.serverId + ': ' + reg.status + ' (' + reg.tools.length + ' tools)')
      }
      return out
    }
    ctx.effect(() => () => {
      for (let i = 0; i < mcpServers.length; i++) {
        try { mcpServers[i].stop() } catch (e) { /* ignore */ }
      }
    })

    // ---------- hooks bridge (Claude plugin hooks -> DSH tool lifecycle) ----------
    const hookRules = []
    async function discoverHooks() {
      const rules = []
      const addRule = (event, matcher, command, args, baseDir, pluginName) => {
        if (!command) return
        rules.push({ event: event, matcher: matcher || '*', command: command, args: args || [], baseDir: baseDir, pluginName: pluginName })
      }
      const extractHooks = (hooks, baseDir, pluginName) => {
        if (!hooks || typeof hooks !== 'object') return
        const events = Object.keys(hooks)
        for (let e = 0; e < events.length; e++) {
          const ev = events[e]
          const entries = hooks[ev]
          if (!Array.isArray(entries)) continue
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i] || {}
            const matcher = entry.matcher || '*'
            const hooksArr = Array.isArray(entry.hooks) ? entry.hooks : (entry.command ? [entry] : [])
            for (let k = 0; k < hooksArr.length; k++) {
              const hk = hooksArr[k] || {}
              addRule(ev, matcher, hk.command, hk.args, baseDir, pluginName)
            }
          }
        }
      }
      const j = await parseJson((await pluginsDir()) + '/installed_plugins.json')
      const pl = j && j.plugins ? j.plugins : {}
      const ids = Object.keys(pl)
      for (let i = 0; i < ids.length; i++) {
        const recs = pl[ids[i]] || []
        const rec = recs.length ? recs[0] : {}
        const base = rec.installPath
        if (!base) continue
        const manifest = await parseJson(base + '/.claude-plugin/plugin.json')
        if (manifest) extractHooks(manifest.hooks, base, manifest.name || String(ids[i]).split('@')[0])
      }
      const seam = (await homeDir()) + '/.dsh/ccbridge-hooks'
      if (await existsPath(seam)) {
        const dirs = await listDir(seam)
        for (let d = 0; d < dirs.length; d++) {
          const dir = seam + '/' + dirs[d]
          const manifest = await parseJson(dir + '/plugin.json')
          if (manifest) extractHooks(manifest.hooks, dir, dirs[d])
        }
      }
      return rules
    }
    function resolveHookCommand(rule) {
      const c = rule.command
      if (c.indexOf('/') !== -1) return c.charAt(0) === '/' ? c : rule.baseDir + '/' + c
      return c
    }
    function resolveHookArgs(rule) {
      return (rule.args || []).map(function (a) {
        if (a.indexOf('/') !== -1 && a.charAt(0) !== '/') return rule.baseDir + '/' + a
        return a
      })
    }
    async function runHookScript(rule, envelope) {
      const cmd = resolveHookCommand(rule)
      const argv = [cmd].concat(resolveHookArgs(rule))
      const r = await spawnCli(argv, { stdinData: JSON.stringify(envelope), stdoutMax: 64 * 1024, stderrMax: 16 * 1024, timeoutMs: 10000 })
      if (!r.ok || !r.stdout) return null
      const text = r.stdout.trim()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        const line = text.split('\n').filter(function (s) { return s.trim() })[0]
        if (line) { try { parsed = JSON.parse(line) } catch (e2) { parsed = null } }
      }
      if (!parsed || typeof parsed !== 'object') return null
      return parsed
    }
    function hookMatches(rule, toolName) {
      if (rule.matcher === '*' || rule.matcher === '') return true
      return String(rule.matcher).split('|').indexOf(toolName) !== -1
    }
    function execNameOf(exec) {
      return exec && (exec.name || exec.toolName || '') ? String(exec.name || exec.toolName) : ''
    }
    function execArgsOf(exec) {
      return exec && (exec.args || exec.arguments) ? (exec.args || exec.arguments) : {}
    }
    function resultTextOf(result) {
      if (!result || !result.content || !Array.isArray(result.content)) return ''
      const parts = []
      for (let i = 0; i < result.content.length; i++) {
        const c = result.content[i] || {}
        if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
      }
      return parts.join('\n').slice(0, 8000)
    }
    const hookRules2 = await discoverHooks()
    for (let i = 0; i < hookRules2.length; i++) hookRules.push(hookRules2[i])
    const hooksByEvent = {}
    for (let i = 0; i < hookRules.length; i++) {
      const r = hookRules[i]
      if (!hooksByEvent[r.event]) hooksByEvent[r.event] = []
      hooksByEvent[r.event].push(r)
    }
    const preRules = hooksByEvent['PreToolUse'] || []
    if (preRules.length) {
      ctx.on('tools/pre-execute', async function (exec, next) {
        const name = execNameOf(exec)
        for (let i = 0; i < preRules.length; i++) {
          const rule = preRules[i]
          if (!hookMatches(rule, name)) continue
          const env = { hook_event_name: 'PreToolUse', tool_name: name, tool_input: execArgsOf(exec), tool_use_id: '', session_id: '' }
          const res = await runHookScript(rule, env)
          if (res && res.decision === 'block') return { kind: 'deny', reason: res.reason || res.message || ('blocked by hook: ' + rule.command) }
          if (res && res.decision === 'ask') return { kind: 'ask', reason: res.reason || res.message || 'ask by hook' }
        }
        return next()
      })
    }
    const postRules = hooksByEvent['PostToolUse'] || []
    if (postRules.length) {
      ctx.on('tools/post-execute', async function (exec, result, next) {
        const name = execNameOf(exec)
        for (let i = 0; i < postRules.length; i++) {
          const rule = postRules[i]
          if (!hookMatches(rule, name)) continue
          const env = { hook_event_name: 'PostToolUse', tool_name: name, tool_input: execArgsOf(exec), tool_response: resultTextOf(result), tool_use_id: '', session_id: '' }
          const res = await runHookScript(rule, env)
          if (res && res.decision === 'block') {
            return { kind: 'block', feedback: [{ type: 'text', text: res.reason || res.message || ('blocked by hook: ' + rule.command) }] }
          }
        }
        return next()
      })
    }
    const sessionRules = (hooksByEvent['SessionStart'] || []).concat(hooksByEvent['Stop'] || [])
    if (sessionRules.length) {
      const fireHooks = function (eventName, sessionId) {
        for (let i = 0; i < sessionRules.length; i++) {
          const rule = sessionRules[i]
          if (rule.event !== eventName) continue
          const env = { hook_event_name: eventName, session_id: sessionId || '', cwd: ctx.sandboxPolicy.workspaceRoot }
          runHookScript(rule, env).catch(function () { /* fire-and-forget */ })
        }
      }
      ctx.on('agent/session-start', function (payload) {
        const agent = payload && payload.agent
        fireHooks('SessionStart', agent && (agent.id || agent.sessionId) ? String(agent.id || agent.sessionId) : '')
      })
      ctx.on('agent/disposed', function (payload) {
        const agent = payload && payload.agent
        fireHooks('Stop', agent && (agent.id || agent.sessionId) ? String(agent.id || agent.sessionId) : '')
      })
    }

    // ---------- claudeCode service ----------
    ctx.provide('claudeCode', {
      available: async () => {
        const bin = await cliBin()
        return { installed: !!bin, binary: bin || undefined, version: bin ? await queryVersion(bin) : '' }
      },
      run: async (request) => runClaude(request || {}),
      marketplaces: async () => {
        const known = await knownMarketplaces()
        const out = []
        const names = Object.keys(known)
        for (let i = 0; i < names.length; i++) {
          const mk = known[names[i]] || {}
          out.push({ name: names[i], source: mk.source || null, installLocation: mk.installLocation || '' })
        }
        return out
      },
      search: (query, marketplace) => searchPlugins(query, marketplace),
      installed: async () => {
        const j = await parseJson((await pluginsDir()) + '/installed_plugins.json')
        const out = []
        const pl = j && j.plugins ? j.plugins : {}
        const ids = Object.keys(pl)
        for (let i = 0; i < ids.length; i++) {
          const recs = pl[ids[i]] || []
          for (let k = 0; k < recs.length; k++) {
            const rec = recs[k] || {}
            out.push({ id: ids[i], version: rec.version || '', scope: rec.scope || '', installPath: rec.installPath || '' })
          }
        }
        return out
      },
      install: async (name, scope) => {
        const r = await runCliForward(['plugin', 'install', String(name), '--scope', scope || 'user'], 120000)
        return cliResult(r)
      },
      manageMarketplace: async (action, source) => {
        const argv = ['plugin', 'marketplace', String(action)]
        if (source) argv.push(String(source))
        const r = await runCliForward(argv, 300000)
        return cliResult(r)
      },
      bridged: async () => {
        const idx = await buildBridgeIndex()
        const out = []
        for (let i = 0; i < idx.length; i++) {
          const e = idx[i]
          const body = await loadBridgeBody(e)
          if (!body) continue
          out.push({ name: e.name, kind: e.kind, plugin: e.pluginId, description: body.description, file: e.file, scripts: body.hasScripts, params: body.hasParams, isms: body.claudeisms })
        }
        return out
      },
      mcp: async () => mcpRegistry.map(function (r) { return { serverId: r.serverId, pluginName: r.pluginName, status: r.status, tools: r.tools } }),
      hooks: async () => hookRules,
    })

    // ---------- Client RPC (kept for compatibility) ----------
    harness.handle('cc.bootstrap', async () => {
      const bin = await cliBin()
      const known = await knownMarketplaces()
      const j = await parseJson((await pluginsDir()) + '/installed_plugins.json')
      const installed = []
      const pl = j && j.plugins ? j.plugins : {}
      const ids = Object.keys(pl)
      for (let i = 0; i < ids.length; i++) {
        const recs = pl[ids[i]] || []
        for (let k = 0; k < recs.length; k++) {
          const rec = recs[k] || {}
          installed.push({ id: ids[i], version: rec.version || '', scope: rec.scope || '', installPath: rec.installPath || '' })
        }
      }
      const marketplaces = Object.keys(known).map(function (n) {
        const m = known[n] || {}
        return { name: n, source: m.source || null, installLocation: m.installLocation || '' }
      })
      return {
        cli: { installed: !!bin, binary: bin || '', version: bin ? await queryVersion(bin) : '', apiKeySet: await apiKeyState() },
        marketplaces,
        installed,
      }
    })
    harness.handle('cc.search', async (args) => {
      const res = await searchPlugins((args && args.query) || '', args && args.marketplace)
      return { ok: true, plugins: res.slice(0, 50) }
    })
    harness.handle('cc.install', async (args) => {
      const id = String((args && args.plugin) || '').trim()
      if (!id) return { ok: false, output: 'plugin name required' }
      const r = await runCliForward(['plugin', 'install', id, '--scope', (args && args.scope) || 'user'], 120000)
      return { ok: r.ok, output: cliResult(r) }
    })
    harness.handle('cc.manage', async (args) => {
      const action = String((args && args.action) || '').trim()
      if (['add', 'remove', 'update', 'list'].indexOf(action) === -1) return { ok: false, output: 'action must be add|remove|update|list' }
      const argv = ['plugin', 'marketplace', action]
      if (args && args.source) argv.push(String(args.source))
      const r = await runCliForward(argv, action === 'update' ? 300000 : 60000)
      return { ok: r.ok, output: cliResult(r) }
    })
    harness.handle('cc.toggle', async (args) => {
      const action = String((args && args.action) || '').trim()
      const id = String((args && args.plugin) || '').trim()
      if (['enable', 'disable'].indexOf(action) === -1 || !id) return { ok: false, output: 'action (enable|disable) and plugin required' }
      const r = await runCliForward(['plugin', action, id], 60000)
      return { ok: r.ok, output: cliResult(r) }
    })
    harness.handle('cc.details', async (args) => {
      const id = String((args && args.plugin) || '').trim()
      if (!id) return { ok: false, output: 'plugin required' }
      const r = await runCliForward(['plugin', 'details', id], 60000)
      return { ok: r.ok, output: limit(cliResult(r), 8000) }
    })
    harness.handle('cc.runSkill', async (args) => {
      const skill = String((args && args.skill) || '').trim().replace(/^\/+/, '')
      if (!skill) return { ok: false, output: 'skill name required' }
      const extra = args && args.args ? ' ' + String(args.args) : ''
      const r = await runClaude({ prompt: '/' + skill + extra, cwd: args && args.cwd, model: args && args.model, timeoutMs: (args && args.timeoutMs) || 120000 })
      if (!r.ok) return { ok: false, output: 'Skill /' + skill + ' — FAILED — ' + r.error }
      const parts = ['Skill /' + skill + ' — exit ' + r.exitCode + (r.signal ? ' (signal ' + r.signal + ')' : '') + (r.timedOut ? ' [TIMEOUT]' : '')]
      if (r.stdout) parts.push('--- stdout ---\n' + r.stdout)
      if (r.stderr) parts.push('--- stderr ---\n' + r.stderr)
      return { ok: true, output: parts.join('\n') }
    })
    harness.handle('cc.bridgeList', async () => {
      const idx = await buildBridgeIndex()
      const out = []
      for (let i = 0; i < idx.length; i++) {
        const e = idx[i]
        const body = await loadBridgeBody(e)
        if (!body) continue
        out.push({ name: e.name, kind: e.kind, plugin: e.pluginId, description: body.description, file: e.file, flags: { scripts: body.hasScripts, params: body.hasParams, isms: body.claudeisms } })
      }
      return { ok: true, skills: out }
    })
    harness.handle('cc.mcpList', async () => ({ ok: true, servers: mcpRegistry.map(function (r) { return { serverId: r.serverId, pluginName: r.pluginName, status: r.status, tools: r.tools } }), rules: hookRules }))

    // ---------- tools ----------
    const tools = [
      {
        name: 'ccplugin_marketplaces',
        description: 'List the Claude Code plugin marketplaces configured in the DSH-owned registry (~/.dsh/ccbridge/plugins/known_marketplaces.json). Use when the user asks which plugin markets are configured, or before installing plugins.',
        params: {},
        safe: true,
        exec: async () => {
          const known = await knownMarketplaces()
          const names = Object.keys(known)
          if (!names.length) return 'no plugin marketplaces configured — add one with ccmarket_file / ccplugin_manage (action add, e.g. https://github.com/sparfenyuk/claude-code-plugin-marketplace)'
          const lines = names.map(function (n) {
            const mk = known[n] || {}
            const src = mk.source ? (((mk.source.source || '') + (mk.source.repo ? ' (' + mk.source.repo + ')' : (mk.source.url ? ' (' + mk.source.url + ')' : '')))) : ''
            return n + (src ? ' — ' + src : '') + (mk.installLocation ? '\n  local: ' + mk.installLocation : '')
          })
          return 'Configured Claude Code plugin marketplaces (' + names.length + '):\n' + lines.join('\n')
        },
      },
      {
        name: 'ccplugin_search',
        description: 'Search the available Claude Code plugins across the DSH-configured marketplaces by keyword (name / description / category / author). Returns id (name@marketplace), description, category, author. Use to discover plugins before installing.',
        params: {
          query: { type: 'string', required: true, description: 'Search keyword, e.g. "code review", "lsp", "agent", "security". Empty matches all.' },
          marketplace: { type: 'string', description: 'Restrict search to one marketplace name (optional).' },
        },
        safe: true,
        exec: async (args) => {
          const res = await searchPlugins(args.query, args.marketplace)
          if (!res.length) return 'no plugins found' + (args.query ? ' for "' + args.query + '"' : '')
          const capped = res.slice(0, 30)
          const head = res.length + ' plugin(s) found' + (args.query ? ' matching "' + args.query + '"' : '') + (res.length > 30 ? '; showing first 30' : '') + ':\n'
          return head + capped.map(fmtPlugin).join('\n\n')
        },
      },
      {
        name: 'ccplugin_list',
        description: 'List the Claude Code plugins installed in the DSH-owned registry (~/.dsh/ccbridge/plugins/installed_plugins.json): id, version, scope, install path.',
        params: {},
        safe: true,
        exec: async () => {
          const j = await parseJson((await pluginsDir()) + '/installed_plugins.json')
          const pl = j && j.plugins ? j.plugins : {}
          const ids = Object.keys(pl)
          if (!ids.length) return 'no plugins installed in the DSH registry yet — find one with ccplugin_search, then install with ccinstall_file'
          const lines = ids.map(function (id) {
            const recs = pl[id] || []
            const rec = recs.length ? recs[0] : {}
            return id + '\n  version: ' + (rec.version || '-') + ' | scope: ' + (rec.scope || '-') + '\n  path: ' + (rec.installPath || '-')
          })
          return 'Installed Claude Code plugins (DSH registry, ' + ids.length + '):\n' + lines.join('\n')
        },
      },
      {
        name: 'ccplugin_details',
        description: 'Show one Claude Code plugin\'s component inventory (skills, agents, hooks, MCP servers) and projected token cost, via `claude plugin details <plugin>`. This manages the CLAUDE-side registry (~/.claude) through the claude CLI — DSH-side plugins are managed with ccinstall_file.',
        params: {
          plugin: { type: 'string', required: true, description: 'Plugin id, e.g. mattpocock-skills@claude-plugins-official or https://github.com/org/repo.' },
        },
        safe: true,
        exec: async (args) => {
          const r = await runCliForward(['plugin', 'details', String(args.plugin)], 60000)
          return limit(cliResult(r), 8000)
        },
      },
      {
        name: 'ccplugin_install',
        description: 'Install a Claude Code plugin into the CLAUDE-side registry (~/.claude/plugins) via `claude plugin install`. This does NOT touch the DSH-owned registry — for DSH-only installs use ccinstall_file. Use this only when the user explicitly wants the plugin in Claude itself.',
        params: {
          plugin: { type: 'string', required: true, description: 'Plugin id: name, or name@marketplace (recommended), or a git URL.' },
          scope: { type: 'string', enum: ['user', 'project', 'local'], description: 'Installation scope (default user).' },
        },
        safe: false,
        exec: async (args) => {
          const id = String(args.plugin || '').trim()
          if (!id) return 'plugin name required (name or name@marketplace)'
          const r = await runCliForward(['plugin', 'install', id, '--scope', args.scope || 'user'], 120000)
          return cliResult(r)
        },
      },
      {
        name: 'ccplugin_manage',
        description: 'Manage Claude Code plugin marketplaces in the CLAUDE-side registry (~/.claude) via `claude plugin marketplace`. For DSH-owned marketplaces use ccmarket_file. Use only when the user explicitly wants Claude-side management.',
        params: {
          action: { type: 'string', enum: ['add', 'remove', 'update', 'list'], required: true, description: 'Marketplace action.' },
          source: { type: 'string', description: 'For add: marketplace source (URL, path, or GitHub repo like owner/repo). For remove/update: marketplace name. Ignored for list.' },
        },
        safe: false,
        exec: async (args) => {
          const argv = ['plugin', 'marketplace', String(args.action)]
          if (args.source) argv.push(String(args.source))
          const r = await runCliForward(argv, args.action === 'update' ? 300000 : 60000)
          const txt = cliResult(r)
          if (args.action === 'add' && r.ok) return txt + '\n\nMarketplace added to the claude-side registry.'
          if (args.action === 'remove' && r.ok) return txt + '\n\nMarketplace removed from the claude-side registry.'
          return txt
        },
      },
      {
        name: 'ccplugin_toggle',
        description: 'Enable or disable an installed Claude Code plugin in the CLAUDE-side registry via `claude plugin enable|disable`. For DSH-owned plugins, removal is ccuninstall_file.',
        params: {
          action: { type: 'string', enum: ['enable', 'disable'], required: true, description: 'enable or disable.' },
          plugin: { type: 'string', required: true, description: 'Plugin id, e.g. mattpocock-skills@claude-plugins-official.' },
        },
        safe: false,
        exec: async (args) => {
          const r = await runCliForward(['plugin', String(args.action), String(args.plugin)], 60000)
          return cliResult(r)
        },
      },
      {
        name: 'ccplugin_run_skill',
        description: 'Run one skill or slash command from an installed Claude Code plugin inside a working directory, by handing `claude -p "/<skill> <args>"`. Example: ccplugin_run_skill with skill tdd turns the prompt into "/tdd …". Skills come from plugins (plugin.json skills/commands arrays) or the user\'s own skills dir.',
        params: {
          skill: { type: 'string', required: true, description: 'Skill or slash-command name (without the leading slash), e.g. tdd, code-review, grill-me.' },
          args: { type: 'string', description: 'Optional arguments appended to the slash command.' },
          cwd: { type: 'string', description: 'Working directory. Default: current session workspace root.' },
          model: { type: 'string', description: 'Optional --model override.' },
          timeoutMs: { type: 'integer', description: 'Abort after this many milliseconds (default 180000).' },
        },
        safe: false,
        exec: async (args) => {
          const skill = String(args.skill || '').trim().replace(/^\/+/, '')
          if (!skill) return 'skill name required'
          const extra = args.args ? ' ' + String(args.args) : ''
          const r = await runClaude({ prompt: '/' + skill + extra, cwd: args.cwd, model: args.model, timeoutMs: args.timeoutMs })
          if (!r.ok) return 'Skill /' + skill + ' — FAILED — ' + r.error
          const head = 'Skill /' + skill + ' — exit ' + r.exitCode + (r.signal ? ' (signal ' + r.signal + ')' : '') + (r.timedOut ? ' [TIMEOUT]' : '')
          const parts = [head]
          if (r.stdout) parts.push('--- stdout ---\n' + r.stdout)
          if (r.stderr) parts.push('--- stderr ---\n' + r.stderr)
          return parts.join('\n')
        },
      },
      {
        name: 'ccbridge_list',
        description: 'List the Claude Code plugin skills/commands/agents found in the DSH-owned plugin registry. Note: the skill BRIDGE REGISTRATION is disabled in this version, so these are informational only and do NOT appear in the DSH skill catalog.',
        params: {
          plugin: { type: 'string', description: 'Optional filter by plugin name fragment.' },
        },
        safe: true,
        exec: async (args) => {
          const idx = await buildBridgeIndex()
          const out = []
          for (let i = 0; i < idx.length; i++) {
            const e = idx[i]
            if (args.plugin && e.pluginId.indexOf(String(args.plugin)) === -1) continue
            const body = await loadBridgeBody(e)
            if (!body) continue
            const fl = (body.hasScripts ? ' [scripts]' : '') + (body.hasParams ? ' [params]' : '') + (body.claudeisms.length ? ' [claude-isms:' + body.claudeisms.length + ']' : '')
            out.push(e.name + '  [' + e.kind + ']' + fl + '  (' + e.pluginId + ')\n  ' + (body.description || '').slice(0, 120))
          }
          if (!out.length) return 'no bridged Claude skills found in the DSH registry — install a plugin with ccinstall_file first'
          return 'Bridged DSH-native skills (' + out.length + '):\n' + out.join('\n\n') + '\n\nNote: skill bridge registration is DISABLED — these are informational only and do NOT appear in the DSH skill catalog.'
        },
      },
      {
        name: 'ccmcp_list',
        description: 'List MCP servers discovered from DSH-owned plugins (~/.dsh/ccbridge/plugins), DSH-owned marketplaces (external_plugins), and the ~/.dsh/ccbridge-mcp seam, plus their status. Idle servers are started and their tools registered (ccmcp-<plugin>-<tool>) by calling ccmcp_refresh. Also shows bridged hook rules.',
        params: {},
        safe: true,
        exec: async () => {
          const lines = []
          if (!mcpRegistry.length) lines.push('No MCP servers discovered (check plugin mcpServers / .mcp.json / DSH marketplaces / ~/.dsh/ccbridge-mcp).')
          for (let i = 0; i < mcpRegistry.length; i++) {
            const s = mcpRegistry[i]
            lines.push('MCP server: ' + s.serverId + ' (plugin ' + s.pluginName + ') — ' + s.status)
            for (let t = 0; t < s.tools.length; t++) lines.push('  tool: ' + s.tools[t].name)
          }
          if (mcpRegistry.some(function (s) { return s.status === 'idle' })) lines.push('\nRun ccmcp_refresh to start idle servers and register their tools.')
          if (hookRules.length) {
            lines.push('')
            lines.push('Bridged hooks (' + hookRules.length + '):')
            for (let i = 0; i < hookRules.length; i++) {
              const h = hookRules[i]
              lines.push('  ' + h.event + (h.matcher !== '*' ? ':' + h.matcher : '') + ' → ' + h.command + ' (plugin ' + h.pluginName + ')')
            }
          } else {
            lines.push('')
            lines.push('No hook rules bridged (check plugin.json hooks / ~/.dsh/ccbridge-hooks).')
          }
          return lines.join('\n')
        },
      },
      {
        name: 'ccmcp_refresh',
        description: 'Start all idle MCP servers discovered from DSH-owned plugins, list their tools, and register each as a DSH-native tool (ccmcp-<plugin>-<tool>). Idempotent; call again after installing a new MCP-bearing plugin to pick up its servers.',
        params: {},
        safe: false,
        exec: async () => {
          const out = await refreshMcp()
          if (!out.length) return 'no MCP servers to start'
          return 'MCP refresh:\n' + out.join('\n')
        },
      },
    ]

    // v1 tools
    harness.registerTool(ctx, harness.defineTool({
      name: 'claude_code_run',
      description: 'Run one prompt through the installed Anthropic Claude Code CLI (`claude -p`, headless print mode) inside a working directory and return its final text output. Use for delegating long-lived coding work — multi-file edits, reviews, migrations — to Claude Code. Installed plugin skills are available to it via /skill-name prompts. Requires the claude CLI and a valid auth (ANTHROPIC_API_KEY env or `claude login`). Note: this spawns a real subprocess that writes files and may consume API credits; prefer the default permission mode unless you explicitly opt into bypassPermissions.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'The instruction handed to Claude Code verbatim (can contain newlines).' },
        cwd: { type: 'string', description: 'Absolute working directory for the run. Default: current session workspace root.' },
        model: { type: 'string', description: 'Optional --model override, e.g. sonnet / opus / haiku.' },
        permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan'], description: '--permission-mode. acceptEdits auto-approves file edits; bypassPermissions disables all permission checks (risky — only for trusted prompts); plan restricts to planning (best used with outputFormat json).' },
        outputFormat: { type: 'string', enum: ['text', 'json', 'stream-json'], description: 'claude --output-format. Default text; json returns the final message as one JSON line; stream-json emits one JSON object per event.' },
        timeoutMs: { type: 'integer', description: 'Abort the run after this many milliseconds (default 180000).' },
        extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra raw CLI flags appended verbatim to the claude command.' },
        apiKey: { type: 'string', description: 'Optional ANTHROPIC_API_KEY override for this run only (never echoed back).' },
        baseUrl: { type: 'string', description: 'Optional ANTHROPIC_BASE_URL override, e.g. a proxy or gateway endpoint.' },
      },
      output: { schema: { type: 'string' }, render: renderText },
      isConcurrencySafe: () => false,
      async execute(args) {
        return summarizeRun(await runClaude({
          prompt: args.prompt, cwd: args.cwd, model: args.model, permissionMode: args.permissionMode,
          outputFormat: args.outputFormat, timeoutMs: args.timeoutMs, extraArgs: args.extraArgs,
          apiKey: args.apiKey, baseUrl: args.baseUrl,
        }))
      },
    }))
    harness.registerTool(ctx, harness.defineTool({
      name: 'claude_code_status',
      description: 'Check whether the Claude Code CLI is installed, its resolved binary path and version, and whether ANTHROPIC_API_KEY is set in the environment (a `claude login` OAuth session may still authorize runs when the env var is unset).',
      parameters: {},
      output: { schema: { type: 'string' }, render: renderText },
      isConcurrencySafe: () => true,
      async execute() {
        const bin = await cliBin()
        if (!bin) return 'claude CLI is NOT installed on PATH. Install it with: npm install -g @anthropic-ai/claude-code'
        const version = (await queryVersion(bin)) || 'unknown'
        const keySet = await apiKeyState()
        return 'Claude Code CLI: INSTALLED\n' +
          'binary: ' + bin + '\n' +
          'version: ' + version + '\n' +
          'ANTHROPIC_API_KEY: ' + (keySet ? 'set' : 'NOT set in environment (a `claude login` OAuth session may still work)')
      },
    }))

    // marketplace tools
    for (const t of tools) {
      harness.registerTool(ctx, harness.defineTool({
        name: t.name,
        description: t.description,
        parameters: t.params,
        output: { schema: { type: 'string' }, render: renderText },
        isConcurrencySafe: () => !!t.safe,
        execute: t.exec,
      }))
    }
  },
}

export const name = definition.name
export const inject = [...(definition.inject || []), "tools"]
export const apply = definition.apply
