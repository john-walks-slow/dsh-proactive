#!/usr/bin/env node
/**
 * migrate-schedule-files.mjs — 0.2.x → 0.3.x 迁移：把旧的全局 scheduleFiles
 * 配置换成显式的文件表闹钟句柄（261009）。
 *
 * 背景：0.2.x 由 `config.scheduleFiles` glob 自动读取时间表文件，产生的
 * `decl_*` 闹钟（owner `declared-schedule`，最早的一批甚至没有 `declared`
 * 来源字段）在 0.3.x 里不属于任何句柄，会在首轮同步被当孤儿清掉、定时唤醒
 * 静默断供。本脚本为每个时间表文件写入一个 `type: "file"` 句柄闹钟；0.3.x
 * 的首轮同步随后按 `(文件, 条目 id)` 的稳定 id **领养**这些旧记录（不重建、
 * 不清除、唤醒不断供）。
 *
 * 用法（**必须先停 dsh**，否则运行中的进程会用内存状态覆盖本脚本的写入）：
 *
 *   sv stop dsh
 *   node scripts/migrate-schedule-files.mjs /root/.dsh
 *   node scripts/migrate-schedule-files.mjs /root/.dsh /root/agents/yu/.life/wake_schedule.json
 *   sv start dsh
 *
 * 只读 config.json 与 storages/workspace.json；只原子写 proactive/alarms.json。
 * 幂等：同一文件已有句柄时跳过。目标 workspace 按「文件祖父目录 = 已注册
 * workspace」判定（与插件创建句柄时的缺省规则一致）；判定不出时该文件跳过并
 * 提示改用面板 / proactive_set 显式指定 target。
 */

import { readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [homeArg, ...fileArgs] = process.argv.slice(2);
if (homeArg === undefined) {
  console.error("usage: node migrate-schedule-files.mjs <DSH_HOME> [scheduleFile...]");
  process.exit(2);
}
const home = resolve(homeArg);
const dataDir = join(home, "proactive");
const alarmsPath = join(dataDir, "alarms.json");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** glob 展开，覆盖旧配置实际用到的 `*` / `**` / `?`。 */
function globToRegExp(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:[^/]*/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(source + "$");
}

function expandGlob(pattern) {
  if (!/[*?]/.test(pattern)) {
    try {
      readFileSync(pattern);
      return [pattern];
    } catch {
      return [];
    }
  }
  const magic = pattern.search(/[*?]/);
  const base = pattern.slice(0, pattern.lastIndexOf("/", magic) + 1) || "/";
  const regexp = globToRegExp(pattern);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 16 || found.length >= 200) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && regexp.test(full)) found.push(full);
    }
  };
  walk(base, 0);
  return found;
}

/** 插件存储里的规范路径：绝对 + 去尾斜杠 + 目录 realpath。 */
function canonicalize(file) {
  const absolute = resolve(file);
  let dir = dirname(absolute);
  try {
    dir = realpathSync(dir);
  } catch {
    /* 目录还不存在时用绝对路径 */
  }
  return join(dir, basename(absolute));
}

const config = readJson(join(dataDir, "config.json"), {});
const patterns = Array.isArray(config.scheduleFiles) ? config.scheduleFiles.filter((p) => typeof p === "string") : [];
const requested = fileArgs.length > 0 ? fileArgs : patterns.flatMap(expandGlob);
if (requested.length === 0) {
  console.error("no schedule files given and config.json has no usable scheduleFiles patterns");
  process.exit(2);
}

const registry = readJson(join(home, "storages", "workspace.json"), {});
const byPath = new Map();
for (const [id, workspace] of Object.entries(registry?.tables?.workspaces ?? {})) {
  if (workspace !== null && typeof workspace === "object" && typeof workspace.path === "string") byPath.set(workspace.path, id);
}

const store = readJson(alarmsPath, undefined);
if (store === undefined || !Array.isArray(store.alarms)) {
  console.error("cannot read " + alarmsPath + " (expected { version, alarms: [] })");
  process.exit(2);
}

const nowIso = new Date().toISOString();
const defaultPrompt = typeof config.defaultPrompt === "string" && config.defaultPrompt.trim() !== ""
  ? config.defaultPrompt
  : "文件表唤醒：条目未自带 prompt 时使用。";
const timeZone = typeof config?.quietHours?.timeZone === "string" ? config.quietHours.timeZone : "Asia/Shanghai";

let added = 0;
const skipped = [];
for (const file of requested) {
  const canonical = canonicalize(file);
  const exists = store.alarms.some((alarm) => alarm?.type === "file" && alarm?.trigger?.file === canonical);
  if (exists) {
    skipped.push([canonical, "already has a handle"]);
    continue;
  }
  const workspaceDir = dirname(dirname(canonical));
  const workspaceId = byPath.get(workspaceDir);
  if (workspaceId === undefined) {
    skipped.push([canonical, "no registered workspace at " + workspaceDir + " — create the handle with an explicit target instead"]);
    continue;
  }
  store.alarms.push({
    id: "alarm_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    ownerSessionId: "declared-schedule",
    target: { mode: "resume", sourceType: "workspace", workspaceId },
    type: "file",
    trigger: { file: canonical },
    prompt: defaultPrompt,
    respectQuietHours: false,
    compaction: "minimal",
    timeZone,
    status: "scheduled",
    nextDueAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    runCount: 0,
    lastRunAt: null
  });
  added += 1;
  console.log("handle  " + canonical + "  → workspace " + workspaceId);
}

if (added > 0) {
  const tmp = alarmsPath + ".tmp.migrate." + process.pid;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  renameSync(tmp, alarmsPath);
}
console.log("\nadded " + added + " handle(s), skipped " + skipped.length);
for (const [file, why] of skipped) console.log("skip    " + file + "  (" + why + ")");
console.log("\nNext: start dsh. The first sync pass adopts the matching legacy alarms (same ids),");
console.log("so no wake entry is lost. Verify with: GET /api/dsh-proactive/state");
