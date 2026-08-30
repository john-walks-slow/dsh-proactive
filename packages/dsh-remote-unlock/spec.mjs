/**
 * dsh-remote-unlock 补丁规格（spec.mjs 而非 JSON，避免转义地狱）
 *
 * 每个补丁条目三要素：
 * - baseSha     : 原文件（未打补丁）的 sha256 —— 升级后新文件若等于 baseSha 就是"待打"
 * - patchedSha  : 打完补丁后的 sha256 —— 当前文件等于它即"已打"
 * - old/new     : 精确文本替换（old 必须在 base 中恰好出现一次）
 *
 * 重锚定方法（上游代码变了导致 drifted）：
 *   1. 把 node_modules 里的文件恢复成未打补丁状态（或用 .bak-remote-unlock-* 备份）
 *   2. 跑 `node apply.mjs --reanchor` 生成新的 spec（交互式，二次确认）
 */
export default {
	package: 'dsh-remote-unlock',
	note: 'bypasses the DSH loopback-only configuration plane for the declared trusted host (owner waived auth, 2026-08-30)',
	patches: [
		{
			file: '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js',
			baseSha: '450888f220a348190f3043986737ed2ea04a39f11e67e2d16abb26c2f96f8815',
			patchedSha: '84f993924e312dc31179c8ba309e52279ca61bf86b795052c3d2b4d5bb1ea0e1',
			old: 'if (method !== void 0 && PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, [])) return new Response("forbidden", { status: 403 });',
			new: 'if (method !== void 0 && PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, trustedHosts)) return new Response("forbidden", { status: 403 }); /* deployment patch: privileged methods now ride the deployment trustedHosts fence (owner waived the loopback-only restriction) */'
		},
		{
			file: '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js',
			baseSha: '0735d9af8a012d1edb19a02c4cef50903a783cdb28eac8b62fe9141625592845',
			patchedSha: 'bfabeb94ee8b2346bda82a47989276e86cb265262919e9d84e6079caf164466f',
			old: 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
			new: 'isLoopback: true /* deployment patch: remote full-function (owner waived the loopback-only gate) */,'
		}
	]
};