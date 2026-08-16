return {
  name: 'cc-market-engine',
  inject: ['subprocess', 'sandboxPolicy', 'timer'],
  apply(ctx) {
    function textOf(reader) {
      if (!reader) return ''
      const r = reader.readFrom(0)
      return r && r.text ? r.text : ''
    }
    function limit(s, n) {
      if (!s) return s
      return String(s).length > n ? String(s).slice(0, n) + '…' : String(s)
    }
    function rand() {
      return String(Math.floor(Math.random() * 1000000000))
    }
    async function spawnCli(argv, opts) {
      opts = opts || {}
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: opts.cwd || ctx.sandboxPolicy.workspaceRoot,
          stdio: {
            stdin: opts.stdinData !== undefined ? { data: opts.stdinData } : { data: '' },
            stdout: { maxBytes: opts.stdoutMax || 64 * 1024, spill: { maxBytes: 1024 * 1024 } },
            stderr: { maxBytes: opts.stderrMax || 32 * 1024 },
          },
          graceMs: 1500,
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
    function ok0(r) {
      return !!(r && r.ok && r.exitCode === 0)
    }
    async function shOut(argv, opts) {
      const r = await spawnCli(argv, opts)
      return r.ok && r.exitCode === 0 ? r.stdout.trim() : ''
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
      return r.ok && r.exitCode === 0 ? r.stdout : ''
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
    async function mkdirP(p) {
      const r = await spawnCli(['/bin/mkdir', '-p', p], { stdoutMax: 4096, stderrMax: 4096, timeoutMs: 10000 })
      return ok0(r)
    }
    async function rmDir(p) {
      const r = await spawnCli(['/bin/rm', '-rf', p], { stdoutMax: 4096, stderrMax: 4096, timeoutMs: 30000 })
      return ok0(r)
    }
    async function copyDir(src, dst) {
      const r = await spawnCli(['/bin/cp', '-R', src, dst], { stdoutMax: 8192, stderrMax: 8192, timeoutMs: 120000 })
      return ok0(r)
    }
    async function writeJsonFile(p, obj) {
      const tmp = p + '.tmp' + rand()
      const w = await spawnCli(['/bin/sh', '-c', 'cat > "$1"', 'sh', tmp], { stdinData: JSON.stringify(obj, null, 2) + '\n', stdoutMax: 4096, stderrMax: 4096, timeoutMs: 10000 })
      if (!ok0(w)) return { ok: false, error: 'write failed: ' + (w.error || String(w.stderr || '').slice(0, 120)) }
      const m = await spawnCli(['/bin/mv', tmp, p], { stdoutMax: 4096, stderrMax: 4096, timeoutMs: 10000 })
      return ok0(m) ? { ok: true } : { ok: false, error: 'mv failed: ' + (m.error || String(m.stderr || '').slice(0, 120)) }
    }
    async function nowIso() {
      return new Date().toISOString()
    }
    async function knownMarketplaces() {
      return (await parseJson((await pluginsDir()) + '/known_marketplaces.json')) || {}
    }
    async function installedMap() {
      const j = await parseJson((await pluginsDir()) + '/installed_plugins.json')
      const out = {}
      const pl = j && j.plugins ? j.plugins : {}
      const ids = Object.keys(pl)
      for (let i = 0; i < ids.length; i++) {
        const recs = pl[ids[i]] || []
        const rec = recs.length ? recs[0] : {}
        out[ids[i]] = { version: rec.version || '', scope: rec.scope || '', installPath: rec.installPath || '' }
      }
      return out
    }

    async function marketplaceAddFile(source) {
      const s = String(source || '').trim()
      if (!s) return { ok: false, output: 'source required (owner/repo, https URL, or local path)' }
      const isLocal = s.startsWith('/') || s.startsWith('.')
      const isUrl = /^[a-z]+:\/\//i.test(s)
      let name = ''
      let srcType = ''
      let cloneUrl = ''
      let localPath = ''
      if (!isLocal && !isUrl) {
        const parts = s.split('/')
        if (parts.length < 2) return { ok: false, output: 'github source must be owner/repo' }
        name = String(parts[parts.length - 1]).replace(/\.git$/, '')
        srcType = 'github'
        cloneUrl = 'https://github.com/' + s.replace(/\.git$/, '') + '.git'
      } else if (isUrl) {
        const gm = s.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/i)
        if (gm) {
          name = gm[2]
          srcType = 'github'
          cloneUrl = s.replace(/\.git$/, '') + '.git'
        } else {
          name = String(s.replace(/\/+$/, '').split('/').pop() || 'market').replace(/\.git$/, '')
          srcType = 'url'
          cloneUrl = s
        }
      } else {
        name = String(s.replace(/\/+$/, '').split('/').pop() || 'market')
        srcType = 'local'
        localPath = s
      }
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) name = 'market-' + rand()
      const target = (await pluginsDir()) + '/marketplaces/' + name
      const tmp = target + '.tmp' + rand()
      await mkdirP((await pluginsDir()) + '/marketplaces')
      let fetchOk = false
      if (srcType === 'local') {
        fetchOk = await copyDir(localPath, tmp)
      } else {
        const r = await spawnCli(['git', 'clone', '--depth', '1', cloneUrl, tmp], { timeoutMs: 180000, stdoutMax: 16 * 1024, stderrMax: 32 * 1024 })
        fetchOk = ok0(r)
      }
      if (!fetchOk) {
        await rmDir(tmp)
        return { ok: false, output: 'marketplace fetch failed (git clone / local copy). Check network or path.' }
      }
      const manifest = await parseJson(tmp + '/.claude-plugin/marketplace.json')
      if (!manifest) {
        await rmDir(tmp)
        return { ok: false, output: 'no .claude-plugin/marketplace.json found in source — not a Claude Code marketplace' }
      }
      await rmDir(target)
      await spawnCli(['/bin/mv', tmp, target], { stdoutMax: 4096, stderrMax: 4096, timeoutMs: 10000 })
      const known = await knownMarketplaces()
      known[name] = {
        source: srcType === 'github' ? { source: 'github', repo: s.replace(/\.git$/, '') }
          : srcType === 'url' ? { source: 'url', url: s }
            : { source: 'local', path: s },
        installLocation: target,
        lastUpdated: await nowIso(),
      }
      const wr = await writeJsonFile((await pluginsDir()) + '/known_marketplaces.json', known)
      return wr.ok
        ? { ok: true, output: 'marketplace added (DSH-owned): ' + name + ' [' + srcType + ']' }
        : { ok: false, output: 'registry write failed: ' + wr.error }
    }
    async function marketplaceRemoveFile(name) {
      const known = await knownMarketplaces()
      if (!known[name]) return { ok: false, output: 'not a configured marketplace: ' + name }
      await rmDir(known[name].installLocation)
      delete known[name]
      const wr = await writeJsonFile((await pluginsDir()) + '/known_marketplaces.json', known)
      return wr.ok ? { ok: true, output: 'marketplace removed (DSH-owned): ' + name } : { ok: false, output: 'registry write failed: ' + wr.error }
    }
    async function marketplaceUpdateFile(name) {
      const known = await knownMarketplaces()
      if (!known[name]) return { ok: false, output: 'not a configured marketplace: ' + name }
      const src = known[name].source || {}
      const sourceSpec = src.repo ? String(src.repo) : (src.url ? String(src.url) : (src.path ? String(src.path) : ''))
      if (!sourceSpec) return { ok: false, output: 'marketplace has no reproducible source' }
      const r = await marketplaceAddFile(sourceSpec)
      if (!r.ok) return r
      return { ok: true, output: 'marketplace updated (DSH-owned): ' + name + '\n' + r.output }
    }

    async function resolvePluginEntry(pluginName, marketName) {
      const known = await knownMarketplaces()
      if (marketName) {
        const mk = known[marketName]
        if (!mk) return { error: 'marketplace not configured: ' + marketName }
        const mp = await parseJson(mk.installLocation + '/.claude-plugin/marketplace.json')
        const list = mp && Array.isArray(mp.plugins) ? mp.plugins : []
        for (let i = 0; i < list.length; i++) {
          if (list[i].name === pluginName) return { entry: list[i], mk: mk, marketName: marketName }
        }
        return { error: 'plugin "' + pluginName + '" not found in marketplace "' + marketName + '" — update the marketplace first' }
      }
      const names = Object.keys(known)
      for (let i = 0; i < names.length; i++) {
        const mk = known[names[i]]
        const mp = await parseJson(mk.installLocation + '/.claude-plugin/marketplace.json')
        const list = mp && Array.isArray(mp.plugins) ? mp.plugins : []
        for (let j = 0; j < list.length; j++) {
          if (list[j].name === pluginName) return { entry: list[j], mk: mk, marketName: names[i] }
        }
      }
      return { error: 'plugin "' + pluginName + '" not found in any configured marketplace' }
    }
    async function installFile(id) {
      const at = String(id).indexOf('@')
      const pluginName = at === -1 ? String(id).trim() : String(id).slice(0, at).trim()
      const marketName = at === -1 ? '' : String(id).slice(at + 1).trim()
      if (!pluginName) return { ok: false, output: 'plugin name required (name or name@marketplace)' }
      const resolved = await resolvePluginEntry(pluginName, marketName)
      if (resolved.error) return { ok: false, output: resolved.error }
      const entry = resolved.entry
      const mk = resolved.mk
      const mName = resolved.marketName
      const cacheRoot = (await pluginsDir()) + '/cache/' + mName
      let staging = null
      let sha = ''
      if (typeof entry.source === 'string') {
        staging = mk.installLocation + '/' + String(entry.source).replace(/^\.?\//, '')
      } else {
        const so = entry.source || {}
        const url = String(so.url || '')
        if (!url) return { ok: false, output: 'plugin has no fetchable source url' }
        const tmp = '/tmp/ccbridge-' + rand()
        const r = await spawnCli(['git', 'clone', url, tmp], { timeoutMs: 300000, stdoutMax: 16 * 1024, stderrMax: 32 * 1024 })
        if (!ok0(r)) {
          await rmDir(tmp)
          return { ok: false, output: 'git clone failed: ' + limit(r.stderr || r.error || '', 300) }
        }
        const ref = so.ref || so.sha
        if (ref) {
          const c = await spawnCli(['git', '-C', tmp, 'checkout', String(ref)], { timeoutMs: 60000, stdoutMax: 8 * 1024, stderrMax: 16 * 1024 })
          if (!ok0(c)) {
            await rmDir(tmp)
            return { ok: false, output: 'git checkout ' + ref + ' failed: ' + limit(c.stderr || '', 200) }
          }
        }
        sha = (await shOut(['git', '-C', tmp, 'rev-parse', 'HEAD'])) || ''
        staging = tmp + (so.path ? '/' + String(so.path).replace(/^\.?\//, '') : '')
      }
      const manifest = await parseJson(staging + '/.claude-plugin/plugin.json')
      if (!manifest) {
        if (String(staging).indexOf('/tmp/') === 0) await rmDir(staging)
        return { ok: false, output: 'no .claude-plugin/plugin.json in fetched source — not a Claude Code plugin' }
      }
      const version = manifest.version || 'unknown'
      const finalDir = cacheRoot + '/' + pluginName + '/' + version
      await rmDir(finalDir)
      await mkdirP(cacheRoot + '/' + pluginName)
      const cpOk = await copyDir(staging, finalDir)
      if (String(staging).indexOf('/tmp/') === 0) await rmDir(staging)
      if (!cpOk) return { ok: false, output: 'copy to cache failed' }
      const regPath = (await pluginsDir()) + '/installed_plugins.json'
      const j = (await parseJson(regPath)) || { version: 2, plugins: {} }
      if (!j.plugins) j.plugins = {}
      j.plugins[pluginName + '@' + mName] = [{
        scope: 'user',
        installPath: finalDir,
        version: version,
        installedAt: await nowIso(),
        lastUpdated: await nowIso(),
        gitCommitSha: sha || '',
      }]
      const wr = await writeJsonFile(regPath, j)
      return wr.ok
        ? { ok: true, output: 'installed (DSH-owned): ' + pluginName + '@' + mName + ' v' + version }
        : { ok: false, output: 'registry write failed: ' + wr.error }
    }
    async function removeFile(id) {
      const regPath = (await pluginsDir()) + '/installed_plugins.json'
      const j = await parseJson(regPath)
      if (!j || !j.plugins || !j.plugins[id]) return { ok: false, output: 'not installed in DSH registry: ' + id }
      const rec = (j.plugins[id] || [])[0] || {}
      if (rec.installPath) await rmDir(rec.installPath)
      delete j.plugins[id]
      const wr = await writeJsonFile(regPath, j)
      return wr.ok ? { ok: true, output: 'removed (DSH-owned): ' + id } : { ok: false, output: 'registry write failed: ' + wr.error }
    }
    async function rescanSkills() {
      const skillRegistry = ctx.get('skills')
      if (!skillRegistry) return 'skills registry unavailable'
      const token = 'cc-bridge-rescan-' + rand()
      let disposer = null
      try {
        disposer = skillRegistry.register({
          name: token,
          description: 'transient rescan token — ignore',
          content: 'This is a transient token used to invalidate the skill catalog cache. Ignore it.',
          source: 'custom',
        })
      } catch (e) {
        return 'rescan failed: ' + ((e && e.message) || String(e))
      }
      if (disposer) {
        try { disposer() } catch (e) { /* ignore */ }
      }
      return 'skill catalog refreshed'
    }
    async function listMarkets() {
      const known = await knownMarketplaces()
      const installed = await installedMap()
      const out = []
      const names = Object.keys(known)
      for (let i = 0; i < names.length; i++) {
        const n = names[i]
        const mk = known[n] || {}
        const mp = await parseJson(mk.installLocation + '/.claude-plugin/marketplace.json')
        const list = mp && Array.isArray(mp.plugins) ? mp.plugins : []
        const plugins = []
        for (let j = 0; j < list.length; j++) {
          const p = list[j] || {}
          const id = p.name + '@' + n
          const inst = installed[id]
          plugins.push({
            id: id,
            name: p.name,
            description: p.description || '',
            category: p.category || '',
            author: (p.author && p.author.name) || '',
            installed: !!inst,
            version: inst ? inst.version : '',
            sourceKind: typeof p.source === 'string' ? 'local' : (p.source ? (p.source.source || 'git') : ''),
          })
        }
        out.push({ name: n, source: mk.source || null, installLocation: mk.installLocation || '', plugins: plugins })
      }
      return out
    }

    harness.handle('cm.list', async () => {
      try {
        return { ok: true, markets: await listMarkets() }
      } catch (e) {
        return { ok: false, output: (e && e.message) || String(e) }
      }
    })
    harness.handle('cm.install', async (args) => {
      try {
        const r = await installFile(args && args.id)
        await rescanSkills()
        return r
      } catch (e) {
        return { ok: false, output: (e && e.message) || String(e) }
      }
    })
    harness.handle('cm.upgrade', async (args) => {
      try {
        const id = String((args && args.id) || '').trim()
        if (!id) return { ok: false, output: 'plugin id required' }
        const rm = await removeFile(id)
        if (!rm.ok) return rm
        const r = await installFile(id)
        await rescanSkills()
        return r.ok ? { ok: true, output: 'upgraded: ' + id + '\n' + r.output } : r
      } catch (e) {
        return { ok: false, output: (e && e.message) || String(e) }
      }
    })
    harness.handle('cm.uninstall', async (args) => {
      try {
        const r = await removeFile(String((args && args.id) || '').trim())
        await rescanSkills()
        return r
      } catch (e) {
        return { ok: false, output: (e && e.message) || String(e) }
      }
    })
    harness.handle('cm.market', async (args) => {
      try {
        const action = String((args && args.action) || '')
        if (action === 'add') return await marketplaceAddFile(args && args.source)
        if (action === 'remove') return await marketplaceRemoveFile(String((args && args.source) || ''))
        if (action === 'update') return await marketplaceUpdateFile(String((args && args.source) || ''))
        return { ok: false, output: 'action must be add|remove|update' }
      } catch (e) {
        return { ok: false, output: (e && e.message) || String(e) }
      }
    })
    harness.handle('cm.rescan', async () => {
      try {
        return { ok: true, output: await rescanSkills() }
      } catch (e) {
        return { ok: false, output: (e && e.message) || String(e) }
      }
    })
  },
}
