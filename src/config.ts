import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ServiceConfig {
  /** systemd: systemctl restart <name>; pm2: pm2 restart <name>; command: 原样执行 command */
  type: "systemd" | "pm2" | "command";
  name?: string;
  command?: string;
}

export interface ProjectConfig {
  /** 项目名，工具调用时的唯一标识 */
  name: string;
  description?: string;
  host: string;
  port?: number;
  username: string;
  /** SSH 私钥路径（推荐），支持 ~ 展开 */
  privateKey?: string;
  /** 密码登录（不推荐，仅内网测试机） */
  password?: string;
  /** 远端发布根目录，结构约定：<remoteRoot>/releases/<ts> + <remoteRoot>/current 软链 */
  remoteRoot: string;
  /** 默认本地构建产物目录，deploy 未传 localPath 时使用 */
  localDist?: string;
  /** 保留历史版本数，默认 5 */
  keep?: number;
  /** 部署后需要重启的服务 */
  service?: ServiceConfig;
  /** 常用日志文件路径列表（tail_log 默认取第一个） */
  logs?: string[];
  /** 部署完成后执行的远端命令 */
  postDeploy?: string[];
}

export interface OpsConfig {
  projects: ProjectConfig[];
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function findConfigPath(): string {
  const candidates = [
    process.env.OPS_MCP_CONFIG,
    path.resolve(process.cwd(), "ops.config.json"),
    path.join(os.homedir(), ".ops-mcp", "config.json"),
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `未找到配置文件，查找位置：\n  ${candidates.join("\n  ")}\n请复制 ops.config.example.json 为 ~/.ops-mcp/config.json 并填写服务器信息。`
  );
}

export function loadConfig(): OpsConfig {
  const file = findConfigPath();
  let cfg: OpsConfig;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as OpsConfig;
  } catch {
    throw new Error(`配置文件不是合法 JSON：${file}`);
  }
  if (!Array.isArray(cfg.projects) || cfg.projects.length === 0) {
    throw new Error(`配置文件必须包含非空 projects 数组：${file}`);
  }
  for (const p of cfg.projects) {
    for (const field of ["name", "host", "username", "remoteRoot"] as const) {
      if (!p[field]) {
        throw new Error(`项目缺少必填字段 ${field}：${JSON.stringify(p.name ?? p)}`);
      }
    }
    if (!p.privateKey && !p.password) {
      throw new Error(`项目 ${p.name} 必须配置 privateKey（推荐）或 password`);
    }
    if (p.service && !p.service.name && !p.service.command) {
      throw new Error(`项目 ${p.name} 的 service 配置缺少 name 或 command`);
    }
    if (p.privateKey) p.privateKey = expandHome(p.privateKey);
    p.keep = p.keep && p.keep > 0 ? p.keep : 5;
    p.port = p.port ?? 22;
  }
  return cfg;
}

export function getProject(cfg: OpsConfig, name: string): ProjectConfig {
  const hit = cfg.projects.find((p) => p.name === name);
  if (!hit) {
    throw new Error(
      `项目「${name}」不存在。可用项目：${cfg.projects.map((p) => p.name).join("、")}`
    );
  }
  return hit;
}

/** 脱敏后的项目配置（用于 MCP resource 暴露，绝不回传密钥） */
export function sanitizeProject(p: ProjectConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  if (out.password) out.password = "***";
  if (out.privateKey) out.privateKey = String(p.privateKey).replace(/./g, "*");
  return out;
}
