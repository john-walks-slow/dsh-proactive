#!/usr/bin/env node
/**
 * dsh-remote-unlock —— DSH 远程解锁补丁的持久化 keeper
 *
 * 校验和锚定的幂等补丁管理：
 *   - 文件 == patchedSha          → 已打好
 *   - 文件 == baseSha             → 待打（--apply 时精确替换 old→new，逐字节校验后写回）
 *   - 其他                        → 漂移（升级改了上游代码），大声警告，绝不乱打
 *
 * 用法：
 *   node apply.mjs --apply [--silent]   默认：打上所有"待打"，漂移只警告（boot 安全：降级但活着）
 *   node apply.mjs --check [--silent]   验证：任一不是"已打"即退出码 1
 *   node apply.mjs --status             打印状态表，退出码恒 0
 *   node apply.mjs --strict             在 --apply 下漂移也返回非零（给 CI 用）
 *   node apply.mjs --reanchor           交互式重锚定（上游代码变动后重建 spec）
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = process.env.DSH_REMOTE_UNLOCK_SPEC || join(here, 'spec.mjs');
const STATE = process.env.DSH_REMOTE_UNLOCK_STATE || join(here, 'state.json');

const args = new Set(process.argv.slice(2));
const mode = args.has('--check') ? 'check' : args.has('--status') ? 'status' : args.has('--reanchor') ? 'reanchor' : 'apply';
const silent = args.has('--silent');
const strict = args.has('--strict');

const sha = (content) => createHash('sha256').update(content).digest('hex');
const info = (msg) => { if (!silent) console.log(`[dsh-remote-unlock] ${msg}`); };
const warn = (msg) => console.error(`[dsh-remote-unlock] WARN ${msg}`);
const fail = (msg) => { console.error(`[dsh-remote-unlock] FAIL ${msg}`); process.exit(2); };

const spec = (await import(SPEC)).default;
if (!Array.isArray(spec.patches) || spec.patches.length === 0) fail(`spec ${SPEC} has no patches`);

/** 判定并（可选）应用单个补丁。返回 { file, state, warn? } */
function handle(entry) {
	const { file, baseSha, patchedSha, old, new: next } = entry;
	if (typeof baseSha !== 'string' || typeof patchedSha !== 'string' || typeof old !== 'string' || typeof next !== 'string') {
		return { file, state: 'invalid-spec' };
	}
	let content;
	try {
		content = readFileSync(file, 'utf8');
	} catch {
		return { file, state: 'missing' };
	}
	const cur = sha(content);
	if (cur === patchedSha) return { file, state: 'patched' };
	if (cur === baseSha) {
		if (mode === 'check' || mode === 'status' || mode === 'reanchor') return { file, state: 'pending' };
		const count = content.split(old).length - 1;
		if (count !== 1) fail(`${file}: old-string 出现 ${count} 次（应为 1），spec 失效，拒绝写入`);
		const patched = content.replace(old, next);
		if (sha(patched) !== patchedSha) fail(`${file}: 替换结果与 patchedSha 不符，spec 内部不一致，拒绝写入`);
		writeFileSync(file, patched, 'utf8');
		return { file, state: 'just-patched' };
	}
	return { file, state: 'drifted', cur };
}

/** 交互式重锚定：把当前文件的当前内容记为新 base，并求出把旧补丁文本替换后的结果。 */
async function reanchor() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask = (q) => new Promise((r) => rl.question(q, r));
	for (const entry of spec.patches) {
		const file = entry.file;
		let content;
		try { content = readFileSync(file, 'utf8'); } catch { warn(`${file}: 不存在，跳过`); continue; }
		const curSha = sha(content);
		if (curSha === entry.patchedSha) { info(`${file}: 已是补丁态，保持原 spec`); continue; }
		const oldCount = content.split(entry.old).length - 1;
		if (oldCount !== 1) { warn(`${file}: old 文本未找到或出现多次，跳过（可能需要手工更新 spec.mjs）`); continue; }
		const answer = await ask(`${file}\n  当前 sha=${curSha}\n  将把此内容作为新 baseSha 并把补丁文本替换后作为新 patchedSha。继续？[y/N] `);
		if (answer.trim().toLowerCase() !== 'y') { info(`${file}: 跳过`); continue; }
		const patched = content.replace(entry.old, entry.new);
		entry.baseSha = curSha;
		entry.patchedSha = sha(patched);
		info(`${file}: 已重锚定（base=${curSha.slice(0, 12)}… patched=${entry.patchedSha.slice(0, 12)}…）`);
	}
	rl.close();
	const out = `/** 由 --reanchor 于 ${new Date().toISOString()} 重建 */\nexport default ${JSON.stringify(spec, null, '\t')};\n`;
	writeFileSync(SPEC, out, 'utf8');
	info(`spec 已写回 ${SPEC}`);
}

if (mode === 'reanchor') {
	await reanchor();
	process.exit(0);
}

const rows = handle ? spec.patches.map(handle) : [];
let problems = 0;
for (const row of rows) {
	if (row.state === 'patched' || row.state === 'just-patched') continue;
	problems += 1;
	if (row.state === 'drifted') warn(`${row.file}: 内容漂移（sha=${row.cur?.slice(0, 12)}…），可能是升级改了上游代码。见 README「漂移处理」。`);
	if (row.state === 'missing') warn(`${row.file}: 文件不存在（升级中？）`);
	if (row.state === 'invalid-spec') warn(`${row.file}: spec 条目不完整`);
}
if (mode === 'status') {
	console.log('--- 状态 ---');
	for (const row of rows) console.log(`${row.state.padEnd(12)} ${row.file}`);
	process.exit(0);
}
if (mode === 'check') {
	if (problems === 0) info('全部补丁在位 ✓');
	else warn(`${problems} 个补丁未生效`);
	process.exit(problems === 0 ? 0 : 1);
}
// apply
const changed = rows.filter((r) => r.state === 'just-patched').length;
if (changed > 0) {
	const stamp = { appliedAt: new Date().toISOString(), entries: Object.fromEntries(rows.map((r) => [r.file, r.state])) };
	writeFileSync(STATE, JSON.stringify(stamp, null, 2) + '\n', 'utf8');
	info(`已打 ${changed} 个补丁；状态记入 ${STATE}`);
} else {
	info(`无需改动（${rows.length} 个目标：${rows.map((r) => r.state).join(', ')}）`);
}
if (problems > 0 && strict) process.exit(1);
process.exit(0);