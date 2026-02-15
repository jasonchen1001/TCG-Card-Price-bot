# TCG 卡牌价格查询 Discord Bot

基于 AI 图像识别的 TCG 卡牌价格查询机器人，支持 **宝可梦 / 海贼王 / 游戏王** 等多种卡牌游戏。

## 功能特性

- 📸 **AI 图像识别** - 使用 Gemini Vision API 识别卡牌截图
- 💰 **实时价格查询** - 集成多个价格 API 获取市场行情
- 🎴 **多游戏支持** - Pokemon、One Piece、Yu-Gi-Oh!
- 🔍 **多种触发方式** - 命令、Slash Command、自动识别
- ⚡ **极速响应** - 使用最新的 Gemini 2.5 Flash Lite

## 使用方式

| 方式 | 说明 |
|------|------|
| `!price` + 截图 | 发送命令并上传卡牌图片 |
| 回复消息 | 回复包含图片的消息并输入 `!price` |
| `/price` 命令 | 使用 Slash Command 上传图片 |
| `card-pulls` 频道 | 在此频道自动识别所有上传的图片 |
| `/search` 命令 | 按名称手动搜索卡牌价格 |

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/jasonchen1001/TCG-Card-Price-bot.git
cd TCG-Card-Price-bot
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
nano .env
```

填入以下信息：

```env
DISCORD_TOKEN=你的Discord机器人Token
DISCORD_APP_ID=你的Discord应用ID
GEMINI_API_KEY=你的Gemini API密钥
POKEMON_TCG_API_KEY=你的Pokemon TCG API密钥（可选）
JUSTTCG_API_KEY=你的JustTCG API密钥（可选）
```

### 4. 运行

```bash
npm start
```

或使用 PM2 在服务器上运行：

```bash
pm2 start index.js --name tcg-bot
pm2 save
pm2 startup
```

## API 密钥获取

| 密钥 | 获取地址 | 费用 | 必需 |
|------|----------|------|------|
| **DISCORD_TOKEN** | [Discord Developer Portal](https://discord.com/developers/applications) | 免费 | ✅ 必需 |
| **GEMINI_API_KEY** | [Google AI Studio](https://aistudio.google.com/app/apikey) | 免费(有配额) | ✅ 必需 |
| **POKEMON_TCG_API_KEY** | [Pokemon TCG API](https://dev.pokemontcg.io) | 免费 | ⚠️ 推荐 |
| **JUSTTCG_API_KEY** | [JustTCG](https://justtcg.com) | 付费 | ❌ 可选 |

## 成本估算

- **Gemini 免费层**: ~20-50 次识别/天 (gemini-2.5-flash)，1500 次/天 (gemini-2.5-flash-lite)
- **超出付费**: 查看 [Gemini 定价](https://ai.google.dev/pricing)
- **价格 API**: Pokemon TCG API 和 OPTCG API 均免费
- **小规模使用 ≈ 完全免费 🎉**

## 项目结构

```
TCG-Card-Price-bot/
├── index.js           # 主程序
├── package.json       # 依赖配置
├── .env.example       # 环境变量模板
├── .gitignore         # Git 排除规则
├── README.md          # 项目说明
└── SETUP.md           # 详细设置指南
```

## 技术栈

- **Node.js** - 运行环境
- **discord.js** - Discord Bot 框架
- **Gemini Vision API** - AI 图像识别
- **Pokemon TCG API** - 宝可梦价格数据
- **OPTCG API** - 海贼王价格数据

## License

MIT License

## 鸣谢

- [Pokemon TCG API](https://pokemontcg.io) - 宝可梦卡牌数据
- [OPTCG API](https://optcgapi.com) - 海贼王卡牌数据
- [Google Gemini](https://ai.google.dev) - AI 图像识别能力
