import { describe, it, expect } from "vitest";
import {
  insertUserRule,
  matchRule,
  DEFAULT_RULES,
  SKIP_PERMISSIONS_RULES,
  isDestructiveBashCommand,
} from "../../src/security/rules.js";

describe("DEFAULT_RULES", () => {
  it("has exactly 6 rules", () => {
    expect(DEFAULT_RULES).toHaveLength(6);
  });
});

describe("matchRule", () => {
  it("denies git push --force variants", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "git push --force")).toBe("deny");
    expect(matchRule(DEFAULT_RULES, "bash", "git push --force origin main")).toBe("deny");
  });

  it("denies rm -rf /", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "rm -rf /")).toBe("deny");
    expect(matchRule(DEFAULT_RULES, "bash", "rm -rf /home")).toBe("deny");
  });

  it("asks for other bash commands", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "ls -la")).toBe("ask");
    expect(matchRule(DEFAULT_RULES, "bash", "npm install")).toBe("ask");
  });

  it("allows non-bash tools", () => {
    expect(matchRule(DEFAULT_RULES, "read_file", "/etc/passwd")).toBe("allow");
    expect(matchRule(DEFAULT_RULES, "write_file", "a.txt")).toBe("allow");
  });

  it("defaults to ask when no rule matches", () => {
    expect(matchRule([], "bash", "ls")).toBe("ask");
  });

  it("matches tool name via fnmatch", () => {
    const rules = [{ tool: "read_*", target: "*", action: "deny" as const }];
    expect(matchRule(rules, "read_file", "x")).toBe("deny");
  });

  it("mcp_tools_allow_by_default", () => {
    expect(matchRule(DEFAULT_RULES, "mcp__docs__search", "")).toBe("allow");
    expect(matchRule(DEFAULT_RULES, "connect_mcp", "")).toBe("ask");
  });
});

describe("SKIP_PERMISSIONS_RULES", () => {
  it("allows bash by default but keeps hard denies", () => {
    expect(matchRule(SKIP_PERMISSIONS_RULES, "bash", "dir")).toBe("allow");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "bash", "pnpm test")).toBe("allow");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "bash", "git push --force")).toBe("deny");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "bash", "rm -rf /")).toBe("deny");
  });

  it("keeps non-bash behavior unchanged", () => {
    expect(matchRule(SKIP_PERMISSIONS_RULES, "read_file", "x.ts")).toBe("allow");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "mcp__docs__search", "")).toBe("allow");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "connect_mcp", "")).toBe("ask");
  });
});

describe("isDestructiveBashCommand", () => {
  it("识别 rm -rf 根目录/家目录/系统目录变体", () => {
    for (const cmd of [
      "rm -rf /",
      "rm -rf /*",
      "rm -rf --no-preserve-root /",
      "rm -rf ~",
      "rm -rf /home",
      "rm -rf /etc /var",
      "rm -fr /",
      "rm -r /",
      "rm -rf .",
      "rm -rf ./",
      "rm -rf ./*",
      "rm -rf $HOME",
    ]) {
      expect(isDestructiveBashCommand(cmd), cmd).toBe(true);
    }
  });

  it("识别 git 强制推送变体", () => {
    for (const cmd of [
      "git push -f origin main",
      "git push --force",
      "git push --force-with-lease origin main",
      "git push origin +main",
    ]) {
      expect(isDestructiveBashCommand(cmd), cmd).toBe(true);
    }
  });

  it("识别 find 删除与磁盘破坏", () => {
    for (const cmd of [
      "find / -delete",
      "find / -exec rm -rf {} \\;",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
    ]) {
      expect(isDestructiveBashCommand(cmd), cmd).toBe(true);
    }
  });

  it("识别 Windows 递归删除变体", () => {
    for (const cmd of [
      "rd /s /q C:\\",
      "rm -rf \"C:\\Program Files\"",
      "rmdir /s C:\\",
      "rd /s /q .",
      "del /s /q C:\\*",
      "powershell -Command \"Remove-Item -Recurse -Force C:\\\"",
      "powershell.exe -NoProfile -Command Remove-Item C:\\ -Recurse -Force",
      "Remove-Item \"C:\\Program Files\" -Recurse -Force",
      "pwsh -c rd /s /q %USERPROFILE%",
      "format C:",
    ]) {
      expect(isDestructiveBashCommand(cmd), cmd).toBe(true);
    }
  });

  it("识别命令串中的破坏性片段", () => {
    expect(isDestructiveBashCommand("echo ok && rm -rf /")).toBe(true);
    expect(isDestructiveBashCommand("echo ok; rd /s /q C:\\")).toBe(true);
    expect(isDestructiveBashCommand("echo ok\nrm -rf /")).toBe(true);
    expect(isDestructiveBashCommand("echo ok || powershell -Command Remove-Item -Recurse -Force C:\\")).toBe(true);
  });

  it("不误伤普通命令", () => {
    for (const cmd of [
      "ls -la",
      "rm -rf node_modules",
      "rm dist",
      "npm install",
      "git push origin main",
      "git commit -m x",
      "find . -name '*.js'",
      "Remove-Item -Recurse -Force build",
      "rd /s build",
      "del /s /q build",
    ]) {
      expect(isDestructiveBashCommand(cmd), cmd).toBe(false);
    }
  });
});

describe("insertUserRule", () => {
  it("插入到硬性 deny 之后、默认 ask 之前", () => {
    const rules = [...DEFAULT_RULES];
    insertUserRule(rules, { tool: "bash", target: "ls -la", action: "allow" });
    const denyIdx = rules.findIndex((r) => r.action === "deny");
    const askIdx = rules.findIndex((r) => r.action === "ask");
    const userIdx = rules.findIndex((r) => r.target === "ls -la");
    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(denyIdx);
    expect(userIdx).toBeLessThan(askIdx);
  });
});
