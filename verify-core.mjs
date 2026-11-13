/**
 * @local/session-del 自测（不碰真实会话：全部在临时 DSH_HOME 里造夹具）。
 *   node verify-core.mjs
 * 判据：删除必须真的把目录移到回收区、索引回读确认、恢复能搬回原位、幽灵能剔除。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteSessions, dshHome, listSessions, listTrash, purgeTrash, restoreTrash, syncGhosts, bare,
} from './lib/core.js';

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(`${name} :: ${detail || ''}`); console.log(`  FAIL ${name} :: ${detail || ''}`); }
}

const home = mkdtempSync(join(tmpdir(), 'session-del-verify-'));
const WS = 'ws-0001';
const GROUP = '--C-Users-Test-project--';

function seed() {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'sessions', GROUP), { recursive: true });
  mkdirSync(join(home, 'storages'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  // 三个磁盘会话：A 可见、B 归档、C 置顶
  for (const [dir, bytes] of [['session-aaaa1111-0000-0000-0000-000000000001', 1200], ['session-bbbb2222-0000-0000-0000-000000000002', 2400], ['session-cccc3333-0000-0000-0000-000000000003', 800]]) {
    mkdirSync(join(home, 'sessions', GROUP, dir), { recursive: true });
    writeFileSync(join(home, 'sessions', GROUP, dir, 'session.v4.jsonl.zstd'), 'x'.repeat(bytes));
  }
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: 'global',
    global: {
      initialized: true,
      defaultWorkspaceId: WS,
      workspaceIds: [WS],
      archivedSessionIds: ['session-bbbb2222-0000-0000-0000-000000000002', 'session-ghost0-0000-0000-0000-00000000000f'],
      pinnedSessionIds: ['session-cccc3333-0000-0000-0000-000000000003'],
    },
    tables: {
      workspaces: {
        [WS]: {
          title: 'test-ws', path: 'C:\\Users\\Test\\project',
          sessionIds: [
            'session-aaaa1111-0000-0000-0000-000000000001',
            'session-bbbb2222-0000-0000-0000-000000000002',
            'session-cccc3333-0000-0000-0000-000000000003',
            'session-ghost0-0000-0000-0000-00000000000f',
          ],
        },
      },
    },
  }, null, 2), 'utf8');
  writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
    tables: { sessions: {
      'session-aaaa1111-0000-0000-0000-000000000001': { identity: { createdAt: 1, cwd: 'C:\\Users\\Test\\project' }, rows: { title: { val: '旧世代单文件标题' } } },
    } },
  }), 'utf8');
  // 新世代（v7 per-record）标题落点：storages/session_projcache/sessions/<uuid>.json
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', 'aaaa1111-0000-0000-0000-000000000001.json'),
    JSON.stringify({ version: 7, record: { identity: { cwd: 'C:\\Users\\Test\\project', createdAt: 11 }, rows: { title: { ver: 1, seq: 1, val: '第一个会话' } } } }), 'utf8');
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', 'bbbb2222-0000-0000-0000-000000000002.json'),
    JSON.stringify({ version: 7, record: { identity: { cwd: 'C:\\Users\\Test\\project', createdAt: 12 }, rows: { title: { ver: 1, seq: 1, val: '归档待删' } } } }), 'utf8');
  // 写入中的临时文件不该被当标题读
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', '.1111.tmp'), '{ broken', 'utf8');
  // 磁盘上有目录但标题记录缺失
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', 'cccc3333-0000-0000-0000-000000000003.json'),
    JSON.stringify({ version: 7, record: { identity: { cwd: 'C:\\Users\\Test\\project' }, rows: { title: { ver: 1, seq: 1, val: '置顶那个' } } } }), 'utf8');
}

console.log('=== 1. 扫描与合并 ===');
seed();
const listed = listSessions(home);
check('列出 3 个磁盘会话 + 1 个幽灵', listed.sessions.length === 4, `got ${listed.sessions.length}`);
check('totals.disk=3', listed.totals.disk === 3, String(listed.totals.disk));
check('totals.archived=1(磁盘上的)', listed.totals.archived === 1, String(listed.totals.archived));
check('totals.pinned=1', listed.totals.pinned === 1, String(listed.totals.pinned));
check('totals.ghost=1', listed.totals.ghost === 1, String(listed.totals.ghost));
const a = listed.sessions.find((s) => s.key === 'aaaa1111-0000-0000-0000-000000000001');
check('标题从新世代 per-record 取到', a && a.title === '第一个会话', JSON.stringify(a && a.title));
check('大小 MB 计算（1200B → 0）', a && a.sizeMB === 0, String(a && a.sizeMB));
const c = listed.sessions.find((s) => s.key === 'cccc3333-0000-0000-0000-000000000003');
check('第三个也有标题', c && c.title === '置顶那个', JSON.stringify(c && c.title));
check('标题记录没漏读（3 个标题都在）', listed.sessions.filter((s) => !s.ghost && s.title).length === 3,
  JSON.stringify(listed.sessions.map((s) => s.title)));
check('.tmp 不会被当标题', !listed.sessions.some((s) => /broken/.test(s.title || '')));

console.log('=== 2. 删除：预演不动盘 ===');
const dry = deleteSessions(['aaaa1111'], { home, apply: false });
check('预演 ok 且 applied=false', dry.ok === true && dry.applied === false, JSON.stringify(dry).slice(0, 200));
check('预演后目录仍在', existsSync(join(home, 'sessions', GROUP, 'session-aaaa1111-0000-0000-0000-000000000001')));
check('预演计划含 1 条', dry.plan.length === 1, String(dry.plan.length));

console.log('=== 3. 删除：真删（移到回收区）===');
const real = deleteSessions(['aaaa1111'], { home, apply: true });
check('真删 ok，moved=1', real.ok === true && real.moved === 1, JSON.stringify(real).slice(0, 300));
check('原目录已移走', !existsSync(join(home, 'sessions', GROUP, 'session-aaaa1111-0000-0000-0000-000000000001')));
check('回收区有它', existsSync(join(real.trashDir, 'session-aaaa1111-0000-0000-0000-000000000001')));
check('索引备份存在', real.indexBackup && existsSync(real.indexBackup), String(real.indexBackup));
const afterIdx = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'));
check('索引里已剔除该 id', !afterIdx.tables.workspaces[WS].sessionIds.map(bare).includes('aaaa1111-0000-0000-0000-000000000001'));
check('批次 manifest 已写', existsSync(join(real.trashDir, 'manifest.json')));
const mf = JSON.parse(readFileSync(join(real.trashDir, 'manifest.json'), 'utf8'));
check('manifest 记了原组名', mf.items[0].group === GROUP, mf.items[0].group);
check('日志已写', existsSync(join(home, 'logs', 'session-del.jsonl')));

console.log('=== 4. 置顶保护 ===');
const pinnedTry = deleteSessions(['cccc3333'], { home, apply: true });
check('置顶被跳过', pinnedTry.skipped.length === 1 && pinnedTry.moved === undefined, JSON.stringify(pinnedTry).slice(0, 200));
check('置顶目录还在', existsSync(join(home, 'sessions', GROUP, 'session-cccc3333-0000-0000-0000-000000000003')));
const pinnedForce = deleteSessions(['cccc3333'], { home, apply: true, includePinned: true });
check('勾选后可删置顶', pinnedForce.moved === 1, JSON.stringify(pinnedForce).slice(0, 200));
const idx2 = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'));
check('置顶集已剔除', !idx2.global.pinnedSessionIds.map(bare).includes('cccc3333-0000-0000-0000-000000000003'));

console.log('=== 5. 歧义与找不到 ===');
const amb = deleteSessions(['zzzz'], { home, apply: false });
check('找不到会报问题', amb.problems.length === 1 && amb.problems[0].problem === '找不到', JSON.stringify(amb.problems));

console.log('=== 6. 幽灵清理 ===');
const gDry = syncGhosts({ home, apply: false });
check('预演列出幽灵', gDry.applied === false && gDry.count >= 1, JSON.stringify(gDry).slice(0, 200));
const gReal = syncGhosts({ home, apply: true });
check('真清幽灵', gReal.applied === true && gReal.removed >= 1, JSON.stringify(gReal).slice(0, 200));
const idx3 = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'));
check('归档集里幽灵已没', !idx3.global.archivedSessionIds.map(bare).includes('ghost0-0000-0000-0000-00000000000f'));

console.log('=== 7. 回收区与恢复 ===');
const trash = listTrash(home);
check('回收区列出批次', trash.batches.length >= 1, String(trash.batches.length));
const batch = trash.batches[0].batch;
const restored = restoreTrash({ batch, names: ['session-aaaa1111-0000-0000-0000-000000000001'] }, { home });
check('恢复成功', restored.ok === true && restored.restored.length === 1, JSON.stringify(restored).slice(0, 300));
check('目录回到原组', existsSync(join(home, 'sessions', GROUP, 'session-aaaa1111-0000-0000-0000-000000000001')));

console.log('=== 8. 回收区超期真删 ===');
const pDry = purgeTrash({ home, apply: false, minAgeDays: 30 });
check('超期预演（新批次不该被删）', pDry.candidates.length === 0, JSON.stringify(pDry.candidates));
const pReal = purgeTrash({ home, apply: true, minAgeDays: 0 });
check('minAgeDays=0 真删', pReal.applied === true && pReal.removed.length >= 1, JSON.stringify(pReal).slice(0, 200));

console.log('=== 9. 索引损坏时不静默 ===');
writeFileSync(join(home, 'storages', 'workspace.json'), '{ not json', 'utf8');
const broken = listSessions(home);
check('解析失败会如实报告', broken.ok === false && /解析失败/.test(broken.indexError || ''), String(broken.indexError));

console.log('=== 9b. 标题源回落（新世代目录不存在时读单文件）===');
rmSync(join(home, 'storages', 'session_projcache'), { recursive: true, force: true });
seed2();
function seed2() {
  mkdirSync(join(home, 'sessions', GROUP), { recursive: true });
  mkdirSync(join(home, 'storages'), { recursive: true });
  mkdirSync(join(home, 'sessions', GROUP, 'session-aaaa1111-0000-0000-0000-000000000001'), { recursive: true });
  writeFileSync(join(home, 'sessions', GROUP, 'session-aaaa1111-0000-0000-0000-000000000001', 'session.v4.jsonl.zstd'), 'x');
}
const fallback = listSessions(home);
const fa = fallback.sessions.find((s) => s.key === 'aaaa1111-0000-0000-0000-000000000001');
check('回落到单文件 projcache', fa && fa.title === '旧世代单文件标题', JSON.stringify(fa && fa.title));
check('mtime 取整树最新文件（不是目录 mtime）', fa && fa.mtime > 0, String(fa && fa.mtime));

console.log('=== 10. DSH_HOME 推导 ===');
const saved = process.env.DSH_HOME;
process.env.DSH_HOME = 'E:\\.deepseekharness\\1-DSH程序\\.dsh';
check('DSH_HOME 优先', dshHome() === 'E:\\.deepseekharness\\1-DSH程序\\.dsh', dshHome());
if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
delete process.env.DSH_HOME;
const guessed = dshHome();
// 本模块在 <作者目录>\session-del-plugin\lib（不是 <X>\plugins\<pkg> 布局），
// 所以正确行为是回落到 ~/.dsh —— 关键是它不能乱捡无关目录。U 盘那种 plugins 布局
// 的推断单独验（见下面 10b）。
check('无 DSH_HOME 时回落到 ~/.dsh（本模块不在 plugins 布局下）', guessed === join(homedir(), '.dsh'), `推断=${guessed}`);
check('推断结果确实存在', existsSync(guessed), guessed);

console.log('=== 10b. U-DSH 布局推断：<X>/1-DSH程序/plugins/<pkg>/lib/core.js → <X>/1-DSH程序/.dsh ===');
const uroot = mkdtempSync(join(tmpdir(), 'udsh-fake-'));
mkdirSync(join(uroot, '1-DSH程序', '.dsh'), { recursive: true });
mkdirSync(join(uroot, '1-DSH程序', 'plugins', 'sd-test', 'lib'), { recursive: true });
copyFileSync(join(homedir(), '.deepseekharness', 'session-del-plugin', 'lib', 'core.js'),
  join(uroot, '1-DSH程序', 'plugins', 'sd-test', 'lib', 'core.js'));
const uCore = await import(pathToFileUrl(join(uroot, '1-DSH程序', 'plugins', 'sd-test', 'lib', 'core.js')));
const uHome = uCore.dshHome();
check('U-DSH 布局下推断到 <X>/1-DSH程序/.dsh', uHome === join(uroot, '1-DSH程序', '.dsh'), `推断=${uHome}`);
check('<X>/.dsh 存在', existsSync(join(uroot, '1-DSH程序', '.dsh')));
rmSync(uroot, { recursive: true, force: true });
rmSync(uroot, { recursive: true, force: true });

rmSync(home, { recursive: true, force: true });
console.log('');
console.log(`结果：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ' + f); process.exit(1); }

function pathToFileUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }
