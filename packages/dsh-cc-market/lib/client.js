// dsh-tools package build (auto-generated from plugins/cc-market/client.js by scripts/build-packages.mjs)
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
      const res = await fetch(CC_MARKET_API + '/' + String(method).replace(/^cm\./, ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const definition = {
  name: 'cc-market-settings',
  apply(ctx) {
    const h = React.createElement
    insertCss(
      '.cmm{font-size:13px;line-height:1.55;display:flex;flex-direction:column;gap:10px;max-width:760px;}' +
      '.cmm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}' +
      '.cmm-card{border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:10px 12px;}' +
      '.cmm-card-title{font-weight:600;margin-bottom:6px;}' +
      '.cmm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}' +
      '.cmm-row{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:6px 0;border-top:1px solid rgba(128,128,128,.18);}' +
      '.cmm-row:first-child{border-top:none;}' +
      '.cmm-hint{opacity:.7;font-size:12px;}' +
      '.cmm-btns{display:flex;gap:6px;flex-shrink:0;}' +
      '.cmm-err{color:#d64545;font-size:12px;}' +
      '.cmm-log{background:rgba(128,128,128,.12);border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;}' +
      '.cmm input,.cmm button{font-size:12px;}' +
      '.cmm-fld{display:flex;gap:6px;margin-top:6px;}' +
      '.cmm-fld input{flex:1;min-width:0;}' +
      '.cmm-badge{font-size:11px;padding:1px 6px;border-radius:8px;border:1px solid rgba(128,128,128,.4);white-space:nowrap;}'
    )

    function MarketPage() {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [log, setLog] = React.useState('')
      const [q, setQ] = React.useState('')
      const [mkSource, setMkSource] = React.useState('')

      const refresh = async () => {
        setBusy(true); setErr('')
        try {
          const r = await apiCall('cm.list', {})
          setData((r && r.markets) || [])
        } catch (e) {
          setErr('加载失败: ' + ((e && e.message) ? e.message : String(e)))
        }
        setBusy(false)
      }
      React.useEffect(() => { refresh() }, [])

      const doPlugin = async (action, id) => {
        setBusy(true); setErr(''); setLog(action + ' ' + id + ' …')
        try {
          const r = await apiCall('cm.' + action, { id: id })
          setLog((r && r.output) || (action + ' 完成'))
          refresh()
        } catch (e) {
          setErr(action + ' 失败: ' + ((e && e.message) ? e.message : String(e)))
        }
        setBusy(false)
      }
      const doMarket = async (action, src) => {
        setBusy(true); setErr(''); setLog('market ' + action + ' ' + (src || '') + ' …')
        try {
          const r = await apiCall('cm.market', { action: action, source: src || undefined })
          setLog((r && r.output) || ('market ' + action + ' 完成'))
          refresh()
        } catch (e) {
          setErr('市场操作失败: ' + ((e && e.message) ? e.message : String(e)))
        }
        setBusy(false)
      }
      const doRescan = async () => {
        setBusy(true); setErr('')
        try {
          const r = await apiCall('cm.rescan', {})
          setLog((r && r.output) || '刷新完成')
        } catch (e) {
          setErr('刷新失败: ' + ((e && e.message) ? e.message : String(e)))
        }
        setBusy(false)
      }

      const btn = (label, onClick, disabled) => h('button', { type: 'button', onClick: onClick, disabled: disabled || busy }, label)
      const cardTitle = (t) => h('div', { className: 'cmm-card-title' }, t)
      const markets = data || []
      const ql = String(q || '').toLowerCase().trim()
      const filtered = markets.map(function (m) {
        return {
          market: m,
          plugins: ql ? (m.plugins || []).filter(function (p) {
            return String(p.id + ' ' + (p.description || '') + ' ' + (p.category || '')).toLowerCase().indexOf(ql) !== -1
          }) : (m.plugins || []),
        }
      })

      return h('div', { className: 'cmm' }, [
        h('div', { className: 'cmm-head' }, [
          h('strong', null, 'CC插件市场（DSH 独立安装）'),
          h('div', { className: 'cmm-btns' }, [
            btn('刷新目录', doRescan),
            btn('刷新列表', refresh),
          ]),
        ]),
        err ? h('div', { className: 'cmm-err' }, err) : null,
        h('div', { className: 'cmm-fld' }, [
          h('input', { value: q, onChange: function (e) { setQ(e.target.value) }, placeholder: '筛选: 插件名 / 描述 / 分类 …' }),
        ]),
        !data ? h('div', { className: 'cmm-hint' }, '加载中…') : filtered.map(function (fm) {
          const m = fm.market
          const src = m.source ? ((m.source.source || '') + (m.source.repo ? ' (' + m.source.repo + ')' : (m.source.url ? ' (' + m.source.url + ')' : ''))) : ''
          return h('div', { className: 'cmm-card', key: m.name }, [
            cardTitle(m.name + (src ? ' — ' + src : '')),
            fm.plugins.length ? fm.plugins.map(function (p) {
              return h('div', { className: 'cmm-row', key: p.id }, [
                h('div', null, [
                  h('div', null, [
                    h('span', { className: 'cmm-mono' }, p.name),
                    h('span', { className: 'cmm-badge' }, p.installed ? ('已安装 v' + (p.version || '-')) : '未安装'),
                  ]),
                  h('div', { className: 'cmm-hint' }, String(p.description || '').slice(0, 160) + ((p.description || '').length > 160 ? '…' : '')),
                  h('div', { className: 'cmm-hint' }, [p.category ? '分类: ' + p.category + ' | ' : '', p.author ? '作者: ' + p.author : ''].join('')),
                ]),
                h('div', { className: 'cmm-btns' }, [
                  p.installed ? btn('升级', function () { doPlugin('upgrade', p.id) }) : btn('安装', function () { doPlugin('install', p.id) }),
                  p.installed ? btn('卸载', function () { doPlugin('uninstall', p.id) }) : null,
                ]),
              ])
            }) : h('div', { className: 'cmm-hint' }, '无匹配插件'),
            h('div', { className: 'cmm-fld' }, [
              h('input', { value: mkSource, onChange: function (e) { setMkSource(e.target.value) }, placeholder: '添加市场: owner/repo 或 https://github.com/… 或本地路径', onKeyDown: function (e) { if (e.key === 'Enter') doMarket('add', mkSource) } }),
              btn('添加市场', function () { doMarket('add', mkSource) }),
              btn('更新', function () { doMarket('update', m.name) }),
              btn('移除', function () { doMarket('remove', m.name) }),
            ]),
          ])
        }),
        log ? h('div', null, [
          h('div', { className: 'cmm-card-title' }, '操作日志'),
          h('pre', { className: 'cmm-mono cmm-log' }, log),
        ]) : null,
      ])
    }

    const slots = ctx.slots || ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'plugin-market', order: 32, label: 'CC插件市场' },
      () => h(MarketPage, null),
    ))
  },
}

    exports.name = definition.name
    exports.inject = ['slots']
    exports.apply = definition.apply
    return module.exports
  },
})
