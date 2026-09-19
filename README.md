# PatientSimulationSystem

欢迎！这是一套面向 **CRC（临床研究协调员）受试者沟通** 的沉浸式训练系统。

你在浏览器里进入 3D 随访诊室，与「虚拟受试者」面对面沟通——可以用语音，也可以打字。受试者会带着顾虑、情绪和理解偏差回应你；练完后可用于复盘沟通质量（知情同意、依从性、不良事件等场景）。

> 训练用病例与对话均为**合成数据**，不构成真实临床或入组建议。

---

## 这是什么

在真实入组前沟通里，CRC 需要把方案讲清楚，同时接住受试者的担心、追问和不信任。本系统把这段对话放进可重复练习的模拟器：

| 你扮演 | 系统扮演 |
|--------|----------|
| CRC / 随访沟通者 | 带画像与状态的受试者（LLM + 语音） |

**适合谁用**

- 临床研究协调员、CRA 相关培训
- 医学 / 药学沟通训练、课程演示
- 需要「可说话的患者」做产品原型的团队

**你能练到什么**

- 入组前答疑：到院安排、安慰剂、给药频次、随访负担…
- 应对犹豫、恐惧、不满，以及 CRC 冷漠敷衍时的受试者反应
- 语音与文字双通道；受试者语气随「当前情绪」变化（火山多情感 TTS）

---

## 两条训练轨

- **主轨 · 试药前 / 受试者沟通**（推荐）  
  medkit **3D 诊室** + CRC **PatientTurn** 多轮逻辑 + **火山** ASR/TTS（中文）
- **旧项目 · ER / 全科**  
  原 medkit 急诊 / 全科漫游 + **LiveKit** 语音链路（需额外密钥与进程）

首页选对应的「门」即可切换。

---

## 快速启动（CRC 主轨）

需要两个进程。在项目根目录打开两个终端：

### 1. CRC 对话后端（端口 8790）

```powershell
python front/server.py
```

### 2. 3D 前端（端口 5173）

```powershell
npm install
npm run dev
```

浏览器打开：http://127.0.0.1:5173

首页选门 **「试药前 / 受试者沟通」** → 选角色卡 → 进入随访诊室。

> CRC 主轨**不需要** LiveKit，也**不需要** `8787` 后端。

### 环境变量

在项目根目录 `.env` 中配置（勿提交到 Git）：

| 变量 | 用途 |
|------|------|
| `VOLC_API_KEY` | 火山 ASR / TTS |
| `TEXT_GENERATION_API_KEY` | 患者回合 LLM（PatientTurn） |

可选：

| 变量 | 用途 |
|------|------|
| `VOLC_TTS_SPEAKER` | TTS 音色 ID（默认高冷御姐多情感音色） |

---

## 预设账号

首次启动后端时会自动创建以下演示账号（`service/accounts/store.py`），密码仅存 PBKDF2 加盐哈希：

| 账号 | 密码 | 角色 |
|------|------|------|
| `admin` | `admin123` | 管理员 |
| `staff` | `staff123` | 带教老师 |
| `student` | `student123` | 学生 |

---

## 诊室里怎么交互

### 语音

- 浮动面板 **按住说话**，或按住 **空格 / 回车**（松开结束）
- **T**：语音静音开关

### 文字聊天框

打字交流在资料面板的 **「对话」** 页签里：

1. 诊室中按 **E** 打开「随访评估」面板  
2. 点顶部 **「对话」**（默认是「随访问答」，需再点一次）  
3. 底部输入框打字，**Enter** 发送  

### 3D 操作

| 操作 | 作用 |
|------|------|
| **双击** 画面 | 进入 / 退出环视 |
| **Esc** | 退出环视；或关闭资料面板 |
| **E** | 打开患者资料面板 |
| **T** | 语音静音 |

环视时先双击或 Esc 退出，再点 UI 更稳妥。

---

## 纯聊天页（无 3D）

只测 CRC 对话时，可直接打开：

http://127.0.0.1:8790

选研究 →「开始对话」→ 底部输入框打字，或「按住说话」。

---

## 架构简述

```
浏览器 (Vite :5173)
  ├─ /api/*   → CRC FastAPI  front/server.py (:8790)
  │              火山 ASR → PatientTurn LLM → 火山 TTS
  │              情绪：状态.当前情绪 → 官方 emotion 枚举
  └─ /agent/* 、/voice/* → medkit FastAPI backend/server.py (:8787)
                           （旧项目 LiveKit 轨才需要）
```

| 模块 | 路径 |
|------|------|
| CRC API | `front/server.py` |
| 患者回合 | `service/agent/patient_turn.py` |
| TTS / 情绪映射 | `service/agent/tts_generate.py`、`tts_emotion.py` |
| 3D 对话客户端 | `src/voice/crcClient.ts`、`conversation.ts` |
| 游戏状态 | `src/game/store.ts`（`dialogueBackend: 'crc' \| 'livekit'`） |

---

## 旧项目轨（LiveKit）

首页选 **「旧项目 · ER / 全科」** 时走 LiveKit。需额外启动：

```powershell
# Managed Agents + /voice/token
backend\.venv\Scripts\python.exe backend\server.py

# LiveKit voice worker
backend\.venv-voice\Scripts\python.exe backend\voice_agent.py dev
```

密钥放在 `backend/.env.local`（`ANTHROPIC_*`、`LIVEKIT_*`、`DEEPGRAM_*`、`CARTESIA_*` 等）。详见 `CLAUDE.md`、`backend/README.md`。

---

## 常用命令

```powershell
npm run dev       # 前端开发服务器
npm run build     # 生产构建
npm run verify    # 数据不变量检查
python front/server.py   # CRC 后端
```

---

## 说明

- 病例与对话为**合成训练数据**，不构成临床诊疗建议。
- 不要将 `.env`、`.env.local`、对话会话目录、`node_modules/`、虚拟环境提交进仓库。
