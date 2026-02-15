// ============================================================
// TCG 卡牌价格查询 Discord Bot
// 支持: 宝可梦 / 海贼王 / 游戏王 等卡牌游戏
//
// 🚀 使用 Groq API (免费 + 极速推理 ~562 tok/s)
//    模型: Llama 4 Maverick (支持视觉/图像识别)
//
// 工作流程: 上传截图 → Groq Vision 识别 → 查价 API → 返回结果
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Events, EmbedBuilder,
        REST, Routes, SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch';

// ============================================================
// 初始化
// ============================================================
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================
// 核心模块 1: Gemini Vision 识别卡牌
// ============================================================
const CARD_IDENTIFY_PROMPT = `你是一个专业的 TCG 卡牌识别专家。请仔细查看图片中的卡牌。

**OCR 读取要求** - 仔细从卡牌上读取以下信息：
1. game: 卡牌游戏名 ("pokemon" / "onepiece" / "yugioh" / "other")
2. name_en: 卡牌名称（从卡牌标题区域完整读取）
3. name_jp: 日文名称（从卡牌上读取）
4. name_cn: 中文名称（翻译）
5. card_number: 右上角的编号（逐字读取！如 OP10-005, OP03-051 等）
6. rarity: 稀有度（卡牌上的标识，如 SEC/SR/SSR/L/UC/C 等）
7. set_name: 系列名称（从卡牌侧面或底部小字读取）
8. ocr_raw: 卡牌上的关键文字（仅名称/编号/稀有度，最多30字符，不要重复纹理）
9. confidence: 置信度

**准确性原则**:
- card_number 必须逐字确认，如果模糊不清就设为 null
- set_name 如果无法清晰读取就设为 null
- 宁可不输出也不要输出错误信息

**返回 JSON 格式**:
{
  "game": "onepiece",
  "name_en": "Sanji",
  "name_jp": "サンジ",
  "name_cn": "山治",
  "card_number": "OP10-005",
  "rarity": "SEC",
  "set_name": "Royal Blood",
  "ocr_raw": "SANJI OP10-005 SEC...",
  "confidence": "high"
}

请只返回 JSON 数组，不要任何其他文字。`;

async function identifyCards(imageUrl) {
  // 下载图片 → base64
  const resp = await fetch(imageUrl);
  const buf = Buffer.from(await resp.arrayBuffer());
  const b64 = buf.toString('base64');
  const mime = imageUrl.includes('.png') ? 'image/png' : 'image/jpeg';

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: CARD_IDENTIFY_PROMPT },
              { inline_data: { mime_type: mime, data: b64 } }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4000,
            responseMimeType: "application/json"
          }
        })
      }
    );

    const data = await response.json();
    console.log('Gemini response:', JSON.stringify(data, null, 2));

    // 检查配额用尽错误
    if (data.error?.code === 429) {
      console.error('Gemini quota exceeded');
      return { quotaExceeded: true };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    console.log('Extracted text:', text);
    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    console.log('Cleaned text:', clean);
    const parsed = JSON.parse(clean);
    console.log('Parsed result:', parsed);
    return Array.isArray(parsed) ? parsed : (parsed.cards || []);
  } catch (e) {
    console.error('Gemini vision error:', e.message);
    console.error('Error stack:', e.stack);
    return [];
  }
}

// ============================================================
// 核心模块 2: 价格查询 API
// ============================================================

// --- 宝可梦 (Pokemon TCG API - 免费) ---
async function queryPokemonPrice(card) {
  try {
    let q = '';
    if (card.card_number) {
      const num = card.card_number.split('/')[0].trim();
      q = card.set_name
        ? `number:${num} set.name:"${card.set_name}"`
        : `number:${num}`;
    } else {
      q = `name:"${card.name_en}"`;
    }

    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=5`;
    const headers = process.env.POKEMON_TCG_API_KEY
      ? { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY }
      : {};

    const resp = await fetch(url, { headers });
    const data = await resp.json();

    if (data.data?.length > 0) {
      const m = data.data[0];
      const prices = {};
      for (const [k, v] of Object.entries(m.tcgplayer?.prices || {})) {
        prices[k] = { market: v.market, low: v.low, mid: v.mid, high: v.high };
      }
      return {
        found: true,
        name: m.name,
        set: m.set?.name,
        number: `${m.number}/${m.set?.printedTotal}`,
        rarity: m.rarity,
        image: m.images?.large || m.images?.small,
        prices,
        source: 'TCGPlayer (Pokemon TCG API)',
        url: m.tcgplayer?.url,
      };
    }
    return { found: false };
  } catch (e) {
    console.error('Pokemon price error:', e.message);
    return { found: false, error: e.message };
  }
}

// --- 海贼王 (OPTCG API - 免费) ---
async function queryOnePiecePrice(card) {
  try {
    const num = card.card_number?.replace(/\s/g, '') || '';
    if (num) {
      const resp = await fetch(`https://optcgapi.com/api/cards/${encodeURIComponent(num)}`);
      if (resp.ok) {
        const d = await resp.json();
        return {
          found: true,
          name: d.name || card.name_en,
          set: d.set || card.set_name,
          number: num,
          rarity: d.rarity || card.rarity,
          image: d.image_url,
          prices: { market: d.market_price, low: d.low_price, mid: d.mid_price, high: d.high_price },
          source: 'OPTCG API / TCGPlayer',
          url: d.tcgplayer_url,
        };
      }
    }
    return { found: false };
  } catch (e) {
    console.error('OP price error:', e.message);
    return { found: false, error: e.message };
  }
}

// --- 通用 (JustTCG - 多游戏支持，可选) ---
async function queryJustTCG(card) {
  if (!process.env.JUSTTCG_API_KEY) return { found: false };
  try {
    const resp = await fetch(
      `https://api.justtcg.com/v1/cards?search=${encodeURIComponent(card.name_en)}`,
      { headers: { Authorization: `Bearer ${process.env.JUSTTCG_API_KEY}` } },
    );
    const data = await resp.json();
    if (data.data?.length > 0) {
      const m = data.data[0];
      const v = m.variants?.[0];
      return {
        found: true, name: m.name, set: m.set_name, number: m.card_number,
        rarity: m.rarity, prices: { market: v?.market_price, low: v?.low_price },
        source: 'JustTCG',
      };
    }
    return { found: false };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

// --- 路由：根据游戏类型查询价格 ---
async function getCardPrice(card) {
  switch (card.game) {
    case 'pokemon':  return await queryPokemonPrice(card);
    case 'onepiece': return await queryOnePiecePrice(card);
    default:         return await queryJustTCG(card);
  }
}

// ============================================================
// 核心模块 3: 构建 Discord Embed 回复
// ============================================================
const EMOJI = { pokemon: '⚡', onepiece: '🏴‍☠️', yugioh: '🃏', other: '🎴' };

function buildPriceEmbed(card, priceResult) {
  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle(`${EMOJI[card.game] || '🎴'} ${card.name_en || card.name_cn}`)
    .setTimestamp();

  const names = [card.name_cn, card.name_jp].filter(Boolean).join(' | ');
  if (names) embed.setDescription(names);

  // 卡牌信息
  const info = [
    (card.set_name) && `📦 系列: ${card.set_name}`,
    (card.card_number) && `#️⃣ 编号: ${card.card_number}`,
    (card.rarity) && `✨ 稀有度: ${card.rarity}`,
    `🎯 识别置信度: ${card.confidence || 'unknown'}`,
    `⚠️ 仅供参考，不一定准确`,
  ].filter(Boolean);
  if (info.length) {
    embed.addFields({
      name: '📋 卡牌信息',
      value: info.join('\n')
    });
  }

  // 价格信息 - 显示 API 查询的真实价格
  if (priceResult && priceResult.found && priceResult.prices) {
    const p = priceResult.prices;
    const price = p.market || Object.values(p)[0]?.market || p.low || p.mid || p.high;
    const priceText = price ? `$${price.toFixed(2)} USD` : '暂无价格数据';
    embed.addFields({
      name: '💰 市场价格',
      value: `**${priceText}**\n📊 数据来源: ${priceResult.source}`
    });
    if (priceResult.url) {
      embed.addFields({ name: '🔗 购买链接', value: `[查看 TCGPlayer](${priceResult.url})` });
    }
  }

  // 搜索链接
  const searchNameOnly = card.name_en.trim();
  const searchQuery1 = encodeURIComponent(`${searchNameOnly} pricecharting`.trim());
  const searchUrl1 = `https://www.google.com/search?q=${searchQuery1}`;

  const searchNameFull = `${card.name_en} ${card.set_name || ''} ${card.card_number || ''}`.trim();
  const searchQuery2 = encodeURIComponent(`${searchNameFull} pricecharting`.trim());
  const searchUrl2 = `https://www.google.com/search?q=${searchQuery2}`;

  embed.addFields({
    name: '🔗 价格查询',
    value: `[🎯 仅角色名](${searchUrl1}) | [📦 完整信息](${searchUrl2})`
  });

  embed.setFooter({ text: `⚡ Powered by Gemini Vision + Price APIs` });
  return embed;
}

// ============================================================
// 通用处理函数: 识别 + 查价 + 返回 embeds
// ============================================================
async function processCardImage(imageUrl, gameOverride) {
  const cards = await identifyCards(imageUrl);

  // 检查配额用尽
  if (cards?.quotaExceeded) {
    return { quotaExceeded: true, cards: [], embeds: [] };
  }

  if (!cards?.length) return { cards: [], embeds: [] };

  if (gameOverride) cards.forEach(c => (c.game = gameOverride));

  const embeds = [];

  for (const card of cards) {
    // 先查真实价格 API
    const priceResult = await getCardPrice(card);
    embeds.push(buildPriceEmbed(card, priceResult));
  }

  return { cards, embeds };
}

// ============================================================
// Discord: 消息触发 (!price + 图片)
// ============================================================
discord.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  const isCmd = msg.content.toLowerCase().startsWith('!price');
  const isAuto = msg.channel.name === 'card-pulls';
  if (!isCmd && !isAuto) return;

  // 确定要处理的图片URL
  let imageUrl = null;

  // 情况1: 直接发送图片 + !price
  const directImgs = msg.attachments.filter(a => a.contentType?.startsWith('image/'));
  if (directImgs.size > 0) {
    imageUrl = directImgs.first().url;
  }

  // 情况2: 回复之前的消息，获取被回复消息的图片
  if (!imageUrl && msg.reference) {
    try {
      const referencedMsg = await msg.channel.messages.fetch(msg.reference.messageId);
      const replyImgs = referencedMsg.attachments.filter(a => a.contentType?.startsWith('image/'));
      if (replyImgs.size > 0) {
        imageUrl = replyImgs.first().url;
      }
    } catch (e) {
      console.log('Could not fetch referenced message:', e.message);
    }
  }

  if (!imageUrl) {
    if (isCmd) msg.reply('请上传卡牌截图，或回复一张包含截图的消息！📸');
    return;
  }

  const reply = await msg.reply('🔍 正在识别卡牌并查询价格...');

  try {
    const result = await processCardImage(imageUrl);

    // 检查配额用尽
    if (result.quotaExceeded) {
      await reply.edit('⚠️ **API 配额已用尽！**\n\nGemini 免费层每天限制 1000 次请求。请等待约 24 小时后重试，或配置付费 API。');
      return;
    }

    const { cards, embeds } = result;

    if (!cards.length) {
      await reply.edit('😅 没有识别出卡牌，请尝试更清晰的截图。');
      return;
    }

    await reply.edit({ content: '✅ 查询完成！', embeds: embeds.slice(0, 10) });
  } catch (e) {
    console.error('Error:', e);
    await reply.edit('❌ 处理出错了，请稍后重试。');
  }
});

// ============================================================
// Discord: Slash Commands
// ============================================================
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName('price')
      .setDescription('📸 识别卡牌截图并查询价格')
      .addAttachmentOption(o => o.setName('image').setDescription('卡牌截图').setRequired(true))
      .addStringOption(o => o.setName('game').setDescription('指定游戏 (可选)')
        .addChoices(
          { name: '宝可梦', value: 'pokemon' },
          { name: '海贼王', value: 'onepiece' },
          { name: '游戏王', value: 'yugioh' },
        )),
    new SlashCommandBuilder()
      .setName('search')
      .setDescription('🔎 按名称搜索卡牌价格')
      .addStringOption(o => o.setName('name').setDescription('卡牌名称').setRequired(true))
      .addStringOption(o => o.setName('game').setDescription('卡牌游戏').setRequired(true)
        .addChoices(
          { name: '宝可梦', value: 'pokemon' },
          { name: '海贼王', value: 'onepiece' },
          { name: '游戏王', value: 'yugioh' },
        )),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_APP_ID), { body: cmds.map(c => c.toJSON()) });
    console.log('✅ Slash Commands 注册成功');
  } catch (e) { console.error('注册命令失败:', e); }
}

discord.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'price') {
    await i.deferReply();
    try {
      const att = i.options.getAttachment('image');
      const game = i.options.getString('game');
      const result = await processCardImage(att.url, game);

      // 检查配额用尽
      if (result.quotaExceeded) {
        return i.editReply('⚠️ **API 配额已用尽！**\n\nGemini 免费层每天限制 1000 次请求。请等待约 24 小时后重试，或配置付费 API。');
      }

      const { cards, embeds } = result;

      if (!cards.length) return i.editReply('😅 没有识别出卡牌，请尝试更清晰的截图。');

      await i.editReply({ embeds: embeds.slice(0, 10) });
    } catch (e) { console.error(e); await i.editReply('❌ 出错了，请稍后重试'); }
  }

  if (i.commandName === 'search') {
    await i.deferReply();
    const card = {
      game: i.options.getString('game'),
      name_en: i.options.getString('name'),
      confidence: 'manual',
    };
    const priceResult = await getCardPrice(card);
    await i.editReply({ embeds: [buildPriceEmbed(card, priceResult)] });
  }
});

// ============================================================
// 启动
// ============================================================
discord.on(Events.ClientReady, () => console.log(`✅ Bot 上线: ${discord.user.tag}`));
registerCommands();
discord.login(process.env.DISCORD_TOKEN);

// ============================================================
// 💡 成本估算
// ============================================================
//
// ┌──────────────────────────────────────────────────────────┐
// │  Groq 免费层 (无需信用卡)                                  │
// │  • Llama 4 Maverick: ~1000次请求/天, 500K token/天        │
// │  • 推理速度: ~562 tokens/秒 (极快!)                       │
// │  • 每张图片识别: ~1-2秒                                    │
// │                                                          │
// │  如果免费不够用, 付费价格:                                  │
// │  • 输入: $0.20 / 百万 token                               │
// │  • 输出: $0.60 / 百万 token                               │
// │  • 100张图 ≈ $0.02 (两分钱)                               │
// │                                                          │
// │  价格 API: 全部免费                                        │
// │  • Pokemon TCG API: 免费                                   │
// │  • OPTCG API: 免费                                         │
// │  • JustTCG: 免费层可用                                     │
// │                                                          │
// │  总计: 小规模 = 完全免费 🎉                                 │
// │        大规模 (1000张/天) ≈ $0.20/天                       │
// └──────────────────────────────────────────────────────────┘
