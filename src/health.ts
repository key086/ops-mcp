import type { NodeSSH } from "node-ssh";
import type { HealthCheckConfig, ProjectConfig } from "./config.js";
import { tryRun } from "./ssh.js";

export interface HealthResult {
  healthy: boolean;
  attempts: Array<{ attempt: number; status: string; ok: boolean }>;
}

const sleep = (sec: number) => new Promise((r) => setTimeout(r, sec * 1000));

/**
 * 在远端服务器上用 curl 探测健康检查 URL（支持仅内网可达的地址）。
 * 失败自动重试；全部失败判定为不健康，由调用方决定是否自动回滚。
 */
export async function runHealthCheck(
  ssh: NodeSSH,
  p: ProjectConfig,
  hc: HealthCheckConfig
): Promise<HealthResult> {
  const expect = hc.expectStatus ?? 200;
  const timeout = hc.timeoutSec ?? 5;
  const retries = hc.retries ?? 3;
  const interval = hc.intervalSec ?? 3;
  const attempts: HealthResult["attempts"] = [];

  for (let i = 1; i <= retries; i++) {
    const status = await tryRun(
      ssh,
      `curl -s -o /dev/null -w '%{http_code}' --max-time ${timeout} '${hc.url}'`
    );
    const ok = status === String(expect);
    attempts.push({ attempt: i, status: status || "无响应", ok });
    if (ok) return { healthy: true, attempts };
    if (i < retries) await sleep(interval);
  }
  return { healthy: false, attempts };
}

export function formatHealthResult(r: HealthResult): string {
  return r.attempts
    .map((a) => `  第${a.attempt}次探测: HTTP ${a.status} ${a.ok ? "✓" : "✗"}`)
    .join("\n");
}
