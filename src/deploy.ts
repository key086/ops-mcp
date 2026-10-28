import fs from "node:fs";
import path from "node:path";
import type { NodeSSH } from "node-ssh";
import type { ProjectConfig } from "./config.js";
import { run, tryRun } from "./ssh.js";

/**
 * 发布目录结构约定（零停机原子切换）：
 *
 *   <remoteRoot>/
 *   ├── releases/
 *   │   ├── 20261028-101500/   ← 每次部署一个时间戳目录
 *   │   ├── 20261027-183012/
 *   │   └── ...
 *   ├── current -> releases/20261028-101500   ← ln -sfn 原子切换
 *   └── .ops-history.log                      ← 部署/回滚审计日志
 *
 * Nginx root 指向 <remoteRoot>/current，切换软链即完成发布，全程无停机。
 */

export function releaseId(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface ReleaseInfo {
  releases: string[];
  current: string | null;
}

export async function listReleases(ssh: NodeSSH, p: ProjectConfig): Promise<ReleaseInfo> {
  const root = p.remoteRoot;
  const raw = await tryRun(ssh, `mkdir -p ${root}/releases && ls -1t ${root}/releases`);
  const releases = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const link = await tryRun(ssh, `readlink ${root}/current`);
  const current = link ? path.posix.basename(link) : null;
  return { releases, current };
}

async function switchRelease(ssh: NodeSSH, p: ProjectConfig, id: string): Promise<void> {
  const root = p.remoteRoot;
  await run(
    ssh,
    `set -e; test -d ${root}/releases/${id}; ln -sfn ${root}/releases/${id} ${root}/current`
  );
}

async function recordHistory(ssh: NodeSSH, p: ProjectConfig, action: string, detail: string): Promise<void> {
  await tryRun(
    ssh,
    `echo "$(date '+%F %T') ${action} ${detail}" >> ${p.remoteRoot}/.ops-history.log`
  );
}

async function pruneReleases(ssh: NodeSSH, p: ProjectConfig): Promise<number> {
  const keep = p.keep ?? 5;
  const before = await listReleases(ssh, p);
  await tryRun(
    ssh,
    `cd ${p.remoteRoot}/releases && ls -1t | tail -n +${keep + 1} | xargs -r rm -rf`
  );
  const after = await listReleases(ssh, p);
  return before.releases.length - after.releases.length;
}

export async function restartService(ssh: NodeSSH, p: ProjectConfig): Promise<string> {
  const s = p.service;
  if (!s) return "未配置 service，跳过重启（纯静态站点无需重启）";
  if (s.type === "systemd" && s.name) {
    await run(ssh, `systemctl restart ${s.name} 2>/dev/null || sudo -n systemctl restart ${s.name}`);
    const active = await tryRun(ssh, `systemctl is-active ${s.name}`);
    return `systemd ${s.name} 已重启（状态：${active || "unknown"}）`;
  }
  if (s.type === "pm2" && s.name) {
    await run(ssh, `pm2 restart ${s.name} --update-env`);
    return `pm2 ${s.name} 已重启`;
  }
  if (s.type === "command" && s.command) {
    const out = await run(ssh, s.command);
    return `自定义重启命令执行完成${out ? `：\n${out}` : ""}`;
  }
  return "service 配置不完整，跳过重启";
}

export async function deploy(ssh: NodeSSH, p: ProjectConfig, localDist: string): Promise<string> {
  const abs = path.resolve(localDist);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`本地构建目录不存在：${abs}`);
  }
  const id = releaseId();
  const target = `${p.remoteRoot}/releases/${id}`;
  const log: string[] = [`版本：${id}`, `来源：${abs}`];

  await run(ssh, `mkdir -p ${target}`);
  log.push(`→ 创建远端目录 ${target}`);

  const uploaded = await ssh.putDirectory(abs, target, { recursive: true, concurrency: 8 });
  if (!uploaded) throw new Error("上传构建产物失败，请检查网络与目录权限");
  log.push("→ 构建产物上传完成");

  await switchRelease(ssh, p, id);
  log.push(`→ 原子切换 current → releases/${id}（零停机）`);

  const pruned = await pruneReleases(ssh, p);
  log.push(`→ 清理旧版本 ${pruned} 个，保留最近 ${p.keep ?? 5} 个`);

  log.push(`→ ${await restartService(ssh, p)}`);

  for (const cmd of p.postDeploy ?? []) {
    const out = await run(ssh, cmd);
    log.push(`→ postDeploy「${cmd}」${out ? `：\n${out}` : "完成"}`);
  }

  await recordHistory(ssh, p, "DEPLOY", id);
  return log.join("\n");
}

export async function rollback(ssh: NodeSSH, p: ProjectConfig, steps: number): Promise<string> {
  const { releases, current } = await listReleases(ssh, p);
  if (releases.length < 2) throw new Error("历史版本不足，无法回滚");
  const idx = current ? releases.indexOf(current) : -1;
  const targetIdx = Math.max(idx, 0) + steps;
  if (targetIdx >= releases.length) {
    throw new Error(`最多回滚到最早版本 ${releases[releases.length - 1]}（共 ${releases.length} 个版本）`);
  }
  const target = releases[targetIdx];
  await switchRelease(ssh, p, target);
  const restartMsg = await restartService(ssh, p);
  await recordHistory(ssh, p, "ROLLBACK", `${current ?? "unknown"} -> ${target}`);
  return [`回滚：${current ?? "unknown"} → ${target}`, `→ ${restartMsg}`].join("\n");
}

export async function status(ssh: NodeSSH, p: ProjectConfig): Promise<string> {
  const { releases, current } = await listReleases(ssh, p);
  const lines: string[] = [
    `项目：${p.name}（${p.username}@${p.host}）`,
    `根目录：${p.remoteRoot}`,
    `当前版本：${current ?? "（未部署）"}`,
    `历史版本：${releases.length} 个${releases.length ? `（${releases.slice(0, 5).join("、")}${releases.length > 5 ? " …" : ""}）` : ""}`,
  ];
  if (p.service?.type === "systemd" && p.service.name) {
    lines.push(`服务状态：${await tryRun(ssh, `systemctl is-active ${p.service.name}`) || "unknown"}`);
  } else if (p.service?.type === "pm2" && p.service.name) {
    lines.push(`pm2 状态：\n${await tryRun(ssh, `pm2 describe ${p.service.name} | head -20`)}`);
  }
  const disk = await tryRun(ssh, `df -h ${p.remoteRoot} | tail -1`);
  if (disk) lines.push(`磁盘：${disk}`);
  const history = await tryRun(ssh, `tail -5 ${p.remoteRoot}/.ops-history.log`);
  if (history) lines.push(`最近操作：\n${history}`);
  return lines.join("\n");
}

export async function tailLog(ssh: NodeSSH, p: ProjectConfig, file: string | undefined, n: number): Promise<string> {
  if (file) return run(ssh, `tail -n ${n} ${file}`);
  if (p.logs?.length) {
    return run(ssh, `tail -n ${n} ${p.logs[0]}`);
  }
  if (p.service?.type === "systemd" && p.service.name) {
    return run(ssh, `journalctl -u ${p.service.name} -n ${n} --no-pager`);
  }
  throw new Error("请通过 file 参数指定日志路径，或在项目配置中声明 logs / systemd service");
}
