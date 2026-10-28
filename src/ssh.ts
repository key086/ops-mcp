import { NodeSSH } from "node-ssh";
import type { ProjectConfig } from "./config.js";

export async function connect(p: ProjectConfig): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: p.host,
    port: p.port ?? 22,
    username: p.username,
    ...(p.privateKey
      ? { privateKeyPath: p.privateKey }
      : { password: p.password ?? "" }),
    readyTimeout: 15000,
  });
  return ssh;
}

/** 执行远端命令，非 0 退出码即抛错（输出中不回显任何凭据） */
export async function run(ssh: NodeSSH, command: string): Promise<string> {
  const res = await ssh.execCommand(command);
  const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  if (res.code !== 0) {
    throw new Error(`远端命令失败（exit ${res.code}）：${command}\n${out}`);
  }
  return out;
}

/** 允许失败的命令（清理、历史落盘等），返回输出不抛错 */
export async function tryRun(ssh: NodeSSH, command: string): Promise<string> {
  try {
    const res = await ssh.execCommand(command);
    return [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  } catch {
    return "";
  }
}
