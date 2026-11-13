/**
 * Client half of dsh-session-del.
 *
 * 侧栏一项「会话清理」+ 对应的 main 面板：列出全部会话（可见/归档/置顶/幽灵），
 * 勾选后先预演再真删；回收区可恢复；幽灵可清理。数据与动作都走宿主半的
 * 同源路由 /session-del/api/*。
 *
 * 文案 key 直接用中文原文：没有翻译时回退成 key，中文环境下永远读得通。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-del',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'session-del';
    const PANEL_ID = 'session-del';
    const API = '/session-del/api/';

    const EN = {
      $locale: 'en',
      '会话清理 · 删除 / 回收区': 'Sessions · delete / trash',
      '刷新': 'Refresh',
      '全部': 'All',
      '已归档': 'Archived',
      '界面上可见': 'Visible',
      '幽灵（索引有、目录没）': 'Ghosts (indexed, no dir)',
      '非置顶': 'Unpinned',
      '预演删除': 'Dry run',
      '真删（移到回收区）': 'Delete (move to trash)',
      '连置顶一起处理': 'Include pinned',
      '清理幽灵 ID': 'Prune ghost ids',
      '回收区': 'Trash',
      '恢复这一批': 'Restore batch',
      '清理超期批次': 'Purge old batches',
      '全选': 'Select all',
      '清空选择': 'Clear',
      '标题': 'Title',
      '大小MB': 'MB',
      '最后修改': 'Modified',
      '状态': 'State',
      '置顶': 'Pinned',
      '归档': 'Archived',
      '看不见': 'Hidden',
      '幽灵': 'Ghost',
      '已选': 'selected',
      '个会话': 'sessions',
      '没有会话': 'No sessions',
      '正在执行…': 'Working…',
      '结果': 'Result',
      '索引': 'Index',
      '磁盘': 'Disk',
      '可见': 'Visible',
      '回收区批次': 'Trash batches',
      '没有回收批次': 'No trash batches',
      '天': 'd',
      '恢复后界面可能要重启 DSH 才看得到': 'Restart DSH to see restored sessions in the UI',
    };

    /* ------------------------------------------------------------ styles */

    const page = {
      height: '100%', overflowY: 'auto', boxSizing: 'border-box',
      padding: '20px 24px 40px', background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: 1.55,
    };
    const head = { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 };
    const h1 = { fontSize: 16, fontWeight: 600, margin: 0 };
    const sub = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 };
    const card = {
      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
      padding: '12px 14px', marginTop: 14, background: 'var(--dsw-alias-bg-l1)',
    };
    const cardTitle = { fontSize: 13, fontWeight: 600, margin: '0 0 8px' };
    const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
    const btn = {
      height: 28, padding: '0 12px', borderRadius: 6, cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)', fontSize: 12,
    };
    const btnPrimary = { ...btn, background: 'var(--dsw-alias-brand-primary)', color: '#fff', borderColor: 'transparent' };
    const btnDanger = { ...btn, borderColor: '#d9534f', color: '#d9534f' };
    const select = {
      height: 28, padding: '0 8px', borderRadius: 6, fontSize: 12,
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
    };
    const pre = {
      margin: '8px 0 0', padding: 10, borderRadius: 8, maxHeight: 260, overflow: 'auto',
      background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
      fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    };
    const tbl = { width: '100%', borderCollapse: 'collapse', marginTop: 8, fontSize: 12 };
    const th = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', ...sub, fontWeight: 500 };
    const td = { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' };
    const chip = (color) => ({
      display: 'inline-block', padding: '0 7px', marginRight: 4, borderRadius: 999, fontSize: 10.5,
      border: `1px solid ${color}`, color,
    });
    const GREEN = '#3fa46a';
    const AMBER = '#c9922b';
    const BLUE = '#4a80c8';
    const RED = '#d9534f';

    function tr(t, key) { return typeof t === 'function' ? t(key) : key; }

    async function get(path) {
      const res = await fetch(API + path, { headers: { 'cache-control': 'no-cache' } });
      const json = await res.json();
      if (!res.ok || json.ok === false) {
        const message = json && (json.message || json.error || json.indexError);
        if (message) throw new Error(message);
      }
      return json;
    }

    async function post(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-del': '1' },
        body: JSON.stringify(body || {}),
      });
      return res.json();
    }

    const FILTERS = [
      ['all', '全部'],
      ['archived', '已归档'],
      ['visible', '界面上可见'],
      ['ghost', '幽灵（索引有、目录没）'],
      ['unpinned', '非置顶'],
    ];

    function SessionDelPanel(props) {
      const t = (k) => tr(props && props.t, k);
      const [data, setData] = React.useState(null);
      const [trash, setTrash] = React.useState(null);
      const [filter, setFilter] = React.useState('all');
      const [sel, setSel] = React.useState([]);
      const [busy, setBusy] = React.useState('');
      const [out, setOut] = React.useState(null);
      const [err, setErr] = React.useState('');
      const [includePinned, setIncludePinned] = React.useState(false);

      const load = React.useCallback(() => {
        setErr('');
        get('list').then(setData).catch((e) => setErr(String((e && e.message) || e)));
        get('trash').then(setTrash).catch(() => undefined);
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const rows = React.useMemo(() => {
        if (!data || !Array.isArray(data.sessions)) return [];
        const all = data.sessions;
        if (filter === 'archived') return all.filter((r) => r.archived);
        if (filter === 'visible') return all.filter((r) => r.visible && !r.ghost);
        if (filter === 'ghost') return all.filter((r) => r.ghost);
        if (filter === 'unpinned') return all.filter((r) => !r.pinned);
        return all;
      }, [data, filter]);

      const toggle = (id) => setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
      const allOn = rows.length > 0 && rows.every((r) => sel.includes(r.id));

      const run = (label, fn) => {
        setBusy(label);
        setOut(null);
        fn().then((r) => { setOut(r); load(); })
          .catch((e) => setOut({ ok: false, message: String((e && e.message) || e) }))
          .finally(() => setBusy(''));
      };

      const dryRun = () => run('dry', () => post('delete', { ids: sel, apply: false, includePinned }));
      const doDelete = () => run('del', () => post('delete', { ids: sel, apply: true, includePinned }));
      const syncGhost = () => run('ghost', () => post('sync-ghosts', { apply: true }));
      const restoreBatch = (batch) => run('restore', () => post('restore', { batch }));
      const purgeOld = () => run('purge', () => post('purge', { apply: true, minAgeDays: 30 }));

      const totals = data && data.totals ? data.totals : null;

      return h('div', { style: page },
        h('div', { style: head },
          h('h1', { style: h1 }, t('会话清理 · 删除 / 回收区')),
          h('span', { style: sub }, data && data.home ? data.home : ''),
          h('button', { style: btn, onClick: load, disabled: !!busy }, t('刷新')),
        ),
        totals ? h('div', { style: sub },
          `${t('磁盘')} ${totals.disk} · ${t('可见')} ${totals.visible} · ${t('归档')} ${totals.archived} · ${t('置顶')} ${totals.pinned} · ${t('幽灵')} ${totals.ghost} · ${totals.sizeMB} MB`) : null,
        data && data.indexError ? h('div', { style: { ...sub, color: AMBER, marginTop: 6 } }, data.indexError) : null,
        err ? h('div', { style: { ...sub, color: RED, marginTop: 6 } }, err) : null,

        h('div', { style: card },
          h('h2', { style: cardTitle }, t('状态')),
          h('div', { style: row },
            h('select', { style: select, value: filter, onChange: (e) => setFilter(e.target.value) },
              FILTERS.map(([k, label]) => h('option', { key: k, value: k }, t(label)))),
            h('button', {
              style: btn,
              onClick: () => setSel(allOn ? [] : rows.map((r) => r.id)),
            }, allOn ? t('清空选择') : t('全选')),
            h('span', { style: sub }, `${sel.length} ${t('已选')} / ${rows.length} ${t('个会话')}`),
            h('label', { style: { ...sub, display: 'inline-flex', gap: 4, alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: includePinned, onChange: (e) => setIncludePinned(e.target.checked) }),
              t('连置顶一起处理')),
          ),
          h('div', { style: { ...row, marginTop: 10 } },
            h('button', { style: btn, onClick: dryRun, disabled: !sel.length || !!busy }, t('预演删除')),
            h('button', { style: btnDanger, onClick: doDelete, disabled: !sel.length || !!busy }, t('真删（移到回收区）')),
            h('button', { style: btn, onClick: syncGhost, disabled: !!busy }, t('清理幽灵 ID')),
            busy ? h('span', { style: sub }, t('正在执行…')) : null,
          ),
          h('div', { style: { ...sub, marginTop: 8 } },
            '真删 = 移到 session-trash/<时间戳>/，从不直接删除；置顶默认跳过；索引会先备份。'),

          rows.length === 0 ? h('div', { style: { ...sub, marginTop: 10 } }, t('没有会话')) :
            h('table', { style: tbl },
              h('thead', null, h('tr', null,
                h('th', { style: { ...th, width: 28 } }),
                h('th', { style: th }, 'ID'),
                h('th', { style: th }, t('标题')),
                h('th', { style: { ...th, width: 70 } }, t('大小MB')),
                h('th', { style: { ...th, width: 120 } }, t('最后修改')),
                h('th', { style: th }, t('状态')),
              )),
              h('tbody', null, rows.map((r) => h('tr', { key: r.id },
                h('td', { style: td },
                  h('input', { type: 'checkbox', checked: sel.includes(r.id), onChange: () => toggle(r.id) })),
                h('td', { style: { ...td, fontFamily: 'ui-monospace, Consolas, monospace' } }, r.short),
                h('td', { style: { ...td, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  r.title || h('span', { style: sub }, '(无标题)')),
                h('td', { style: td }, r.sizeMB),
                h('td', { style: td }, r.mtime ? new Date(r.mtime).toISOString().slice(0, 16).replace('T', ' ') : '-'),
                h('td', { style: td },
                  r.pinned ? h('span', { style: chip(AMBER) }, t('置顶')) : null,
                  r.archived ? h('span', { style: chip(BLUE) }, t('归档')) : null,
                  !r.visible ? h('span', { style: chip(RED) }, t('看不见')) : null,
                  r.ghost ? h('span', { style: chip(AMBER) }, t('幽灵')) : null,
                ),
              ))),
            ),

          out ? h('pre', { style: pre }, JSON.stringify(out, null, 2)) : null,
        ),

        h('div', { style: card },
          h('h2', { style: cardTitle }, t('回收区')),
          h('div', { style: row },
            h('span', { style: sub }, trash && trash.root ? trash.root : ''),
            h('button', { style: btn, onClick: purgeOld, disabled: !!busy }, t('清理超期批次')),
          ),
          !trash || !Array.isArray(trash.batches) || trash.batches.length === 0
            ? h('div', { style: { ...sub, marginTop: 8 } }, t('没有回收批次'))
            : h('table', { style: tbl },
              h('thead', null, h('tr', null,
                h('th', { style: th }, 'Batch'),
                h('th', { style: { ...th, width: 80 } }, t('大小MB')),
                h('th', { style: { ...th, width: 80 } }, t('天')),
                h('th', { style: th }, t('里有什么')),
                h('th', { style: { ...th, width: 110 } }),
              )),
              h('tbody', null, trash.batches.map((b) => h('tr', { key: b.batch },
                h('td', { style: { ...td, fontFamily: 'ui-monospace, Consolas, monospace' } }, b.batch),
                h('td', { style: td }, b.sizeMB),
                h('td', { style: td }, b.ageDays == null ? '-' : b.ageDays),
                h('td', { style: td }, `${b.items.length} 项`),
                h('td', { style: td },
                  h('button', {
                    style: btn, disabled: !!busy,
                    onClick: () => restoreBatch(b.batch),
                  }, t('恢复这一批'))),
              ))),
              ),
          h('div', { style: { ...sub, marginTop: 8 } }, t('恢复后界面可能要重启 DSH 才看得到')),
        ),
      );
    }

    /* ------------------------------------------------------------------- icon */

    function SidebarIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
      },
      h('path', { d: 'M2.5 4.2h11' }),
      h('path', { d: 'M6.2 4.2V3.1c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.1' }),
      h('path', { d: 'M3.6 4.2l.7 8.3c.05.6.55 1.1 1.15 1.1h5.1c.6 0 1.1-.5 1.15-1.1l.7-8.3' }),
      h('path', { d: 'M6.6 6.6v4.6M9.4 6.6v4.6' }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale && typeof locale.register === 'function') {
          try { locale.register(NS, { zh: {}, en: EN }); } catch { /* 字典缺失不该影响面板 */ }
        }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, SessionDelPanel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 22, label: '会话清理', locale: NS,
        }, SidebarIcon));
      },
    };
  },
});

