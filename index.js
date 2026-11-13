/**
 * Host half of dsh-session-del.
 *
 * Two faces, same core (./lib/core.js):
 *   - Tools for the agent: session_del_list / _delete / _sync_ghosts / _trash / _restore
 *   - Same-origin routes under /session-del/api/* for the sidebar panel
 *
 * Everything destructive goes through core: index backup → directory moved into
 * session-trash/<stamp>/ → index pruned → log line. Nothing is rm'd at delete
 * time, so every action has a way back.
 *
 * 为什么 core 走动态 import：dsh-hmr 只重载插件入口，ESM 的静态 import 会命中模块缓存，
 * 于是改 lib/*.js 在同一个进程里永远看不到效果（实测：入口重载了、标题源还是旧的）。
 * 这里给 core 的 URL 挂上 mtime 版本戳，入口一重载就重新加载 lib —— 改逻辑不必重启 DSH。
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PREFIX = '/session-del';
const CORE_URL = new URL('./lib/core.js', import.meta.url);

let corePromise = null;

/** 加载 core（按文件 mtime 缓存，文件没变就不重复解析）。 */
function loadCore() {
  if (!corePromise) {
    let stamp = '0';
    try { stamp = String(Math.round(statSync(fileURLToPath(CORE_URL)).mtimeMs)); } catch { /* 用 0 兜底 */ }
    corePromise = import(`./lib/core.js?v=${stamp}`).catch((error) => {
      corePromise = null; // 失败不要缓存，下次重试
      throw error;
    });
  }
  return corePromise;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
      if (raw.length > 200000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const core = await loadCore();
  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; }
  catch { pathname = req.url || '/'; }
  const route = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) || '/' : pathname;

  try {
    if (req.method === 'GET' && (route === '/' || route === '/api/')) {
      sendJson(res, 200, {
        ok: true, plugin: 'dsh-session-del', version: 2, dshHome: core.dshHome(),
        log: core.logFile(),
        endpoints: [
          'GET  /session-del/api/list',
          'POST /session-del/api/delete',
          'POST /session-del/api/sync-ghosts',
          'GET  /session-del/api/trash',
          'POST /session-del/api/restore',
          'POST /session-del/api/purge',
        ],
      });
      return;
    }
    if (req.method === 'GET' && route === '/api/list') {
      sendJson(res, 200, core.listSessions());
      return;
    }
    if (req.method === 'GET' && route === '/api/trash') {
      sendJson(res, 200, core.listTrash());
      return;
    }
    // 写操作要自定义头：挡住任意网页顺手 POST 到本地端口。
    if (req.method === 'POST' && req.headers['x-session-del'] !== '1') {
      sendJson(res, 403, { ok: false, message: '缺少 X-Session-Del 头（防跨站写入）' });
      return;
    }
    if (req.method === 'POST' && route === '/api/delete') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
      sendJson(res, 200, core.deleteSessions(ids, { apply: body.apply === true, includePinned: body.includePinned === true }));
      return;
    }
    if (req.method === 'POST' && route === '/api/sync-ghosts') {
      const body = await readBody(req);
      sendJson(res, 200, core.syncGhosts({ apply: body.apply === true }));
      return;
    }
    if (req.method === 'POST' && route === '/api/restore') {
      const body = await readBody(req);
      sendJson(res, 200, core.restoreTrash(body));
      return;
    }
    if (req.method === 'POST' && route === '/api/purge') {
      const body = await readBody(req);
      sendJson(res, 200, core.purgeTrash({ apply: body.apply === true, minAgeDays: body.minAgeDays }));
      return;
    }
    sendJson(res, 404, { ok: false, message: `未知路由：${req.method} ${route}` });
  } catch (error) {
    sendJson(res, 500, { ok: false, message: String((error && error.message) || error) });
  }
}

/* ------------------------------------------------------------------ tools */

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
};

function asText(v) {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

async function guarded(fn) {
  try { return asText(await fn()); }
  catch (e) { return asText({ ok: false, error: `工具内部异常：${String((e && e.message) || e)}` }); }
}

/** 工具定义按需建（要拿到 core 才能干活），所以注册时用延迟解析的 execute。 */
function toolDefinitions(getCore) {
  return [
    {
      name: 'session_del_list',
      description:
        '列出本机 DSH 的全部会话（磁盘 × 索引 × 标题合并）：id 前缀、标题、大小 MB、最后修改、是否在界面上可见、是否归档、是否置顶、是否幽灵（索引里有但目录已没）。DSH 界面只有重命名/分叉/归档/置顶，没有删除会话，所以删之前先用它看清单。',
      parameters: {
        type: 'object',
        properties: {
          only: {
            type: 'string',
            enum: ['all', 'archived', 'visible', 'ghost', 'unpinned'],
            description: '筛选：all=全部（默认）；archived=只看归档的（用户口径：归档=想删）；visible=界面上看得到的；ghost=索引幽灵；unpinned=排除置顶。',
          },
          limit: { type: 'number', description: '最多返回多少条，默认 200。' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        return guarded(async () => {
          const core = await getCore();
          const data = core.listSessions();
          const only = (args && args.only) || 'all';
          let rows = data.sessions;
          if (only === 'archived') rows = rows.filter((r) => r.archived);
          else if (only === 'visible') rows = rows.filter((r) => r.visible && !r.ghost);
          else if (only === 'ghost') rows = rows.filter((r) => r.ghost);
          else if (only === 'unpinned') rows = rows.filter((r) => !r.pinned);
          const limit = Number.isFinite(Number(args && args.limit)) ? Number(args.limit) : 200;
          return {
            ok: data.ok,
            indexError: data.indexError,
            home: data.home,
            totals: data.totals,
            shown: Math.min(rows.length, limit),
            sessions: rows.slice(0, limit).map((r) => ({
              id: r.short,
              title: r.title || '(无标题)',
              sizeMB: r.sizeMB,
              mtime: r.mtime ? new Date(r.mtime).toISOString().slice(0, 16).replace('T', ' ') : null,
              visible: r.visible, archived: r.archived, pinned: r.pinned, ghost: r.ghost,
            })),
          };
        });
      },
    },
    {
      name: 'session_del_delete',
      description:
        '真删会话：把会话目录移到 <DSH_HOME>/session-trash/<时间戳>/（可恢复，从不 rm），同时把 id 从工作区归属与归档集剔除，并先备份 workspace.json。默认预演（apply=false 只出计划）。置顶会话默认跳过。删完若界面仍有幽灵条目，用 session_del_sync_ghosts。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '会话 id 或 8 位前缀，可多个。也接受逗号分隔的字符串。' },
          apply: { type: 'boolean', description: 'false（默认）= 只预演；true = 真的移到回收区。' },
          includePinned: { type: 'boolean', description: '连置顶会话一起删（默认 false，置顶受保护）。' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        return guarded(async () => {
          const core = await getCore();
          const raw = (args && args.ids) ?? [];
          const ids = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/).filter(Boolean);
          return core.deleteSessions(ids, { apply: args && args.apply === true, includePinned: args && args.includePinned === true });
        });
      },
    },
    {
      name: 'session_del_sync_ghosts',
      description:
        '清理索引幽灵：把 workspace.json 的「工作区归属 / 归档集 / 置顶集」里指向不存在目录的 id 剔除。删完会话界面还显示旧条目、或归档计数虚高时用它。默认预演。注意：storages 是内存权威，运行中的 DSH 下次写入可能覆盖回来 ⇒ 要让改动稳定生效需重启 DSH。',
      parameters: {
        type: 'object',
        properties: { apply: { type: 'boolean', description: 'false（默认）= 只列出；true = 真写。' } },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        return guarded(async () => (await getCore()).syncGhosts({ apply: args && args.apply === true }));
      },
    },
    {
      name: 'session_del_trash',
      description: '看回收区：每个删除批次（时间戳）、体积、放了几天、里面有哪些会话目录。恢复前先看这里拿批次名。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute() {
        return guarded(async () => (await getCore()).listTrash());
      },
    },
    {
      name: 'session_del_restore',
      description: '从回收区恢复：把某批次里的会话目录搬回原来的项目组目录（批次里的 manifest.json 记着原始组名）。给 batch 不给 names = 整批恢复。',
      parameters: {
        type: 'object',
        properties: {
          batch: { type: 'string', description: '批次名，形如 20261030-023500（session_del_trash 里列出的）。' },
          names: { type: 'array', items: { type: 'string' }, description: '可选：只恢复这些目录名；不给就整批。' },
        },
        required: ['batch'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        return guarded(async () => (await getCore()).restoreTrash(args || {}));
      },
    },
  ];
}

/* ------------------------------------------------------------------ apply */


// ---- 【2026-10-30 升级韧性】宿主 API 探测 ---------------------------------
// 宿主大版本升级后 API 可能改名/移除。这里所有宿主能力都先探测再调，
// 失败只降级（少一个工具 / 少一条路由），**绝不抛出** —— 抛出会让宿主判
// 「1 required plugin did not activate」直接起不来（10-30 就是这样崩的两次）。
function resilientMount(ctx, kind, build) {
  const warn = (tag, e) => { try { console.warn('[' + kind + '] ' + tag + ': ' + String((e && e.message) || e || '')); } catch (_) {} };
  try {
    if (!ctx || typeof ctx.inject !== 'function') { warn('ctx.inject 不可用（宿主 API 变了？），跳过'); return; }
    ctx.inject([kind], (scope) => {
      try {
        if (!scope || typeof scope.effect !== 'function') { warn('scope.effect 不可用，直接执行'); try { build(scope); } catch (e) { warn('直接执行失败（已降级）', e); } return; }
        scope.effect(() => { try { build(scope); } catch (e) { warn('effect 内失败（已降级）', e); } });
      } catch (e) { warn('mount 失败（已降级）', e); }
    });
  } catch (e) { warn('inject 失败（已降级）', e); }
}
// -------------------------------------------------------------------------

export function apply(ctx) {
  resilientMount(ctx, 'tools', (scope) => {
    for (const def of toolDefinitions(loadCore)) {
      scope.effect(() => scope.tools.register(def));
    }
  });

  resilientMount(ctx, 'webServer', (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => {
        handle(req, res).catch((error) => {
          try { sendJson(res, 500, { ok: false, message: String((error && error.message) || error) }); }
          catch { /* response already gone */ }
        });
      },
    }));
  });
}
