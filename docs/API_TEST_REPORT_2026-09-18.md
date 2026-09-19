# PatientSimulationSystem API 与功能测试报告

- 测试日期：2026-09-18（Asia/Shanghai）
- 测试环境：Windows，本地开发环境
- 前端：`http://localhost:5173`
- CRC 对话后端：`http://localhost:8790`
- 旧项目后端：`http://localhost:8787`
- 测试方式：真实 HTTP 请求、真实火山 ASR/TTS、真实文本生成 API、项目自动化测试

## 1. 结论摘要

CRC 主流程可以正常使用。4 个试验均能创建患者会话，文字对话、自动评分、TTS、ASR、语音回合和语音回复均已通过真实 API 验证。

账号、权限、管理统计等本地业务接口工作正常。旧项目的 Managed Agent、LiveKit、EHR Vault 和 Anthropic 分诊接口因环境变量未配置而不可用，属于部署配置阻塞。

修复后，CRC 主轨的构建、Node 测试、Python 测试与 CRC 资产校验均已通过。旧 ER/全科项目的校验被保留为独立的 `verify:legacy`，不再阻塞 CRC 主轨发布。

| 分类 | 结论 |
|---|---|
| 前端与服务健康 | 通过 |
| CRC 四试验会话创建 | 通过 |
| CRC 文本多轮对话 | 通过 |
| 自动评分 | 通过 |
| 火山 TTS | 通过 |
| 火山 ASR | 通过 |
| ASR → LLM → TTS 完整语音回合 | 通过 |
| 登录、角色权限、管理接口 | 通过 |
| 前端生产构建 | 通过 |
| 旧项目 Managed Agent / LiveKit | 环境未配置 |
| EHR Vault / Anthropic 分诊 | 环境未配置 |
| `npm test` | 全部通过 |
| `pytest` | 10/10 通过，无警告 |
| `npm run verify` | CRC 资产校验通过 |

## 2. 服务健康检查

| 检查项 | 实际结果 | 状态 |
|---|---:|---|
| `GET http://localhost:5173/` | HTTP 200 | 通过 |
| `GET http://localhost:8787/health` | `ok=true` | 通过 |
| `GET http://localhost:8790/` | HTTP 200 | 通过 |
| CRC 就绪试验数量 | 4/4 | 通过 |
| Anthropic Key | 未配置 | 阻塞旧项目 AI 功能 |
| Managed Agent IDs | 未配置 | 阻塞旧项目 Agent |
| LiveKit | 未配置 | 阻塞旧项目语音 |

## 3. CRC 试验与患者会话

以下试验均使用真实 `POST /api/sessions` 创建会话，并用 `GET /api/sessions/{session_id}` 回读验证：

| 试验 | 会话创建 | 患者首句 | 会话回读 |
|---|---|---|---|
| B-cell malignancies | 通过 | 存在 | 通过 |
| Chronic rhinosinusitis with nasal polyps | 通过 | 存在 | 通过 |
| Non - Hodgkin lymphoma | 通过 | 存在 | 通过 |
| Phloroglucinol Orally Disintegrating Tablets | 通过 | 存在 | 通过 |

本轮生成的测试会话示例：`session_20260918_215916`。

## 4. 真实 AI 与语音链路

### 4.1 文本患者回复

- 接口：`POST /api/sessions/{session_id}/reply`
- 输入：一条中文 CRC 沟通语句
- HTTP：200
- 耗时：约 9.4 秒
- 输出：患者回复存在，会话消息从 1 条增长至 3 条
- 结论：PatientTurn 文本生成链路通过

患者实际回复摘要：患者表达了对试验目的不明确及“成为小白鼠”的担忧。

### 4.2 自动评分

- 接口：`POST /api/sessions/{session_id}/evaluate`
- HTTP：200
- 耗时：约 15.3 秒
- 返回维度：7 个
- 返回总分：57.1
- 返回结论：未通过
- 结论：评估模型与结构化结果解析通过

该分数低是因为测试对话只有一轮，并非接口异常。

### 4.3 TTS

- 接口：`POST /api/tts/raw`
- 文本：`您好，这是语音识别测试。`
- 耗时：约 3.7 秒
- 生成 MP3：26,925 字节
- 测试产物：`output/runtime-logs/api-test-tts.mp3`
- 结论：火山 TTS 通过

### 4.4 ASR 与完整语音回合

将上一项真实生成的 MP3 上传至：

`POST /api/sessions/session_20260918_215916/voice/turn`

实际结果：

- HTTP：200
- ASR 文本：`你好，这是语音识别测试。`
- 患者 LLM 回复：存在
- 回复音频 `audio_base64`：存在
- 情绪字段：存在
- 结论：ASR → PatientTurn LLM → TTS 完整链路通过

这也证明此前页面中的 `Failed to fetch` 是服务未运行导致，而不是当前 ASR 密钥或协议本身不可用。

## 5. 账号、权限与管理功能

| 功能 | 实际结果 | 状态 |
|---|---|---|
| 学生登录 | 返回 `student` 角色 | 通过 |
| 管理员登录 | 返回 `admin` 角色 | 通过 |
| 工作人员登录 | 返回 `staff` 角色 | 通过 |
| `GET /api/auth/me` | 正确返回当前用户 | 通过 |
| 未登录访问 `/api/auth/me` | HTTP 401 | 通过 |
| 学生访问管理员用户列表 | HTTP 403 | 通过 |
| 工作人员查看统计/记录 | HTTP 200 | 通过 |
| 管理员查看用户/统计/记录/试验 | HTTP 200 | 通过 |
| 注册临时用户 | 成功 | 通过 |
| 修改临时用户角色 | `student → staff` | 通过 |
| 禁用临时用户 | 禁用后登录返回 401 | 通过 |
| 恢复临时用户 | 成功 | 通过 |
| 删除临时用户 | 成功，已清理 | 通过 |

训练记录读取与能力画像读取均返回 200。为避免向正式本地记录写入不可删除的测试数据，本轮未执行 `POST /api/training/records`。

## 6. 旧项目后端功能

这些接口的错误响应符合当前环境配置，但功能本身尚未完成可用性验证。

| 接口 | 实际结果 | 原因 |
|---|---:|---|
| `POST /agent/vault/ehr/lookup` | HTTP 503 | 未设置 `EHR_API_TOKEN` |
| `POST /agent/triage/classify` | HTTP 500 | 未设置 `ANTHROPIC_API_KEY` |
| `POST /voice/token` | HTTP 500 | 未设置 LiveKit URL/Key/Secret |
| `POST /agent/sessions` | HTTP 400 | 未设置 Agent ID / Environment ID |

若系统只部署 CRC 主轨，这些配置不会影响当前主流程。

## 7. 自动化测试结果

### 7.1 前端构建

命令：`npm run build`

结果：通过。存在 bundle 大于 500 kB 的性能警告，但不影响构建产物生成。

### 7.2 Node 测试

命令：`npm test`

初次结果：15 通过，3 失败。修复后复测：全部通过。

失败项全部位于 `loop-commands.test.ts`：

1. `verify-loop writes one PASS line to verify.log on green`
2. `verify-loop appends (not overwrites) across firings`
3. `verify.log entries persist in chronological order`

根因不是日志追加逻辑本身，而是 `verify-loop` 原先调用旧项目数据校验并返回退出码 1。修复后循环改为调用 CRC 主轨资产校验，日志相关测试全部通过。

### 7.3 Python 测试

命令：`.venv/Scripts/python.exe -m pytest -q`

初次结果：23 通过，10 失败。修复后 pytest 只收集 CRC 主轨测试，结果为 10/10 通过且无警告。

失败分类：

- 旧项目分诊和 Vault 测试已从 CRC 默认测试路径排除，源码与测试文件均保留。
- 在线背景生成函数改名为 CLI 联调函数，不再被 pytest 错误收集。
- 两个返回整数的 CLI 自测已增加标准 pytest 断言包装，消除了测试警告。

### 7.4 数据校验

命令：`npm run verify`

初次结果：失败，共 315 项旧项目数据违规。修复后默认 `npm run verify` 校验 CRC 目录与每个试验的背景、顾虑池、开场资产，结果通过。

- 旧项目原有检查仍可通过 `npm run verify:legacy` 执行，其 315 项遗留问题没有删除或伪装为通过。
- CRC 主轨新增 `crc-assets` 检查：试验目录非空、stem 唯一，并验证每个试验的背景、顾虑池、开场 JSON 存在且结构正确。

## 8. 未执行的破坏性或永久写入测试

以下接口未做成功路径写入测试，以避免污染正式本地数据：

- `POST /api/training/records`：当前没有删除训练记录的 API。
- `POST /api/admin/studies`：会永久登记试验并可能触发资产生成。
- `POST /api/admin/studies/import`：未上传新的正式 CDE 文件。

这些接口的读取端、鉴权路径和相关前端构建均已验证，但成功写入路径仍建议在独立测试数据目录中执行。

## 9. 修复优先级建议

1. **P2：为训练记录和试验登记增加测试隔离/清理能力。** 便于在 CI 中覆盖写入成功路径。
2. **P3：拆分前端大 bundle。** 当前构建产物主 JS 约 2.5 MB，建议对 3D 页面等使用动态加载。

## 10. 总体判定

**CRC 主轨：可用。** 核心对话、评分和语音链路已通过真实 API 端到端测试。

**管理与账号：基本可用。** 权限边界正确，临时用户生命周期通过。

**旧项目轨：当前不可用。** 缺少 Anthropic、LiveKit、EHR Vault 和 Managed Agent 环境配置。

**CRC 工程质量门禁：通过。** 构建、Node 测试、Python 测试和 CRC 资产校验均已通过。旧项目遗留问题由独立命令保留，不纳入本次主轨判定。
