import crypto from "node:crypto";
import type { NotifyConfig } from "./config.js";

/**
 * 群机器人部署通知：自动识别 webhook 类型
 * - 飞书/Lark：open.feishu.cn / larksuite.com（支持加签 secret）
 * - 钉钉：oapi.dingtalk.com
 * - 企业微信：qyapi.weixin.qq.com
 * - Slack：hooks.slack.com
 */

function detectType(webhook: string): "feishu" | "dingtalk" | "wechat" | "slack" {
  if (webhook.includes("feishu") || webhook.includes("larksuite")) return "feishu";
  if (webhook.includes("dingtalk")) return "dingtalk";
  if (webhook.includes("qyapi.weixin")) return "wechat";
  return "slack";
}

function feishuSign(secret: string, timestamp: number): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

export async function notify(cfg: NotifyConfig, title: string, lines: string[]): Promise<string> {
  const text = `${title}\n${lines.join("\n")}`;
  const type = detectType(cfg.webhook);
  let body: Record<string, unknown>;
  if (type === "feishu") {
    body = { msg_type: "text", content: { text } };
    if (cfg.secret) {
      const ts = Math.floor(Date.now() / 1000);
      body.timestamp = String(ts);
      body.sign = feishuSign(cfg.secret, ts);
    }
  } else if (type === "dingtalk" || type === "wechat") {
    body = { msgtype: "text", text: { content: text } };
  } else {
    body = { text };
  }
  try {
    const res = await fetch(cfg.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return `通知已发送（${type}，HTTP ${res.status}）`;
  } catch (e) {
    return `通知发送失败（${type}）：${e instanceof Error ? e.message : String(e)}`;
  }
}
