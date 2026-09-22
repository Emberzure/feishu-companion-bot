# feishu-companion-bot
## 项目说明

- 本项目是我的第一个开源项目，主要由 AI 辅助完成，代码结构、文档都可能存在不足。
- 目前仅在 Arch Linux上实现并运行，其他Linux发行版未作验证。快速开始（其实一点也不快速,包含若干shell脚本）仅针对linux，
- 核心逻辑采用JavaScript,语言层面可跨平台，但不保证可运行。
- 我目前没有足够时间持续维护这个项目，Issue 和 PR 没法及时处理，也可能无法回复。
- 项目以 MIT 许可证开源，仅供学习与参考。感谢理解。

## 介绍

一个跑在飞书上的 AI 陪伴机器人，带**长期记忆**。

它不是一个「问答机器人」，而是一个**会记得你**的角色：

- **它记得关于你的事** —— 你的口味、作息、在意什么。这些每轮对话都带着，它一直「知道」。
- **它还会「想起来」** —— 你们之间发生过的事平时躺着，被你那句话戳到才浮上来。
  这一层是「记得」和「想起来」的区别，也是这个项目最想做的事情。

记忆存在本地 SQLite 里，**只增不删**，原始对话永远不会被丢掉。

---

## 它长什么样

- 角色由你写的 `persona.md` 驱动 —— 它是谁、怎么说话、边界在哪，全在这一份文件里
- 回复会被拆成几个气泡分批发出去，中间停 0.6~1.5 秒，像人在打字
- 它会主动找你，但**有四道锁**拦着（你回了才发下一条、静默够久、免打扰时段、每日上限），
  不会变成骚扰

---

## 需要什么

- **Node.js 24+**（要用到内置的 `node:sqlite`，零依赖、不用编译）
- 一个**飞书自建应用**（免费）
- 一个**模型 API Key**。默认接 DeepSeek，换别的模型改 `bot/llm.mjs` 即可
- 一台**常开的机器**：家里的小主机、树莓派、旧笔记本都行

> **不需要公网 IP、不需要域名、不需要端口映射。**
> 用的是飞书的长连接模式，你的机器主动连出去。这是在家用宽带上唯一可行的方式。

---

## 快速开始

> 下面所有命令都从**项目根目录**（`feishu-companion-bot/`）开始。
> 少数需要进 `bot/` 的地方会单独标出来。

### 1. 建飞书应用

去 [飞书开放平台](https://open.feishu.cn/) 建一个**企业自建应用**，然后：

1. **凭证与基础信息** → 记下 `App ID` 和 `App Secret`
2. **权限管理** → 开通这两个权限：
   - `im:message`（读取与发送单聊消息）
   - `im:message:send_as_bot`（以机器人身份发消息）
3. **事件订阅** → **订阅方式必须选「使用长连接接收事件」**
   - 添加事件：`im.message.receive_v1`（接收消息）
4. **发布** → 创建版本并发布，等审核通过

### 2. 装依赖

```bash
cd bot
npm install
cd ..
```

> 如果你的网络并发一高就断连（有些路由器会），加 `--maxsockets=1`。

### 3. 填配置

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

至少填上这三个：

```ini
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
DEEPSEEK_API_KEY=sk-xxxxxxxxxx
```

### 4. 写人设

```bash
cp persona.example.md persona.md
$EDITOR persona.md
```

**这一步不能跳过。** `persona.md` 是角色的完整系统提示，
找不到它程序会直接退出。模板里六个小节各管一件事，每节都有填写说明。

### 5. 先试，再跑

```bash
cd bot
./try              # 跑五个预设场景，看看它说话什么样
./try "在吗"        # 试一句
./try -m "在吗"     # 带上长期记忆试（会打印它想起了什么）
```

调试台真调 API，但**只读 `data/`**，不影响正在跑的服务。

### 6. 跑起来

先确认能跑通（前台，Ctrl-C 停）：

```bash
./run
```

没问题了就让它常驻。**两种方式，选一个**：

**方式 A：简单后台运行**（关终端会死）

```bash
./run -d           # 日志进 ../logs/bot.log
```

**方式 B：装成 systemd 用户服务**（关终端、重启桌面环境都不死，推荐）

```bash
cd ~/feishu-companion-bot        # 回到项目根目录
mkdir -p ~/.config/systemd/user
sed "s|__PROJECT__|$PWD|g; s|__NODE__|$(command -v node)|g" \
  systemd/companion-bot.service > ~/.config/systemd/user/companion-bot.service
systemctl --user daemon-reload

cd bot
./start
```

> 服务默认**不开机自启**（`disabled`）。想开机自启：`systemctl --user enable companion-bot`

### 7. 认主人

第一次给机器人发消息的人会被记成「主人」（存在 `data/owner.json`），
之后它只理这一个人。想换人就把那个文件删掉，或重启一次。

---

## 配置项

全在 `.env` 里，都有默认值，不写也能跑。
| 变量 | 默认 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — | **必填**，飞书应用凭证 |
| `DᄅEPSEEK_API_KEY` | — | **必填**，模型 API Key |
| `PERSONA_PATH` | 项目根目录的 `persona.md` | 人设文件路径 |
| `OWNER_OPEN_ID` | 空 | 写死主人；留空则自动认领第一个说话的人 |
| `RECALL_LLM` | 开 | 设成 `0` 关掉「记忆检索员」。关掉更快更省钱，但绕弯的说法匹配不上 |
| `PROACTIVE_AFTER_HOURS` | `4` | 静默多久才考虑主动发言 |
| `PROACTIVE_DAILጙ_CAP` | `3` | 每天最多主动发言几条 |
| `QUIET_FROM` / `QUIET_TO` | `1` / `8` | 免打扰时段（只约束主动发言，你找它它一定回） |

---

## 记忆是怎么回事

三层，各司其职：

| 层 | 存什么 | 什么时候进上下文 |
|---|---|---|
| 最近 30 条 | 原样的对话ݠ| 每轮 |
| **事实** | 关于你的稳定信息 | **每轮**（一直带着，所以要短） |
| **情景** | 发生过的事 + 角色当时的感受 | **被你那句话戳到才进** |

没归档的消息攒够 20 条，交给「记忆整理员」浓缩成事实和情景。
**整理失败那批消息一条都不会归档**，下次原样再试 —— 宁可多留，不能丢。

想让它记得某个新话题，往 `bot/memory.mjs` 的 `TAGS` 里加个词就行。

---

## 目录结构

```
.
├── README.md
├── persona.example.md          # 人设模板（复制成 persona.md 再填）
├── .env.example                # 配置模板（复制成 .env 再填）
├── systemd/companion-bot.service
└── bot/
    ├── feishu.mjs    # 飞书传送层（唯一跟平台绑定的文件，换平台只改它）
    ├── core.mjs      # 平台无关的核心：载入人设、拆气泡
    ├── llm.mjs       # 调模型
    ├── memory.mjs    # 三层记忆 + 受控标签词表
    ├── summarize.mjs # 记忆整理员
    ├── recall.mjs    # 记忆检索员
    ├── try.mjs       # 调试台
    ├── prompts/      # 整理员 / 检索员 / 主动发言用的系统提示词
    └── run, start, stop, reload, status
```

---

## 安全边界

`persona.md` 的第六节是**安全边界**（自伤、危机场景怎么应对）。

模板里给了骨架和填写说明。一个会主动开口、还记得你情绪低谷的机器人，
在这类场景里的回应方式是有实际影响的。

---

## 注意

- **`.env` 和 `data/` 绝对不要提交。** 前者是密钥，后者是你和角色的全部对话。
  仓库的 `.gitignore` 已经挡了，但你自己心里要有数。
- 记忆库**只增不删**。不想让它提某件事，改 `episodes.sensitive = 1`
  （它就不会主动提），而不是删行。
- 这个项目默认接 DeepSeek。换模型改 `bot/llm.mjs` 里的地址和模型名即可，
  但注意**别换成推理模型** —— 它会先想一大段，在陪伴场景里会显得在愣神。

---

## License

MIT
