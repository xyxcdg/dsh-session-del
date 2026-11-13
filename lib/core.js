/**
 * @local/session-del — 数据层（纯 Node，零依赖）。
 *
 * 为什么要有它：DSH 界面上「删除」只对工作区生效，会话行菜单只有
 * 重命名/分叉/归档/置顶。所以想真删一个会话，只能自己动磁盘 + 动索引。
 * 这个模块把这件事做成一条可回滚的流水线：
 *
 *   1) 读索引（storages/workspace.json）与标题缓存（session_projcache.json）
 *   2) 扫磁盘（sessions/<project>/<sessionDir>）合并成一张表
 *   3) 删除 = 先把 workspace.json 备份，再把会话目录【移动到 session-trash/<时间戳>/】
 *      —— 从不 rm，回收区超期才由 purge 真删
 *   4) 同时把 id 从「工作区归属」和「归档集」里剔除；索引里指向已删目录的幽灵 id
 *      可以另外 sync 掉
 *
 * 判据：目录真的移动了、索引回读确认、回收区里能找回。
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync,
  statSync, writeFileSync, copyFileSync, rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ 路径 */

/**
 * DSH 数据根，按优先级：
 *   1) DSH_HOME 环境变量（便携版启动器会设，正常路径）
 *   2) 从插件自身位置推断：插件在 <ROOT>\1-DSH程序\plugins\<pkg>，
 *      同级有 <ROOT>\1-DSH程序\.dsh 就用它
 *   3) ~/.dsh
 *
 * 第 2 条是防误删的：U 盘侧如果没设 DSH_HOME（比如手工跑 CLI、别的电脑上直接双击），
 * 会落到宿主机的 ~/.dsh —— 那就可能删掉别人的会话。从磁盘布局推断能把它钉回 U 盘自己的数据。
 */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return env.trim();
  const guess = guessHomeBesidePlugin();
  if (guess) return guess;
  return join(homedir(), '.dsh');
}

/**
 * 从本模块位置往上找 U-DSH 约定布局：
 *   <ROOT>\1-DSH程序\plugins\<pkg>\lib\core.js → <ROOT>\1-DSH程序\.dsh
 * 这是 U 盘独有的，不会误命中宿主 ~/.dsh。
 */
function guessHomeBesidePlugin() {
  try {
    let dir = dirname(fileURLToPath(import.meta.url)); // …/plugins/<pkg>/lib
    for (let i = 0; i < 4; i += 1) {
      const parent = dirname(dir);
      if (parent === dir) break;
      if (basename(dir) === 'plugins' && basename(parent) === '1-DSH程序') {
        const candidate = join(parent, '.dsh');
        if (existsSync(candidate)) return candidate;
        // 夹具里临时 .dsh 不存在时，别继续往上走了（否则会捡到宿主 ~/.dsh）
        return null;
      }
      dir = parent;
    }
  } catch { /* 推断不出就走调用方的兜底 */ }
  return null;
}

export function paths(home = dshHome()) {
  return {
    home,
    sessions: join(home, 'sessions'),
    storages: join(home, 'storages'),
    workspace: join(home, 'storages', 'workspace.json'),
    projcache: join(home, 'storages', 'session_projcache.json'),
    cache: join(home, 'storages', 'session_projcache'),
    trash: join(home, 'session-trash'),
    logs: join(home, 'logs'),
  };
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { __parseError: String((error && error.message) || error) };
  }
}

/** 索引里的 id 带 `session-` 前缀，磁盘目录名多数也带、少数不带 ⇒ 两边都归一化再比。 */
export function bare(id) {
  return String(id || '').replace(/^session-/, '');
}

export function shortId(id) {
  const b = bare(id);
  return b.length > 8 ? b.slice(0, 8) : b;
}

/* ------------------------------------------------------------ 索引读取 */

export function readIndex(home = dshHome()) {
  const p = paths(home);
  const raw = readJson(p.workspace);
  if (!raw || raw.__parseError) {
    return {
      ok: false,
      error: raw && raw.__parseError
        ? `workspace.json 解析失败：${raw.__parseError}`
        : `找不到 ${p.workspace}`,
      file: p.workspace,
      accounted: new Map(), archived: [], pinned: [], workspaceIds: [], raw: null,
    };
  }
  const wsIds = Array.isArray(raw?.global?.workspaceIds) ? raw.global.workspaceIds : [];
  const accounted = new Map(); // bareId -> { id, workspaceId, title }
  const tables = raw?.tables?.workspaces ?? {};
  for (const wsId of wsIds) {
    const rec = tables[wsId];
    if (!rec) continue;
    for (const id of Array.isArray(rec.sessionIds) ? rec.sessionIds : []) {
      accounted.set(bare(id), { id, workspaceId: wsId, title: rec.title ?? '' });
    }
  }
  return {
    ok: true,
    file: p.workspace,
    raw,
    workspaceIds: wsIds,
    accounted,
    archived: Array.isArray(raw?.global?.archivedSessionIds) ? raw.global.archivedSessionIds : [],
    pinned: Array.isArray(raw?.global?.pinnedSessionIds) ? raw.global.pinnedSessionIds : [],
  };
}

/**
 * 标题来源。DSH 有两个世代：
 *   - 新（v7 per-record）：<DSH_HOME>/storages/session_projcache/sessions/<uuid>.json
 *     每个会话一个小 JSON，标题在 record.rows.title.val，cwd 在 record.identity.cwd。
 *   - 旧（单文件）：<DSH_HOME>/storages/session_projcache.json，tables.sessions[id].rows.title.val。
 * 本机实测：单文件那份 2026/10/3 就停更了（只剩 3 条），新目录有 559 条 —— 所以先读目录，
 * 目录不存在才回落到单文件。
 *
 * @param home DSH 数据根
 * @param only 可选：只读这些 bareId 的记录（避免为了 50 条会话读 559 个文件）
 */
export function readTitles(home = dshHome(), only = null) {
  const p = paths(home);
  const map = new Map();
  const want = only ? new Set([...only].map(bare)) : null;

  const dir = join(p.cache, 'sessions');
  if (existsSync(dir)) {
    let files = [];
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { files = []; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue; // 跳过 .tmp（写入中）
      const key = bare(f.name.slice(0, -5));
      if (want && !want.has(key)) continue;
      const j = readJson(join(dir, f.name));
      const rec = j && j.record;
      if (!rec) continue;
      const title = rec?.rows?.title?.val;
      map.set(key, {
        title: typeof title === 'string' && title.trim() ? title.trim() : '',
        createdAt: typeof rec?.identity?.createdAt === 'number' ? rec.identity.createdAt : null,
        cwd: typeof rec?.identity?.cwd === 'string' ? rec.identity.cwd : '',
      });
    }
    if (map.size > 0) return map;
  }

  const j = readJson(p.projcache);
  const table = j && j.tables && j.tables.sessions;
  if (!table || typeof table !== 'object') return map;
  for (const [id, row] of Object.entries(table)) {
    const key = bare(id);
    if (want && !want.has(key)) continue;
    const title = row?.rows?.title?.val;
    const createdAt = row?.identity?.createdAt;
    const cwd = row?.identity?.cwd;
    map.set(key, {
      title: typeof title === 'string' && title.trim() ? title.trim() : '',
      createdAt: typeof createdAt === 'number' ? createdAt : null,
      cwd: typeof cwd === 'string' ? cwd : '',
    });
  }
  return map;
}

/* ------------------------------------------------------------ 磁盘扫描 */

/** 单次遍历取「整树字节数 + 整树最大文件 mtime」（mtime 口径与 session-autopurge 一致）。 */
function measureDir(dir) {
  let total = 0;
  let newest = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let items;
    try { items = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const full = join(cur, it.name);
      try {
        if (it.isDirectory()) stack.push(full);
        else if (it.isFile()) {
          const st = statSync(full);
          total += st.size;
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        }
      } catch { /* 单个文件读不到就跳过，不影响整表 */ }
    }
  }
  if (!newest) {
    try { newest = statSync(dir).mtimeMs; } catch { /* 保持 0 */ }
  }
  return { bytes: total, mtime: newest || null };
}

/** 磁盘上的会话目录（sessions/<group>/<dir>）。 */
export function scanDisk(home = dshHome()) {
  const p = paths(home);
  const out = [];
  if (!existsSync(p.sessions)) return out;
  let groups = [];
  try { groups = readdirSync(p.sessions, { withFileTypes: true }); } catch { return out; }
  for (const g of groups) {
    if (!g.isDirectory()) continue; // 例如 index.json 之类
    const groupDir = join(p.sessions, g.name);
    let leaves = [];
    try { leaves = readdirSync(groupDir, { withFileTypes: true }); } catch { continue; }
    for (const leaf of leaves) {
      if (!leaf.isDirectory()) continue;
      const dir = join(groupDir, leaf.name);
      let mtime = null;
      let sizeBytes = 0;
      try {
        const m = measureDir(dir);
        mtime = m.mtime;
        sizeBytes = m.bytes;
      } catch { /* 权限/占用：仍然列出，只是缺数字 */ }
      out.push({
        key: bare(leaf.name),
        dirName: leaf.name,
        group: g.name,
        dir,
        mtime,
        sizeBytes,
      });
    }
  }
  return out;
}

/**
 * 合并视图：磁盘 × 索引 × 标题缓存。
 * visible = 在某个工作区的 sessionIds 里（界面上看得到）；archived = 在归档集里。
 * ghost = 索引里有、磁盘上已经没有（归档计数虚高的来源）。
 */
export function listSessions(home = dshHome()) {
  const index = readIndex(home);
  const disk = scanDisk(home);
  // 标题只读「磁盘上有的 + 索引里有的」，别为了 50 条会话去读 500 多个记录文件
  const want = new Set(disk.map((d) => d.key));
  for (const key of index.accounted.keys()) want.add(key);
  for (const id of index.archived) want.add(bare(id));
  const titles = readTitles(home, want);
  const archivedSet = new Set(index.archived.map(bare));
  const pinnedSet = new Set(index.pinned.map(bare));
  const seen = new Set();
  const rows = [];

  for (const d of disk) {
    seen.add(d.key);
    const acc = index.accounted.get(d.key);
    const meta = titles.get(d.key);
    rows.push({
      id: acc ? acc.id : `session-${d.key}`,
      short: shortId(d.key),
      key: d.key,
      dirName: d.dirName,
      group: d.group,
      dir: d.dir,
      sizeBytes: d.sizeBytes,
      sizeMB: Math.round((d.sizeBytes / 1048576) * 10) / 10,
      mtime: d.mtime,
      title: (meta && meta.title) || (acc && acc.title) || '',
      cwd: (meta && meta.cwd) || '',
      createdAt: (meta && meta.createdAt) || null,
      visible: Boolean(acc),
      archived: archivedSet.has(d.key),
      pinned: pinnedSet.has(d.key),
      ghost: false,
    });
  }

  // 索引里有、磁盘上没有的幽灵
  const idsInIndex = new Map();
  for (const [key, acc] of index.accounted) idsInIndex.set(key, acc.id);
  for (const id of index.archived) if (!idsInIndex.has(bare(id))) idsInIndex.set(bare(id), id);
  for (const [key, id] of idsInIndex) {
    if (seen.has(key)) continue;
    const meta = titles.get(key);
    rows.push({
      id,
      short: shortId(key),
      key,
      dirName: '',
      group: '',
      dir: '',
      sizeBytes: 0,
      sizeMB: 0,
      mtime: null,
      title: (meta && meta.title) || '',
      cwd: (meta && meta.cwd) || '',
      createdAt: (meta && meta.createdAt) || null,
      visible: index.accounted.has(key),
      archived: archivedSet.has(key),
      pinned: pinnedSet.has(key),
      ghost: true,
    });
  }

  rows.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return {
    ok: index.ok,
    indexError: index.ok ? null : index.error,
    home,
    sessionsRoot: paths(home).sessions,
    trashRoot: paths(home).trash,
    totals: {
      disk: rows.filter((r) => !r.ghost).length,
      visible: rows.filter((r) => r.visible && !r.ghost).length,
      archived: rows.filter((r) => r.archived && !r.ghost).length,
      pinned: rows.filter((r) => r.pinned && !r.ghost).length,
      ghost: rows.filter((r) => r.ghost).length,
      sizeMB: Math.round(rows.reduce((s, r) => s + r.sizeBytes, 0) / 1048576),
    },
    sessions: rows,
  };
}

/* ------------------------------------------------------------ 删除流水线 */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupIndex(home) {
  const p = paths(home);
  if (!existsSync(p.workspace)) return null;
  const dst = `${p.workspace}.bak-sessiondel-${stamp()}`;
  copyFileSync(p.workspace, dst);
  return dst;
}

/** 把一批 bareId 从工作区归属与归档集里剔除，其余字段原样保留。 */
function pruneIndex(raw, keys) {
  const drop = new Set(keys);
  const next = JSON.parse(JSON.stringify(raw));
  const tables = next?.tables?.workspaces ?? {};
  for (const wsId of Object.keys(tables)) {
    const rec = tables[wsId];
    if (Array.isArray(rec.sessionIds)) {
      rec.sessionIds = rec.sessionIds.filter((id) => !drop.has(bare(id)));
    }
  }
  if (Array.isArray(next?.global?.archivedSessionIds)) {
    next.global.archivedSessionIds = next.global.archivedSessionIds.filter((id) => !drop.has(bare(id)));
  }
  if (Array.isArray(next?.global?.pinnedSessionIds)) {
    next.global.pinnedSessionIds = next.global.pinnedSessionIds.filter((id) => !drop.has(bare(id)));
  }
  return next;
}

/** 支持完整 id / 8 位前缀；命中多个算歧义，不猜。 */
export function resolveTargets(rows, queries) {
  const targets = [];
  const problems = [];
  for (const q of queries) {
    const n = bare(String(q).trim());
    if (!n) continue;
    const exact = rows.filter((r) => r.key === n);
    const hits = exact.length ? exact : rows.filter((r) => r.key.startsWith(n));
    if (hits.length === 0) problems.push({ query: q, problem: '找不到' });
    else if (hits.length > 1) problems.push({ query: q, problem: `前缀有歧义（${hits.length} 个）` });
    else if (!targets.some((t) => t.key === hits[0].key)) targets.push(hits[0]);
  }
  return { targets, problems };
}

/**
 * 删除（= 移到回收区）。默认预演，apply:true 才动盘。
 * 置顶会话默认跳过；includePinned:true 才一起删（会先把置顶标记剔除）。
 */
export function deleteSessions(ids, options = {}) {
  const home = options.home || dshHome();
  const apply = options.apply === true;
  const includePinned = options.includePinned === true;
  const p = paths(home);
  const listed = listSessions(home);
  const { targets, problems } = resolveTargets(listed.sessions, ids || []);

  const skipped = [];
  const plan = [];
  for (const t of targets) {
    if (t.pinned && !includePinned) { skipped.push({ id: t.short, reason: '置顶保护（先取消置顶，或勾选「连置顶一起」）' }); continue; }
    if (t.ghost) { plan.push({ ...t, mode: 'index-only' }); continue; }
    plan.push({ ...t, mode: 'move-dir' });
  }

  if (!apply) {
    return {
      ok: true, applied: false, dryRun: true,
      message: '预演：没有动任何文件。apply=true 才执行。',
      plan: plan.map((t) => ({ id: t.short, title: t.title, sizeMB: t.sizeMB, mode: t.mode })),
      problems, skipped,
      trashRoot: p.trash,
    };
  }
  if (plan.length === 0) {
    return { ok: false, applied: false, message: '没有可删的目标（检查 id，或目标都在置顶保护里）', problems, skipped };
  }

  const backup = backupIndex(home);
  const trashDir = join(p.trash, stamp());
  const moved = [];
  const failed = [];
  for (const t of plan) {
    if (t.mode === 'index-only') { moved.push({ id: t.short, title: t.title, movedTo: '(仅索引)' }); continue; }
    try {
      mkdirSync(trashDir, { recursive: true });
      const dst = join(trashDir, t.dirName);
      renameSync(t.dir, dst);
      // 记账：写进批次的 manifest，恢复时不用靠猜组名
      try {
        writeFileSync(join(trashDir, 'manifest.json'), JSON.stringify({
          at: new Date().toISOString(),
          home,
          items: plan.filter((x) => x.mode === 'move-dir').map((x) => ({
            name: x.dirName, id: x.id, key: x.key, group: x.group,
            title: x.title, sizeMB: x.sizeMB,
          })),
        }, null, 2), 'utf8');
      } catch { /* manifest 只是恢复线索，写失败不影响删除 */ }
      // 组目录空了就顺手删掉（只删空目录，非空会失败 ⇒ 忽略）
      try { rmdirSync(join(p.sessions, t.group)); } catch { /* 非空或占用，留着 */ }
      moved.push({ id: t.short, title: t.title, movedTo: dst });
    } catch (error) {
      failed.push({ id: t.short, error: String((error && error.message) || error) });
    }
  }

  let indexSynced = false;
  let indexError = null;
  try {
    if (existsSync(p.workspace)) {
      const raw = JSON.parse(readFileSync(p.workspace, 'utf8'));
      const next = pruneIndex(raw, plan.map((t) => t.key));
      writeFileSync(p.workspace, JSON.stringify(next, null, 2), 'utf8');
      indexSynced = true;
    }
  } catch (error) {
    indexError = String((error && error.message) || error);
  }

  emitLog(home, {
    action: 'delete',
    requested: ids,
    moved: moved.map((m) => m.id),
    failed,
    indexSynced,
    indexError,
    trashDir: moved.length ? trashDir : null,
  });

  return {
    ok: failed.length === 0,
    applied: true,
    moved: moved.length,
    failed,
    skipped,
    problems,
    trashDir: moved.length ? trashDir : null,
    indexBackup: backup,
    indexSynced,
    indexError,
    note: indexSynced
      ? '索引已同步。若界面仍显示旧条目，重启 DSH 后消失（storages 是内存权威，运行时可能整份覆盖回写）。'
      : `索引没能同步（${indexError || '没有 workspace.json'}）：会话目录已经移走，界面上可能留幽灵条目，点「清理幽灵」再试一次。`,
  };
}

/**
 * 清理索引幽灵：把 archivedSessionIds / 各工作区 sessionIds 里指向不存在目录的 id 剔除。
 * 与 delete 分开，是因为「运行时内存权威」会把外部写回覆盖掉，需要时可反复点。
 */
export function syncGhosts(options = {}) {
  const home = options.home || dshHome();
  const apply = options.apply === true;
  const p = paths(home);
  if (!existsSync(p.workspace)) return { ok: false, message: `找不到 ${p.workspace}` };
  const raw = JSON.parse(readFileSync(p.workspace, 'utf8'));
  const onDisk = new Set(scanDisk(home).map((d) => d.key));
  const ghosts = [];
  const tables = raw?.tables?.workspaces ?? {};
  for (const wsId of Object.keys(tables)) {
    for (const id of Array.isArray(tables[wsId].sessionIds) ? tables[wsId].sessionIds : []) {
      if (!onDisk.has(bare(id))) ghosts.push({ id, where: 'workspace' });
    }
  }
  for (const id of Array.isArray(raw?.global?.archivedSessionIds) ? raw.global.archivedSessionIds : []) {
    if (!onDisk.has(bare(id))) ghosts.push({ id, where: 'archived' });
  }
  const uniq = [...new Map(ghosts.map((g) => [bare(g.id), g])).values()];
  if (!apply) {
    return { ok: true, applied: false, dryRun: true, ghosts: uniq.map((g) => ({ id: shortId(g.id), where: g.where })), count: uniq.length };
  }
  if (uniq.length === 0) return { ok: true, applied: true, removed: 0, message: '索引里没有幽灵 id' };
  const backup = backupIndex(home);
  const next = pruneIndex(raw, uniq.map((g) => bare(g.id)));
  writeFileSync(p.workspace, JSON.stringify(next, null, 2), 'utf8');
  emitLog(home, { action: 'sync-ghosts', removed: uniq.length });
  return { ok: true, applied: true, removed: uniq.length, indexBackup: backup, ghosts: uniq.map((g) => ({ id: shortId(g.id), where: g.where })) };
}

/* ------------------------------------------------------------------ 回收区 */

export function listTrash(home = dshHome()) {
  const p = paths(home);
  if (!existsSync(p.trash)) return { ok: true, root: p.trash, batches: [] };
  const batches = [];
  for (const b of readdirSync(p.trash, { withFileTypes: true })) {
    if (!b.isDirectory()) continue;
    const dir = join(p.trash, b.name);
    const items = [];
    let bytes = 0;
    for (const it of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, it.name);
      let size = 0;
      let mtime = null;
      try {
        size = it.isDirectory() ? measureDir(full).bytes : statSync(full).size;
        mtime = statSync(full).mtimeMs;
      } catch { /* 缺数字不影响列出 */ }
      bytes += size;
      items.push({ name: it.name, key: bare(it.name), sizeMB: Math.round((size / 1048576) * 10) / 10, mtime });
    }
    let ageMs = null;
    try { ageMs = Date.now() - statSync(dir).mtimeMs; } catch { /* ignore */ }
    batches.push({ batch: b.name, dir, bytes, sizeMB: Math.round((bytes / 1048576) * 10) / 10, ageDays: ageMs === null ? null : Math.floor(ageMs / 86400000), items });
  }
  batches.sort((a, b) => (a.batch < b.batch ? 1 : -1));
  return { ok: true, root: p.trash, batches };
}

/** 从回收区搬回原组目录。目标组目录按会话头 cwd 推不出来时用原组名（存在 session-meta 里没记 group ⇒ 用 --restore-- 兜底）。 */
export function restoreTrash(request, options = {}) {
  const home = options.home || dshHome();
  const p = paths(home);
  const batch = String(request.batch || '').trim();
  if (!batch) return { ok: false, message: '要给 batch（回收批次名）' };
  const src = join(p.trash, batch);
  if (!existsSync(src)) return { ok: false, message: `回收批次不存在：${src}` };
  const names = Array.isArray(request.names) && request.names.length
    ? request.names
    : readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  // 批次里的 manifest.json 有原始组名与标题 ⇒ 优先用它，推测只作兜底
  const manifest = (() => {
    try { return JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8')); } catch { return null; }
  })();
  const manifestBy = new Map((manifest?.items ?? []).map((it) => [it.name, it]));

  const restored = [];
  const failed = [];
  for (const name of names) {
    const from = join(src, name);
    if (!existsSync(from)) { failed.push({ name, error: '回收区里没有这一项' }); continue; }
    const group = request.group || manifestBy.get(name)?.group || guessGroup(home, name);
    const groupDir = join(p.sessions, group);
    try {
      mkdirSync(groupDir, { recursive: true });
      const to = join(groupDir, name);
      if (existsSync(to)) { failed.push({ name, error: '目标位置已存在同名会话目录' }); continue; }
      renameSync(from, to);
      restored.push({ name, restoredTo: to });
    } catch (error) {
      failed.push({ name, error: String((error && error.message) || error) });
    }
  }
  emitLog(home, { action: 'restore', batch, restored: restored.length, failed });
  return {
    ok: failed.length === 0, restored, failed,
    note: '目录已搬回。界面要看到它，索引里需要有一条归属（或点「清理幽灵」后重启 DSH）。',
  };
}

function guessGroup(home, sessionDirName) {
  // 会话头里有 cwd，但读它要解 zstd；这里按磁盘已有组目录猜：哪个组里曾经出现过同名前缀的会话，就用哪个。
  const p = paths(home);
  const key = bare(sessionDirName);
  const titles = readTitles(home, new Set([key]));
  const meta = titles.get(key);
  if (meta && meta.cwd) {
    // 组的命名规则是路径里的分隔符换成 - 并去掉盘符冒号
    const guess = '--' + meta.cwd.replace(/[:\\/]+/g, '-').replace(/-+$/, '') + '--';
    if (existsSync(join(p.sessions, guess))) return guess;
  }
  try {
    const groups = readdirSync(p.sessions, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (groups.length) return groups[0].name;
  } catch { /* fallthrough */ }
  return '--restore--';
}

/** 真删回收区：只删超过 minAgeDays 的批次（默认 30 天）。 */
export function purgeTrash(options = {}) {
  const home = options.home || dshHome();
  const p = paths(home);
  const minAgeDays = Number.isFinite(Number(options.minAgeDays)) ? Number(options.minAgeDays) : 30;
  const apply = options.apply === true;
  const listed = listTrash(home);
  const old = listed.batches.filter((b) => (b.ageDays ?? 0) >= minAgeDays);
  if (!apply) {
    return { ok: true, applied: false, dryRun: true, minAgeDays, candidates: old.map((b) => ({ batch: b.batch, sizeMB: b.sizeMB, ageDays: b.ageDays })) };
  }
  const removed = [];
  const failed = [];
  for (const b of old) {
    try { rmSync(b.dir, { recursive: true, force: true }); removed.push(b.batch); }
    catch (error) { failed.push({ batch: b.batch, error: String((error && error.message) || error) }); }
  }
  emitLog(home, { action: 'purge', minAgeDays, removed, failed });
  return { ok: failed.length === 0, applied: true, minAgeDays, removed, failed };
}

/* ------------------------------------------------------------------ 日志 */

export function emitLog(home, entry) {
  const p = paths(home);
  try {
    mkdirSync(p.logs, { recursive: true });
    writeFileSync(
      join(p.logs, 'session-del.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`,
      { encoding: 'utf8', flag: 'a' },
    );
  } catch { /* 日志失败不该让删除失败 */ }
}

export function logFile(home = dshHome()) {
  return join(paths(home).logs, 'session-del.jsonl');
}

export { basename };
