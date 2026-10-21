# boundary-check（边界审查）

在给 blh 加新功能前，审查该功能读 / 算 / 展示的数据会不会只增不减、越用越大，并给出增量机制或上限要求。

## 目录结构

```
boundary-check/
├── SKILL.md                    # 核心一问 + 5 步清单（审查流程）
├── scripts/
│   └── scan-boundary.mjs       # 反模式扫描器（Node，零依赖）
├── references/
│   ├── case-study.md           # Ops/Trace 越用越卡的教训案例
│   └── registry.md             # 已确认数据点 + 参考实现
├── assets/
│   └── review-template.md      # 边界审查记录模板
├── evals/
│   └── evals.json              # 触发与行为测试
├── agents/
│   └── openai.yaml             # Codex 显示名 / 默认提示词
└── README.md
```

## 用法

```bash
# 自检
node scripts/scan-boundary.mjs --selftest

# 扫指定目录/文件
node scripts/scan-boundary.mjs src/tracing
node scripts/scan-boundary.mjs src/tracing/store.ts

# 默认扫 src/ apps/
node scripts/scan-boundary.mjs

# 机器可读输出
node scripts/scan-boundary.mjs --json
```

扫描结果全部是**候选可疑点**，需要人工逐项判断，不是"命中即违规"。
