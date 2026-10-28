#!/usr/bin/env node
/**
 * ops-mcp — 让 AI Agent 接管部署运维的 MCP Server
 *
 * 把「零停机原子切换发布 / 秒级回滚 / 日志巡检 / 服务重启」这套
 * 经过多台生产服务器验证的发布工程，封装为标准 MCP 工具，
 * Claude / OpenCode / Cursor 等任意 MCP 客户端即可直接调用。
 */
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { NodeSSH } from "node-ssh";
import { loadConfig, getProject, sanitizeProject, type ProjectConfig } from "./config.js";
import { connect } from "./ssh.js";
import { deploy as doDeploy, rollback as doRollback, listReleases, restartService, status as doStatus, tailLog as doTailLog } from "./deploy.js";

const cfg = loadConfig();
const server = new McpServer({ name: "ops-mcp", version: "0.1.0" });

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (e: unknown): Result => ({
  content: [{ type: "text", text: `❌ ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

async function withSsh<T>(project: string, fn: (ssh: NodeSSH, p: ProjectConfig) => Promise<T>): Promise<T> {
  const p = getProject(cfg, project);
  const ssh = await connect(p);
  try {
    return await fn(ssh, p);
  } finally {
    ssh.dispose();
  }
}

const projectParam = z.string().describe("项目名（见 list_projects / ops://projects）");

server.tool(
  "list_projects",
  "列出所有已配置的可部署项目及其目标服务器",
  {},
  async () => {
    try {
      const lines = cfg.projects.map(
        (p) => `- ${p.name}：${p.username}@${p.host}:${p.remoteRoot}${p.description ? `（${p.description}）` : ""}`
      );
      return ok(`共 ${cfg.projects.length} 个项目：\n${lines.join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "deploy",
  "部署本地构建产物到服务器：上传到时间戳版本目录后软链原子切换（零停机），自动清理旧版本并重启服务",
  {
    project: projectParam,
    localPath: z.string().optional().describe("本地构建目录（默认取项目配置 localDist，否则 ./dist）"),
    dryRun: z.boolean().optional().describe("true 时只输出执行计划，不做任何远端变更"),
  },
  async ({ project, localPath, dryRun }) => {
    try {
      const p = getProject(cfg, project);
      const local = path.resolve(localPath ?? p.localDist ?? "dist");
      if (dryRun) {
        return ok(
          [
            `[DryRun] 部署计划 — ${p.name}`,
            `  本地目录：${local}`,
            `  目标：${p.username}@${p.host}:${p.remoteRoot}/releases/<时间戳>`,
            `  切换：ln -sfn releases/<时间戳> → current（原子，零停机）`,
            `  保留：最近 ${p.keep ?? 5} 个版本，超出自动清理`,
            p.service ? `  重启：${p.service.type} ${p.service.name ?? p.service.command ?? ""}` : "  重启：未配置（静态站点）",
            (p.postDeploy ?? []).length ? `  部署后命令：${(p.postDeploy ?? []).join(" && ")}` : null,
          ].filter(Boolean).join("\n")
        );
      }
      const out = await withSsh(project, (ssh, pr) => doDeploy(ssh, pr, local));
      return ok(`✅ 部署完成\n${out}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "rollback",
  "回滚到上一个（或前 N 个）历史版本：软链切回旧版本目录并重启服务，秒级生效",
  {
    project: projectParam,
    steps: z.number().int().min(1).max(10).optional().describe("回滚几个版本，默认 1"),
  },
  async ({ project, steps }) => {
    try {
      const out = await withSsh(project, (ssh, p) => doRollback(ssh, p, steps ?? 1));
      return ok(`✅ ${out}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "list_releases",
  "列出服务器上的历史版本及当前生效版本",
  { project: projectParam },
  async ({ project }) => {
    try {
      const info = await withSsh(project, listReleases);
      if (!info.releases.length) return ok("尚无历史版本");
      const lines = info.releases.map((r) => `${r === info.current ? "→ " : "  "}${r}${r === info.current ? "（当前）" : ""}`);
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "tail_log",
  "查看服务器日志（指定文件 / 项目配置的默认日志 / systemd journal）",
  {
    project: projectParam,
    file: z.string().optional().describe("日志文件绝对路径，缺省时用项目配置的 logs[0] 或 journalctl"),
    lines: z.number().int().min(1).max(2000).optional().describe("行数，默认 100，上限 2000"),
  },
  async ({ project, file, lines }) => {
    try {
      const out = await withSsh(project, (ssh, p) => doTailLog(ssh, p, file, lines ?? 100));
      return ok(out || "（日志为空）");
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "restart",
  "重启项目服务（systemd / pm2 / 自定义命令）",
  { project: projectParam },
  async ({ project }) => {
    try {
      const out = await withSsh(project, restartService);
      return ok(`✅ ${out}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "status",
  "查看项目部署状态：当前版本、历史版本、服务活性、磁盘余量、最近部署/回滚记录",
  { project: projectParam },
  async ({ project }) => {
    try {
      const out = await withSsh(project, doStatus);
      return ok(out);
    } catch (e) {
      return fail(e);
    }
  }
);

server.resource("projects", "ops://projects", async (uri) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(cfg.projects.map(sanitizeProject), null, 2),
    },
  ],
}));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[ops-mcp] ready，已加载 ${cfg.projects.length} 个项目`);
}

main().catch((e) => {
  console.error("[ops-mcp] 启动失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
