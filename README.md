# ops-mcp

**让 AI Agent 接管你的服务器发布运维。**
Zero-downtime deploys, instant rollbacks, log inspection and service restarts — exposed as [MCP](https://modelcontextprotocol.io) tools for Claude, OpenCode, Cursor and any MCP client.

> 源自真实生产环境：一位全栈工程师用 Shell + Expect 维护 7 台云服务器、30+ 发布脚本多年后，把这套「时间戳版本目录 + 软链原子切换」的发布工程重写为标准 MCP Server。现在你可以直接对 AI 说：*"把 admin-web 发一下"*、*"刚才那次发布有问题，回滚"*、*"看下网关日志最后 200 行"*。

## 特性

- 🚀 **零停机发布** — 构建产物上传至 `releases/<时间戳>`，`ln -sfn` 原子切换 `current` 软链，Nginx 无感知
- ⏪ **秒级回滚** — 保留最近 N 个版本，一条指令切回任意历史版本
- 🩺 **健康检查 + 自动回滚** — 部署后在远端探测健康 URL（支持内网地址），失败自动切回上一版本，把故障时间压到秒级
- 📣 **群机器人通知** — 部署/回滚/健康检查失败自动推送飞书（支持加签）/ 钉钉 / 企业微信 / Slack
- 🔍 **日志巡检** — tail 远端日志 / systemd journal，AI 直接读日志定位问题
- 🔁 **服务重启** — systemd / pm2 / 自定义命令统一抽象
- 🧾 **审计日志** — 每次部署/回滚写入远端 `.ops-history.log`，谁让 AI 干了什么有据可查
- 🛡️ **凭据不出本机** — 密钥/密码只存在于本地配置文件，任何工具输出与 MCP resource 均自动脱敏；支持 `dryRun` 先看计划再执行
- 📦 **零依赖服务端** — 服务器端不需要安装任何东西，只要能 SSH

## 工作原理

```
<remoteRoot>/
├── releases/
│   ├── 20261028-101500/     ← 每次部署一个时间戳目录
│   ├── 20261027-183012/
│   └── ...（保留最近 keep 个，自动清理）
├── current -> releases/20261028-101500    ← ln -sfn 原子切换（发布点）
└── .ops-history.log                       ← 部署/回滚审计日志
```

Nginx `root` 指向 `current`，软链切换是原子的，用户请求无感知；回滚只是把软链指回旧目录。

## 安装

```bash
npm install -g ops-mcp
# 或不安装直接用
npx -y ops-mcp
```

## 配置

复制 [ops.config.example.json](./ops.config.example.json) 到 `~/.ops-mcp/config.json`：

```jsonc
{
  "projects": [
    {
      "name": "admin-web",                  // 项目名（AI 调用时的标识）
      "description": "运营管理后台（React SPA）",
      "host": "203.0.113.10",
      "username": "deploy",
      "privateKey": "~/.ssh/id_ed25519",    // 推荐密钥登录
      "remoteRoot": "/data/www/admin-web",  // Nginx root 指向 <remoteRoot>/current
      "localDist": "./dist",                // 默认上传的本地构建目录
      "keep": 5,                            // 保留历史版本数
      "logs": ["/var/log/nginx/admin-web.access.log"]
    },
    {
      "name": "api-server",
      "description": "Java 服务（systemd 托管）",
      "host": "203.0.113.11",
      "username": "deploy",
      "privateKey": "~/.ssh/id_ed25519",
      "remoteRoot": "/data/app/api-server",
      "service": { "type": "systemd", "name": "api-server" },  // 部署后自动重启
      "healthCheck": {                                          // 部署后健康检查
        "url": "http://127.0.0.1:8080/actuator/health",
        "expectStatus": 200,
        "retries": 3,
        "intervalSec": 3
      },
      "autoRollback": true,                                     // 检查失败自动回滚（默认开启）
      "notify": {                                               // 结果推送群机器人
        "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
        "secret": "飞书加签密钥（可选）"
      },
      "keep": 3
    }
  ]
}
```

配置文件查找顺序：`$OPS_MCP_CONFIG` → `./ops.config.json` → `~/.ops-mcp/config.json`。

## 接入 MCP 客户端

**Claude Desktop** (`claude_desktop_config.json`)：

```json
{
  "mcpServers": {
    "ops": {
      "command": "npx",
      "args": ["-y", "ops-mcp"]
    }
  }
}
```

**OpenCode** (`opencode.json`)：

```json
{
  "mcp": {
    "ops": {
      "type": "local",
      "command": ["npx", "-y", "ops-mcp"],
      "enabled": true
    }
  }
}
```

然后直接对 AI 说人话：

> "把 admin-web 发一下，先 dryRun 给我看计划"
> "线上 502 了，看下 api-server 日志最后 200 行，找出原因，需要的话回滚"

## 工具一览

| 工具 | 说明 |
|---|---|
| `list_projects` | 列出所有已配置项目 |
| `deploy` | 零停机部署（支持 `dryRun` 预览执行计划） |
| `rollback` | 回滚到前 N 个版本，自动重启服务 |
| `list_releases` | 查看历史版本与当前生效版本 |
| `health_check` | 手动触发健康探测（远端执行，支持内网 URL） |
| `tail_log` | 查看远端日志 / systemd journal |
| `restart` | 重启服务（systemd / pm2 / 自定义命令） |
| `status` | 当前版本、服务活性、磁盘余量、最近操作记录 |
| `ops://projects`（resource） | 脱敏后的项目配置，供 Agent 了解环境 |

## 安全设计

- 私钥/密码仅存于本地配置，**永不出现在任何工具输出、日志与 MCP resource 中**（`sanitizeProject` 强制脱敏）
- `deploy` 支持 `dryRun`，配合 MCP 客户端的工具审批机制，危险操作先预览后执行
- 服务器端零安装、零守护进程，攻击面与普通 SSH 运维一致
- 建议为部署单独建低权限系统账户，只授予发布目录写权限与 `systemctl restart <指定服务>` 的 sudoers 白名单

## Roadmap

- [x] 部署后健康检查（HTTP probe 失败自动回滚）
- [x] 飞书（含加签）/ 钉钉 / 企业微信 / Slack 部署通知
- [ ] 多主机灰度发布（canary：先切一台观察再全量）
- [ ] Docker 镜像发布模式（build → push → 远端 pull & up）
- [ ] Web 控制台模式（SSE 实时部署日志，浏览器可看）

欢迎 issue / PR。

## 开发

```bash
git clone https://github.com/key086/ops-mcp && cd ops-mcp
npm install
npm run build
OPS_MCP_CONFIG=./ops.config.example.json npm start   # 本地调试
```

## License

[MIT](./LICENSE) © Liu Xinfeng (key086)
