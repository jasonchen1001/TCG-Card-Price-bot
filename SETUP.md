# Discord 卡牌价格查询机器人 - 设置指南

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 文件，填写 API 密钥

# 3. 启动机器人
npm start
```

---

## API 密钥获取指南

### 1. Discord Bot Token (必需)

1. 访问 [Discord Developer Portal](https://discord.com/developers/applications)
2. 点击 **New Application**，输入名称（如 "TCG Price Bot"）
3. 在左侧菜单点击 **Bot**，然后点击 **Reset Token** 获取 Token
4. 复制 Token 到 `.env` 的 `DISCORD_TOKEN`
5. 在 **OAuth2** → **General** 页面复制 **Application ID** 到 `.env`

**重要:** 将 Bot 添加到服务器：
1. 在 **OAuth2** → **URL Generator**
2. 勾选 `bot` 和 `applications.commands`
3. 在 Bot Permissions 勾选:
   - Read Messages/View Channels
   - Send Messages
   - Embed Links
   - Use Slash Commands
4. 复制生成的 URL 在浏览器打开，邀请 Bot 到服务器

---

### 2. Groq API Key (必需 - 免费)

1. 访问 [Groq Console](https://console.groq.com/keys)
2. 注册/登录账号（无需信用卡）
3. 点击 **Create API Key**
4. 复制 API Key 到 `.env` 的 `GROQ_API_KEY`

**免费额度:**
- ~1000 次请求/天
- 500K tokens/天
- 速度极快 (~562 tokens/秒)

---

### 3. Pokemon TCG API Key (可选但推荐 - 免费)

1. 访问 [Pokemon TCG Developer](https://dev.pokemontcg.io)
2. 注册账号
3. 在 Dashboard 点击 **API Key**
4. 复制 API Key 到 `.env` 的 `POKEMON_TCG_API_KEY`

---

## 使用方式

### 消息命令
- `!price` + 上传卡牌截图 → 识别并查询价格

### Slash Commands
- `/price` → 上传图片识别卡牌
- `/search` → 按名称手动搜索

### 自动识别
- 在名为 `card-pulls` 的频道上传图片，自动触发识别

---

## 支持的卡牌游戏

| 游戏 | 说明 | 价格来源 |
|------|------|----------|
| ⚡ Pokemon | 完全支持 | Pokemon TCG API (免费) |
| 🏴‍☠️ 海贼王 | 完全支持 | OPTCG API (免费) |
| 🃏 游戏王 | 部分支持 | JustTCG (需付费) |

---

## 故障排除

**Bot 无法启动?**
- 检查 `.env` 文件是否正确配置
- 确保 Discord Token 和 Groq API Key 已填写

**无法识别卡牌?**
- 尝试更清晰的截图
- 确保卡牌编号和名称可见
- 尝试使用 `/search` 手动搜索

**价格查询失败?**
- Pokemon 卡牌: 配置 `POKEMON_TCG_API_KEY`
- 其他卡牌: 需要配置 `JUSTTCG_API_KEY` (付费)
