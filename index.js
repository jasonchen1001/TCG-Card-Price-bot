// ============================================================
// TCG 卡牌价格查询 Discord Bot
// 支持: 宝可梦 / 海贼王 / 游戏王 等卡牌游戏
//
// 🚀 使用 Gemini Vision API (免费 + 快速识别)
//    模型: gemini-2.5-flash-lite (支持视觉/图像识别)
//
// 工作流程: 上传截图 → Gemini Vision 识别 → 查价 API → 返回结果
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Events, EmbedBuilder,
        REST, Routes, SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import fetch from 'node-fetch';

// ============================================================
// TCGPlayer API 配置
// ============================================================
const TCGPLAYER_CLIENT_ID = process.env.TCGPLAYER_CLIENT_ID;
const TCGPLAYER_CLIENT_SECRET = process.env.TCGPLAYER_CLIENT_SECRET;
const TCGPLAYER_AUTH_CODE = process.env.TCGPLAYER_AUTH_CODE;
let tcgplayerToken = null;
let tokenExpiry = null;

// TCGPlayer OAuth 获取访问令牌
async function getTCGPlayerToken() {
  if (tcgplayerToken && tokenExpiry > Date.now()) {
    return tcgplayerToken;
  }
  try {
    const resp = await fetch('https://api.tcgplayer.com/v1.39/app/authorize/YOUR_AUTH_CODE', {
      method: 'POST'
    });
    const data = await resp.json();
    tcgplayerToken = data.results[0].authorizationKey;
    tokenExpiry = Date.now() + 3600 * 1000; // 1小时后过期
    return tcgplayerToken;
  } catch (e) {
    console.error('TCGPlayer OAuth error:', e.message);
    return null;
  }
}

// ============================================================
// Pokemon TCG 系列代码列表（常见系列）
// ============================================================
const POKEMON_SERIES = [
  { code: 'base1', name: 'Base Set (基础系列)' },
  { code: 'swsh1', name: 'Sword & Shield (剑盾)' },
  { code: 'swsh4', name: 'Vivid Voltage ( vivid Voltage)' },
  { code: 'swsh5', name: 'Battle Styles (战斗风格)' },
  { code: 'swsh12', name: 'Silver Tempest (银色风暴)' },
  { code: 'sv1', name: 'Scarlet & Violet (朱紫)' },
  { code: 'sv2', name: 'Paldea Evolved (帕底亚进化)' },
  { code: 'sv3', name: 'Obsidian Flames (黑焰)' },
  { code: 'sv4', name: 'Lost Origin (起源)' },
  { code: 'sv5', name: '151 (宝可梦图鉴)' },
  { code: 'sv6', name: 'Crown Zenith (顶天 Zenith)' },
];

// 生成 Pokemon 系列提示文本
function getPokemonSeriesHint() {
  const seriesList = POKEMON_SERIES.slice(0, 10).map(s => {
    return `\`${s.code}\` - ${s.name}`;
  }).join('\n');

  return `💡 **Pokemon 卡牌编号格式**\n\n格式：\`系列代码-编号\`\n例如：\`swsh4-136\`, \`sv1-1\`, \`base1-4\`\n\n**常见系列代码：**\n${seriesList}`;
}

// ============================================================
// WebSearch MCP 工具集成
// ============================================================
// 使用环境变量控制搜索功能开关
const ENABLE_WEB_SEARCH = process.env.ENABLE_WEB_SEARCH === 'true';

// 网络搜索缓存（简单内存缓存）
const searchCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 翻译用：按消息 ID 缓存卡牌数据（Discord 不保存 embed 自定义字段，必须本地缓存）
const messageCardDataCache = new Map();
const CARD_DATA_CACHE_MAX = 300;

function cacheCardDataForMessage(messageId, cardDataArray) {
  if (!cardDataArray?.length) return;
  if (messageCardDataCache.size >= CARD_DATA_CACHE_MAX) {
    const firstKey = messageCardDataCache.keys().next().value;
    messageCardDataCache.delete(firstKey);
  }
  messageCardDataCache.set(String(messageId), cardDataArray);
}

function cacheSearchDataForMessage(messageId, searchResult, query, game) {
  if (messageCardDataCache.size >= CARD_DATA_CACHE_MAX) {
    const firstKey = messageCardDataCache.keys().next().value;
    messageCardDataCache.delete(firstKey);
  }
  messageCardDataCache.set(String(messageId), { type: 'search', searchResult, query, game });
}

async function webSearch(query) {
  if (!ENABLE_WEB_SEARCH) return null;

  // 检查缓存
  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('Using cached search result for:', query);
    return cached.data;
  }

  try {
    // 方法1: 尝试使用 DuckDuckGo HTML 版本（更可靠）
    const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(htmlUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!resp.ok) throw new Error(`Search API error: ${resp.status}`);

    const html = await resp.text();

    // 简单解析 HTML 提取结果（DuckDuckGo HTML 响应）
    const results = { results: [] };

    // 提取结果链接和标题
    const resultRegex = /<a[^>]*class="result__a"[^>]*>([^<]*)<\/a>.*?<a[^>]*href="([^"]*)"/g;
    let match;
    let count = 0;
    while ((match = resultRegex.exec(html)) !== null && count < 5) {
      results.results.push({
        title: match[1]?.replace(/<[^>]*>/g, '').trim(),
        url: match[2],
        snippet: '点击查看详情'
      });
      count++;
    }

    // 如果没有结果，使用备用数据
    if (results.results.length === 0) {
      console.log('No search results found, using fallback data');
      results.results = getFallbackResults(query);
    }

    // 缓存结果
    searchCache.set(cacheKey, {
      data: results,
      timestamp: Date.now()
    });

    console.log(`Search returned ${results.results.length} results for: ${query}`);
    return results;
  } catch (e) {
    console.error('WebSearch error:', e.message);
    // 返回备用数据
    return { results: getFallbackResults(query) };
  }
}

// 备用热门卡牌数据（当网络搜索失败时使用）
function getFallbackResults(query) {
  const q = query.toLowerCase();

  // 使用 Google 搜索代替 TCGPlayer（避免域名问题）
  const googleSearch = (term) => `https://www.google.com/search?q=${encodeURIComponent(term)}`;

  // Pokemon 热门卡牌
  if (q.includes('pokemon') || q.includes('pokemon') || q.includes('pi')) {
    return [
      { title: 'Charizard - 火焰喷火龙', url: googleSearch('Charizard Pokemon TCG'), snippet: '最受欢迎的 Pokemon 卡牌之一' },
      { title: 'Pikachu - 皮卡丘', url: googleSearch('Pikachu Pokemon TCG'), snippet: '市场需求稳定' },
      { title: 'Mewtwo - 超梦', url: googleSearch('Mewtwo ex Pokemon'), snippet: '价格近期上涨' },
      { title: 'Umbreon - 月亮伊布', url: googleSearch('Umbreon VMAX Pokemon'), snippet: '深受收藏者喜爱' },
      { title: 'Rayquaza - 烈空坐', url: googleSearch('Rayquaza VMAX Pokemon'), snippet: '价格走势分析' }
    ];
  }

  // One Piece 热门卡牌
  if (q.includes('onepiece') || q.includes('one piece') || q.includes('luffy')) {
    return [
      { title: 'Luffy - 路飞', url: googleSearch('Luffy One Piece TCG'), snippet: '最受欢迎的角色之一' },
      { title: 'Shanks - 香克斯', url: googleSearch('Shanks One Piece TCG'), snippet: '价格稳定上涨' },
      { title: 'Law - 罗', url: googleSearch('Law One Piece TCG'), snippet: '需求量大' },
      { title: 'Yamato - 大和', url: googleSearch('Yamato One Piece TCG'), snippet: '收藏家热门选择' },
      { title: 'Kaido - 凯多', url: googleSearch('Kaido One Piece TCG'), snippet: 'OP10 系列表现突出' }
    ];
  }

  // Yu-Gi-Oh 热门卡牌
  if (q.includes('yugioh') || q.includes('yu-gi-oh') || q.includes('blue')) {
    return [
      { title: 'Blue-Eyes White Dragon', url: googleSearch('Blue-Eyes White Dragon Yu-Gi-Oh'), snippet: '最具代表性的卡牌' },
      { title: 'Dark Magician', url: googleSearch('Dark Magician Yu-Gi-Oh'), snippet: '价值稳定' },
      { title: 'Ash Blossom', url: googleSearch('Ash Blossom Yu-Gi-Oh'), snippet: '竞技环境常见' }
    ];
  }

  // 默认返回 Google 搜索
  return [
    { title: 'Google 搜索 TCGPlayer', url: googleSearch('TCGPlayer'), snippet: '访问 TCGPlayer 查看更多卡牌' },
    { title: 'Pokemon 卡牌搜索', url: googleSearch('Pokemon TCG'), snippet: '查看 Pokemon 卡牌' },
    { title: 'One Piece 卡牌搜索', url: googleSearch('One Piece TCG'), snippet: '查看 One Piece 卡牌' },
    { title: 'Yu-Gi-Oh 卡牌搜索', url: googleSearch('Yu-Gi-Oh TCG'), snippet: '查看 Yu-Gi-Oh 卡牌' }
  ];
}



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
// 多语言翻译按钮生成
// ============================================================
function createTranslationButtons() {
  console.log('🔧 Creating translation buttons...');
  const buttons = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('translate_zh-CN')
        .setLabel('简体中文')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🇨🇳'),
      new ButtonBuilder()
        .setCustomId('translate_zh-TW')
        .setLabel('繁體中文')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🇹🇼'),
      new ButtonBuilder()
        .setCustomId('translate_en-US')
        .setLabel('English')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🇺🇸'),
      new ButtonBuilder()
        .setCustomId('translate_ko-KR')
        .setLabel('한국어')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🇰🇷')
    );
  console.log('✅ Translation buttons created successfully');
  return buttons;
}

// ============================================================
// 多语言翻译字典
// ============================================================
const TRANSLATIONS = {
  'zh-CN': {
    title_suffix: '',
    pack_wish: '🧧 祝你开包大吉，SSR 不断！',
    series: '📦 系列',
    number: '#️⃣ 编号',
    rarity: '✨ 稀有度',
    release: '📅 发布时间',
    effect: '📝 效果',
    collectible: '💎 收藏价值',
    popularity: '📈 市场热度',
    competitive: '🏆 竞技',
    highlights: '✨ 特点',
    language: '🌐 语言',
    warning: '⚠️ 仅供参考，不一定准确',
    related: '🔥 值得关注的卡牌',
    price_query: '🔗 价格查询',
    name_only: '🎯 仅角色名',
    full_info: '📦 完整信息',
    ebay_sold: '🛒 eBay 成交记录',
    ebay_chart: '📊 eBay 成交走势',
    ebay_chart_stats: (n, avg, min, max) => `最近 ${n} 笔 · 均价 **$${avg}** · 区间 $${min} ~ $${max}`,
    grading: '评级',
    cert: '证书',
    market_price: '💰 市场价格',
    data_source: '📊 数据来源',
    basic_details: '📚 基本详情',
    price_details: '💰 价格详情',
    pokemon_details: '⚡ Pokemon 详情',
    types: '⚡ 属性',
    hp: '❤️ HP',
    series_info: '📖 系列',
    code: '🔢 代码',
    formats: '🏆 赛制',
    attacks: '⚔️ 招式',
    weakness: '💔 弱点',
    card_description: '💬 卡牌描述',
    set_details: '📦 系列详情',
    artist: '🎨 画师',
    release_date: '📅 发售',
    set_name: '📦 系列',
    legal: '✅',
    banned: '❌',
    card_info: '📋 卡牌信息',
    intro: '💬 简介',
    name_label: '📛 名称',
    color: '🎨 颜色',
    card_type: '🎴 类型',
    cost: '💎 费用',
    power: '⚔️ 战斗力',
    market_price: '💰 市场价',
    manual_search: '🔗 手动搜索',
    search_result_title: '🔍 搜索结果',
    found_versions: '找到 {n} 个版本',
    version: '版本',
    data_source: '数据源'
  },
  'zh-TW': {
    title_suffix: '（繁體中文）',
    pack_wish: '🎴 祝你抽到閃卡、拿到鑑定滿分！',
    series: '📦 系列',
    number: '#️⃣ 編號',
    rarity: '✨ 稀有度',
    release: '📅 發布時間',
    effect: '📝 效果',
    collectible: '💎 收藏價值',
    popularity: '📈 市場熱度',
    competitive: '🏆 競技',
    highlights: '✨ 特點',
    language: '🌐 語言',
    warning: '⚠️ 僅供參考，不一定準確',
    related: '🔥 值得關注的卡牌',
    price_query: '🔗 價格查詢',
    name_only: '🎯 僅角色名',
    full_info: '📦 完整資訊',
    ebay_sold: '🛒 eBay 成交紀錄',
    ebay_chart: '📊 eBay 成交走勢',
    ebay_chart_stats: (n, avg, min, max) => `近 ${n} 筆 · 均價 **$${avg}** · 區間 $${min} ~ $${max}`,
    grading: '評級',
    cert: '證書',
    market_price: '💰 市場價格',
    data_source: '📊 資料來源',
    basic_details: '📚 基本詳情',
    price_details: '💰 價格詳情',
    pokemon_details: '⚡ Pokemon 詳情',
    types: '⚡ 屬性',
    hp: '❤️ HP',
    series_info: '📖 系列',
    code: '🔢 代碼',
    formats: '🏆 賽制',
    attacks: '⚔️ 招式',
    weakness: '💔 弱點',
    card_description: '💬 卡牌描述',
    set_details: '📦 系列詳情',
    artist: '🎨 畫師',
    release_date: '📅 發售',
    set_name: '📦 系列',
    legal: '✅',
    banned: '❌',
    card_info: '📋 卡牌資訊',
    intro: '💬 簡介',
    name_label: '📛 名稱',
    color: '🎨 顏色',
    card_type: '🎴 類型',
    cost: '💎 費用',
    power: '⚔️ 戰鬥力',
    market_price: '💰 市場價',
    manual_search: '🔗 手動搜尋',
    search_result_title: '🔍 搜尋結果',
    found_versions: '找到 {n} 個版本',
    version: '版本',
    data_source: '數據源'
  },
  'en-US': {
    title_suffix: '（English）',
    pack_wish: '✨ May your next pack be a PSA 10!',
    series: '📦 Series',
    number: '#️⃣ Number',
    rarity: '✨ Rarity',
    release: '📅 Release Date',
    effect: '📝 Effect',
    collectible: '💎 Collectible Value',
    popularity: '📈 Market Popularity',
    competitive: '🏆 Competitive',
    highlights: '✨ Highlights',
    language: '🌐 Language',
    warning: '⚠️ For reference only, may not be accurate',
    related: '🔥 Notable Cards',
    price_query: '🔗 Price Query',
    name_only: '🎯 Name Only',
    full_info: '📦 Full Info',
    ebay_sold: '🛒 eBay Sold Listings',
    ebay_chart: '📊 eBay Sold Price Trend',
    ebay_chart_stats: (n, avg, min, max) => `${n} sales · Avg **$${avg}** · Range $${min} ~ $${max}`,
    grading: 'Grading',
    cert: 'Cert',
    market_price: '💰 Market Price',
    data_source: '📊 Data Source',
    basic_details: '📚 Basic Details',
    price_details: '💰 Price Details',
    pokemon_details: '⚡ Pokemon Details',
    types: '⚡ Types',
    hp: '❤️ HP',
    series_info: '📖 Series',
    code: '🔢 Code',
    formats: '🏆 Formats',
    attacks: '⚔️ Attacks',
    weakness: '💔 Weakness',
    card_description: '💬 Card Description',
    set_details: '📦 Set Details',
    artist: '🎨 Artist',
    release_date: '📅 Release',
    set_name: '📦 Set',
    legal: '✅',
    banned: '❌',
    card_info: '📋 Card Info',
    intro: '💬 Card Summary',
    name_label: '📛 Name',
    color: '🎨 Color',
    card_type: '🎴 Type',
    cost: '💎 Cost',
    power: '⚔️ Power',
    market_price: '💰 Market',
    manual_search: '🔗 Manual Search',
    search_result_title: '🔍 Search Result',
    found_versions: 'Found {n} version(s)',
    version: 'Version',
    data_source: 'Data source'
  },
  'ko-KR': {
    title_suffix: '（한국어）',
    pack_wish: '🍀 다음 팩에서 풀아트 나오길 바라요!',
    series: '📦 시리즈',
    number: '#️⃣ 번호',
    rarity: '✨ 레어도',
    release: '📅 출시일',
    effect: '📝 효과',
    collectible: '💎 수집 가치',
    popularity: '📈 시장 인기도',
    competitive: '🏆 카드 게임',
    highlights: '✨ 특징',
    language: '🌐 언어',
    warning: '⚠️ 참고용이며 정확하지 않을 수 있습니다',
    related: '🔥 주목할 만한 카드',
    price_query: '🔗 가격 조회',
    name_only: '🎯 캐릭터명',
    full_info: '📦 전체 정보',
    ebay_sold: '🛒 eBay 판매 내역',
    ebay_chart: '📊 eBay 판매 추이',
    ebay_chart_stats: (n, avg, min, max) => `최근 ${n}건 · 평균 **$${avg}** · 범위 $${min} ~ $${max}`,
    grading: '등급',
    cert: '인증서',
    market_price: '💰 시장 가격',
    data_source: '📊 데이터 출처',
    basic_details: '📚 기본 정보',
    price_details: '💰 가격 상세',
    pokemon_details: '⚡ Pokemon 상세',
    types: '⚡ 속성',
    hp: '❤️ HP',
    series_info: '📖 시리즈',
    code: '🔢 코드',
    formats: '🏆 포맷',
    attacks: '⚔️ 기술',
    weakness: '💔 약점',
    card_description: '💬 카드 설명',
    set_details: '📦 세트 상세',
    artist: '🎨 일러스트',
    release_date: '📅 출시',
    set_name: '📦 세트',
    legal: '✅',
    banned: '❌',
    card_info: '📋 카드 정보',
    intro: '💬 카드 요약',
    name_label: '📛 이름',
    color: '🎨 색상',
    card_type: '🎴 유형',
    cost: '💎 코스트',
    power: '⚔️ 파워',
    market_price: '💰 시세',
    manual_search: '🔗 수동 검색',
    search_result_title: '🔍 검색 결과',
    found_versions: '{n}개 버전',
    version: '버전',
    data_source: '데이터 소스'
  }
};

// ============================================================
// 核心模块 1: Gemini Vision 识别卡牌
// ============================================================
const CARD_IDENTIFY_PROMPT = `You are a professional trading card identification expert.

Analyze the trading card shown in the image and extract structured information.

CRITICAL OUTPUT LANGUAGE RULE:
- All descriptive text fields (description, related_cards[].reason, ocr_raw) MUST be written in Simplified Chinese (简体中文).
- This applies regardless of the card's language (English / Japanese / Chinese).
- Do NOT write any of these fields in Japanese, English, or any other language.
- Card names (name_en, name_jp, name_cn), set names, and card numbers remain in their original language.

Supported games include:
Pokemon
One Piece
Yu-Gi-Oh
Other trading card games.

------------------------------------------------
IDENTIFICATION PRIORITY

1. If the image contains a grading slab label (PSA / CGC / BGS / ACE):

Read the label text FIRST.

Label text has higher priority than the card artwork.

Extract the card name, set name, card number, and grading information from the label.

LANGUAGE DETECTION for graded cards:
- The "language" field refers to the CARD's printed language, not the label language.
- Determine card language from the label text clues:
  - If the label says "Japanese" or shows Japanese set names → Japanese
  - If the label text is in English (e.g. "BRILLIANT STARS", "CHARIZARD V") → English
  - Default to English if unclear.
- name_jp is just an alternate name field; its presence does NOT mean the card is Japanese.

2. If no grading label exists:

Read information directly from the card face.

------------------------------------------------
IMPORTANT RULES

Never guess information that is not visible.

If information cannot be confirmed, return null.

Card name is the most important identifier. Always try to extract it.

------------------------------------------------
CARD NUMBER RULE

Return only what is visible on the card.

Examples:
154
154/172
173/165
OP06-093

Do NOT guess or complete the set size.

------------------------------------------------
RARITY GUIDE

Pokemon examples:
Common
Uncommon
Rare
Holo Rare
Art Rare
Full Art
Secret Rare
SAR
UR

One Piece examples:
C
UC
R
SR
SEC
SP
L

------------------------------------------------
COLLECTIBILITY RULES

Base score from rarity:
- SAR / Secret Rare / SP / Gold / UR / Promo (tournament/event exclusive) → 收藏级珍品 ⭐⭐⭐⭐⭐
- Full Art / SR / Art Rare / SEC → 高收藏价值 ⭐⭐⭐⭐
- Holo Rare / Rare → 中等收藏价值 ⭐⭐⭐
- Uncommon → 普通卡牌 ⭐⭐
- Common → 基础卡牌 ⭐

Upgrade rules (raise by one tier):
- If graded PSA/CGC/BGS 10 or PRISTINE → upgrade one tier
- If graded 9.5 → keep current tier
- If character is iconic (Charizard, Pikachu, Luffy, Zoro) → upgrade one tier
- Maximum is 收藏级珍品 ⭐⭐⭐⭐⭐

Examples:
- Gold rarity + CGC PRISTINE 10 + Luffy → 收藏级珍品 ⭐⭐⭐⭐⭐
- SR + PSA 10 → 收藏级珍品 ⭐⭐⭐⭐⭐
- Common + no grade → 基础卡牌 ⭐

------------------------------------------------
POPULARITY RULES

Based on character fame AND card scarcity:

Iconic characters (Charizard, Pikachu, Luffy, Zoro, Shanks, Kaido, Goku, Naruto):
→ 超热门

Well-known main characters in their franchise:
→ 热门

Supporting characters or lesser-known characters:
→ 一般

Obscure or background characters:
→ 冷门

Upgrade: if rarity is SP/Gold/SAR/UR, raise popularity by one tier.

Others
→ 一般

------------------------------------------------
RELEASE TYPE RULE

Determine how the card was distributed:
- pack: obtained from booster packs (most cards)
- promo: general promotional card (gift, magazine, McDonald's, etc.)
- event: distributed at specific events, game stores, or as contest/competition awards (illustration contest, drawing contest, fan art award, etc.)
- tournament: exclusive to tournament participants or top finishers (World Championship, National Championship, etc.)
- null: cannot determine

Clues:
- tournament: set/card name contains "Tournament", "Championship", "World Finals", "World Champ", "National", or card is explicitly a top-finisher prize
- event: set/card name contains "Illustrator", "Illustration Contest", "Contest", "Award", "Event", "League", "Game Store", or is known as a competition award card (e.g. Pokémon Illustrator)
- promo: set name contains "Promo" BUT is a general release (magazine insert, gift, corporate tie-in) — NOT a contest/event award
- Note: "Corocoro Comics Promo" + "Illustrator" in card name → classify as "event" (illustration contest award)

------------------------------------------------
EFFECT TEXT RULE

If the card has ability / attack / effect text visible on the card face:
- Extract the full effect text in its ORIGINAL language (do not translate here).
- For Japanese cards: extract Japanese text (will be translated later).
- For English cards: extract English text as-is.
- For Chinese cards: extract Chinese text as-is.
- For graded cards in a slab: if effect text is NOT visible, return null.
- Store raw extracted effect text in "effect_text".

------------------------------------------------
DESCRIPTION RULE

Write a single natural SIMPLIFIED CHINESE paragraph (80-150 characters) about this card.
IMPORTANT: description MUST always be written in Simplified Chinese (简体中文), regardless of the card's language.
Structure: describe the card's visual scene or character depiction → mention its series and rarity → naturally include any ability/attack effects if visible (translate effect text to Chinese).
Example: "这张卡牌是宝可梦卡牌151系列中的艺术稀有卡，描绘了皮卡丘与小智在街头的互动场景。它拥有招式「十万伏特」，可造成对手60点伤害。"
If no effect is visible (e.g. graded slab obscures it), omit the effect part.
Store in "description".

------------------------------------------------
RELATED CARDS

Return 2-3 cards that are related by:

Same character
Evolution line
Same series

------------------------------------------------
OUTPUT FORMAT

Return ONLY a JSON object.

Do not include explanations.

{
  "game": "pokemon | onepiece | yugioh | other",
  "name_en": "English card name",
  "name_jp": "Japanese name or null",
  "name_cn": "中文卡名",
  "character_name": "角色名",
  "set_name": "系列名称",
  "card_number": "卡牌编号",
  "rarity": "稀有度",
  "language": "English | Japanese | Chinese | Other",
  "release_date": "YYYY-MM-DD or null",
  "collectible_value": "收藏级珍品 | 高收藏价值 | 中等收藏价值 | 普通卡牌 | 基础卡牌",
  "market_popularity": "超热门 | 热门 | 一般 | 冷门",
  "effect_text": "原文效果文字（保留原语言）或 null",
  "description": "50-80字中文AI简介",
  "grading_company": "PSA | CGC | BGS | ACE | null",
  "grade": "10 | 9.5 | 9 | null",
  "grade_label": "GEM MT | PRISTINE | MINT | null",
  "variant": "标签上注明的变体信息（如 '2023 Champ. World Finals'、'Gold'、'Alt Art' 等），多个用逗号分隔，无则 null",
  "cert_number": "证书编号或 null",
  "release_type": "pack | promo | event | tournament | null",
  "ocr_raw": "标签或卡面关键文字",
  "confidence": "high | medium | low",
  "related_cards": [
    {
      "name": "相关卡牌名称",
      "reason": "相关原因"
    }
  ],
  "search_keywords": {
    "character": "角色名",
    "card": "name_en + card_number",
    "full": "name_en + set_name + card_number"
  }
}`;

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

    // 处理返回格式：数组或单个对象
    if (Array.isArray(parsed)) {
      return parsed;
    } else if (parsed.cards && Array.isArray(parsed.cards)) {
      return parsed.cards;
    } else if (parsed.game) {
      // 单个对象，包装成数组
      return [parsed];
    }
    return [];
  } catch (e) {
    console.error('Gemini vision error:', e.message);
    console.error('Error stack:', e.stack);
    return [];
  }
}

// ============================================================
// Gemini 卡牌内容翻译（描述/稀有度/相关卡原因 等中文 → 目标语言）
// ============================================================
const LANGUAGE_NAMES = { 'zh-TW': 'Traditional Chinese (Taiwan, 繁體中文)', 'en-US': 'English', 'ko-KR': 'Korean' };

async function translateCardContentWithGemini(cardData, targetLang) {
  if (targetLang === 'zh-CN') return cardData;
  const langName = LANGUAGE_NAMES[targetLang] || 'English';

  // 只翻译中文描述性字段，card name / set name / card number 保持原文
  // collectible_value / market_popularity 不翻译，保留中文用于 emoji 映射
  const textFields = {
    name_cn: cardData.name_cn,
    character_name: cardData.character_name,
    effect_text: cardData.effect_text,
    description: cardData.description,
    related_cards: cardData.related_cards,
  };

  const hasAny = Object.values(textFields).some(v => v != null && (Array.isArray(v) ? v.length : String(v).trim()));
  if (!hasAny) return cardData;

  const targetNote = targetLang === 'zh-TW'
    ? 'IMPORTANT: Convert ALL text to Traditional Chinese (繁體字). Do NOT use Simplified Chinese. Use Taiwan conventions.'
    : '';

  const prompt = `You are a translator for TCG card game text. Translate ALL text fields in the JSON below to ${langName}.

Rules:
- Return ONLY a valid JSON object with the same keys. No markdown, no explanation.
- Translate ALL string values to ${langName}, regardless of their source language (Chinese, Japanese, or English).
- For related_cards: keep "name" field unchanged (it is an English card name); translate only "reason" to ${langName}.
- For effect_text and description: translate to ${langName} no matter what language the input is in.
- Keep game mechanic terms natural for ${langName} speakers.
- Keep null values as null.
- Use natural, fluent ${langName}.
${targetNote}

Input JSON:
${JSON.stringify(textFields)}

Output (${langName}):`;

  const doTranslate = async () => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json'
          }
        })
      }
    );
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(`Gemini API error ${response.status}: ${JSON.stringify(data.error || data)}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`Empty Gemini response: ${data.candidates?.[0]?.finishReason || 'no candidates'}`);

    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    const translated = JSON.parse(clean);
    if (Object.keys(translated).filter(k => translated[k] != null).length === 0) {
      throw new Error('Gemini returned empty translation object');
    }
    return {
      ...cardData,
      name_cn: translated.name_cn ?? cardData.name_cn,
      character_name: translated.character_name ?? cardData.character_name,
      effect_text: translated.effect_text ?? cardData.effect_text,
      description: translated.description ?? cardData.description,
      related_cards: Array.isArray(translated.related_cards) ? translated.related_cards : cardData.related_cards,
    };
  };

  try {
    return await doTranslate();
  } catch (e) {
    console.error(`[Translate] Error (will retry): ${e.message}`);
    try {
      await new Promise(r => setTimeout(r, 1000));
      return await doTranslate();
    } catch (e2) {
      console.error(`[Translate] Retry failed: ${e2.message}`);
      return cardData;
    }
  }
}

// ============================================================
// 核心模块 2: 价格查询 API
// ============================================================

// --- 宝可梦 (Pokemon TCG API - 已移除，API 不可用) ---
async function queryPokemonPrice(card) {
  try {
    const apiKey = process.env.POKEMON_TCG_API_KEY;
    if (!apiKey) {
      console.log('[PokemonTCG] No API key, skipping');
      return { found: false };
    }

    // 解析卡牌名称与编号（"173/165" → "173"）
    const name = card.name_en?.trim();
    const rawNumber = card.card_number?.trim() || '';
    const number = rawNumber.split('/')[0].trim(); // 只取斜杠前的数字

    if (!name) {
      console.log('[PokemonTCG] No card name, skipping');
      return { found: false };
    }

    // 构建查询字符串：有编号就精确查，没有就只用名字
    // 正确格式：name:"Charizard V" → name:%22Charizard%20V%22，冒号不编码
    const qParts = [`name:${encodeURIComponent(`"${name}"`)}`];
    if (number) qParts.push(`number:${number}`);
    const q = qParts.join('+');

    console.log(`[PokemonTCG] Querying: ${q}`);
    const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=5`;
    const resp = await fetch(url, {
      headers: { 'X-Api-Key': apiKey }
    });

    if (!resp.ok) {
      console.error(`[PokemonTCG] HTTP ${resp.status}`);
      return { found: false };
    }

    const data = await resp.json();
    const results = data.data;

    if (!results || results.length === 0) {
      console.log(`[PokemonTCG] No results for: ${q}`);
      return { found: false };
    }

    // 优先选编号完全匹配的，否则用第一条
    const matched = number
      ? (results.find(c => c.number === number) || results[0])
      : results[0];

    console.log(`[PokemonTCG] Found: ${matched.name} ${matched.number} (${matched.set?.name})`);

    // 提取 TCGPlayer 价格（按优先级遍历价格类型）
    const tcg = matched.tcgplayer;
    let prices = null;
    let tcgUrl = tcg?.url || null;
    if (tcg?.prices) {
      const priceTypes = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil', 'unlimited'];
      for (const type of priceTypes) {
        const p = tcg.prices[type];
        if (p && (p.market || p.low)) {
          prices = {
            market: p.market ?? null,
            low: p.low ?? null,
            high: p.high ?? null,
            mid: p.mid ?? null,
            type,
          };
          break;
        }
      }
    }
    // 若 TCGPlayer 无价格，用 CardMarket 均价作为备用
    if (!prices && matched.cardmarket?.prices) {
      const cm = matched.cardmarket.prices;
      prices = {
        market: cm.averageSellPrice ?? cm.trendPrice ?? null,
        low: cm.lowPrice ?? null,
        high: null,
        mid: cm.avg7 ?? null,
        type: 'cardmarket',
      };
      tcgUrl = matched.cardmarket.url || null;
    }

    // 提取额外 Pokemon 信息（用于 embed 展示）
    const extraInfo = {
      types: matched.types || null,
      hp: matched.hp || null,
      attacks: matched.attacks || null,
      weaknesses: matched.weaknesses || null,
      flavorText: matched.flavorText || null,
      artist: matched.artist || null,
      legalities: matched.legalities || null,
      set: matched.set
        ? {
            name: matched.set.name,
            series: matched.set.series,
            ptcgoCode: matched.set.ptcgoCode,
            releaseDate: matched.set.releaseDate,
            printedTotal: matched.set.printedTotal,
          }
        : null,
    };

    return {
      found: true,
      name: matched.name,
      set: matched.set?.name || card.set_name,
      number: matched.number,
      rarity: matched.rarity || card.rarity,
      image: matched.images?.large || matched.images?.small || null,
      prices,
      url: tcgUrl,
      releaseDate: matched.set?.releaseDate || null,
      artist: matched.artist || null,
      source: 'PokemonTCG API',
      extraInfo,
    };
  } catch (e) {
    console.error('[PokemonTCG] Error:', e.message);
    return { found: false };
  }
}

// --- 海贼王 (OPTCG API - 免费) ---
async function queryOnePiecePrice(card) {
  try {
    console.log(`[OPTCG] Querying card: ${card.name_en} (${card.card_number})`);
    const num = card.card_number?.replace(/\s/g, '') || '';
    if (num) {
      // 使用正确的 API 端点
      const resp = await fetch(`https://optcgapi.com/api/sets/card/${encodeURIComponent(num)}/`);
      console.log(`[OPTCG] Response status: ${resp.status}`);
      if (resp.ok) {
        const data = await resp.json();
        // API 返回数组，取第一个元素
        const d = Array.isArray(data) ? data[0] : data;
        if (d) {
          console.log(`[OPTCG] Found card:`, d.card_name);
          return {
            found: true,
            name: d.card_name || card.name_en,
            set: d.set_name || card.set_name,
            number: d.card_set_id || num,
            rarity: d.rarity || card.rarity,
            image: d.card_image,
            prices: { market: d.market_price, low: d.inventory_price },
            source: 'OPTCG API',
          };
        }
      }
    }
    console.log(`[OPTCG] Card not found`);
    return { found: false };
  } catch (e) {
    console.error('OP price error:', e.message);
    return { found: false, error: e.message };
  }
}

// OPTCG 搜索函数（通过编号）- 支持多版本
async function searchOPTCGByNumber(cardNumber) {
  try {
    const num = cardNumber.replace(/\s/g, '');
    console.log(`[OPTCG Search] Searching by number: ${num}`);
    // 使用正确的 API 端点
    const url = `https://optcgapi.com/api/sets/card/${encodeURIComponent(num)}/`;
    console.log(`[OPTCG Search] Fetching URL: ${url}`);
    const resp = await fetch(url, { timeout: 10000 });
    console.log(`[OPTCG Search] Response status: ${resp.status}`);
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[OPTCG Search] Response data type: ${Array.isArray(data) ? 'array' : typeof data}`);
      // API 返回数组
      const cards = Array.isArray(data) ? data : (data ? [data] : []);
      if (cards.length > 0) {
        console.log(`[OPTCG Search] Found ${cards.length} version(s)`);
        // 如果只有一个版本，返回单张卡牌格式
        if (cards.length === 1) {
          const card = cards[0];
          return {
            found: true,
            name: card.card_name,
            set: card.set_name,
            number: card.card_set_id,
            rarity: card.rarity,
            image: card.card_image,
            prices: {
              market: card.market_price,
              low: card.inventory_price,
            },
            source: 'OPTCG API',
            card_color: card.card_color,
            card_type: card.card_type,
            card_cost: card.card_cost,
            card_power: card.card_power,
          };
        }
        // 多个版本，返回多张卡牌格式
        return {
          found: true,
          multiple: true,
          cards: cards.map(card => ({
            name: card.card_name,
            number: card.card_set_id,
            rarity: card.rarity,
            image: card.card_image,
            set: card.set_name,
            prices: {
              market: card.market_price,
              low: card.inventory_price,
            },
            source: 'OPTCG API',
            card_color: card.card_color,
            card_type: card.card_type,
            card_cost: card.card_cost,
            card_power: card.card_power,
          }))
        };
      }
    }
    console.log(`[OPTCG Search] Card not found, status: ${resp.status}`);
    return { found: false };
  } catch (e) {
    console.error('OPTCG search error:', e.message);
    return { found: false };
  }
}

// Pokemon 搜索函数（通过编号）
async function searchPokemonByNumber(cardNumber) {
  try {
    const num = cardNumber.replace(/\s/g, '');
    console.log(`[Pokemon Search] Searching by number: ${num}`);

    // Pokemon TCG API v2
    const url = `https://api.pokemontcg.io/v2/cards/${encodeURIComponent(num)}`;
    console.log(`[Pokemon Search] Fetching URL: ${url}`);

    // 设置 8 秒超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });

    clearTimeout(timeoutId);
    console.log(`[Pokemon Search] Response status: ${resp.status}`);

    if (resp.ok) {
      const data = await resp.json();
      if (data.data) {
        const card = data.data;
        console.log(`[Pokemon Search] Found card: ${card.name}`);
        return {
          found: true,
          name: card.name,
          set: card.set?.name,
          number: card.number,
          rarity: card.rarity,
          image: card.images?.large || card.images?.small,
          prices: {
            market: card.cardmarket?.prices?.averageSellPrice || card.tcgplayer?.prices?.normal?.market,
            low: card.cardmarket?.prices?.lowPrice || card.tcgplayer?.prices?.normal?.low,
          },
          source: 'Pokemon TCG API',
          types: card.types,
          hp: card.hp,
        };
      }
    }

    console.log(`[Pokemon Search] Card not found, status: ${resp.status}`);
    return { found: false };
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('Pokemon Search timeout');
    } else {
      console.error('Pokemon Search error:', e.message);
    }
    return { found: false, apiError: true };
  }
}

// 搜索路由函数 - 精确编号搜索
async function searchCard(query, game) {
  console.log(`[Search] Query: "${query}", Game: "${game}"`);

  // 1. 格式检查 - 只支持精确编号搜索（支持大小写字母）
  const isNumber = /^[a-zA-Z0-9\/\-]+$/.test(query.trim());

  if (!isNumber) {
    return {
      found: false,
      formatError: true,
      formatHint: `❌ **仅支持精确编号搜索**\n\n请输入卡牌编号进行搜索，不支持名称或系列搜索。`
    };
  }

  // 2. One Piece 格式检查
  if (game === 'onepiece') {
    const validFormats = [
      /^OP\d{2}-\d{3}$/i,   // OP01-001
      /^EB\d{2}-\d{3}$/i,   // EB01-001
      /^PRB\d{2}-\d{3}$/i   // PRB01-001
    ];

    const shortFormats = [
      { regex: /^OP(\d{2})-(\d{1,2})$/i, prefix: 'OP' },
      { regex: /^EB(\d{2})-(\d{1,2})$/i, prefix: 'EB' },
      { regex: /^PRB(\d{2})-(\d{1,2})$/i, prefix: 'PRB' }
    ];

    const isValidFormat = validFormats.some(f => f.test(query));

    if (!isValidFormat) {
      for (const fmt of shortFormats) {
        const match = query.match(fmt.regex);
        if (match) {
          const series = fmt.prefix + match[1];
          const num = match[2].padStart(3, '0');
          const corrected = `${series}-${num}`;
          return {
            found: false,
            formatError: true,
            formatHint: `💡 **格式提示**: 卡牌编号应该是 3 位数字\n\n你输入: \`${query}\`\n正确格式: \`${corrected}\`\n\n请尝试使用完整的卡牌编号搜索。`
          };
        }
      }

      return {
        found: false,
        formatError: true,
        formatHint: `💡 **One Piece 卡牌编号格式**\n\n\`OPxx-yyy\` - 主系列（如 OP01-001）\n\`EBxx-yyy\` - Extra Booster（如 EB01-001）\n\`PRBxx-yyy\` - Premium Booster（如 PRB01-001）\n\n注意：卡牌编号必须是 3 位数字（带前导零）。`
      };
    }
  }

  // 3. Pokemon 格式检查
  if (game === 'pokemon') {
    // Pokemon TCG 格式：例如 sv1-1, swsh4-136, etc.
    const validFormat = /^[A-Z]{2,4}\d{1,2}-\d{1,3}$/i;

    if (!validFormat.test(query)) {
      return {
        found: false,
        formatError: true,
        formatHint: getPokemonSeriesHint()
      };
    }
  }

  // 4. 执行精确搜索 - One Piece
  if (game === 'onepiece') {
    console.log(`[Search] Using OPTCG number search`);
    const result = await searchOPTCGByNumber(query);
    console.log(`[Search] OPTCG result: found=${result.found}`);
    return result;
  }

  // 5. Pokemon 搜索
  if (game === 'pokemon') {
    console.log(`[Search] Using Pokemon number search`);
    const result = await searchPokemonByNumber(query);
    console.log(`[Search] Pokemon result: found=${result.found}`);

    // 如果未找到或 API 出错，提供系列列表提示
    if (!result.found) {
      if (result.apiError) {
        return {
          found: false,
          formatError: true,
          formatHint: `⚠️ **Pokemon API 暂时不可用**\n\nPokemon TCG API 当前无响应，请稍后重试或使用以下链接手动搜索。\n\n${getPokemonSeriesHint()}`
        };
      }
      // 未找到卡牌
      return {
        found: false,
        formatError: true,
        formatHint: `😅 **未找到该卡牌**\n\n请检查卡牌编号是否正确。\n\n${getPokemonSeriesHint()}`
      };
    }

    return result;
  }

  // 6. 其他游戏暂不支持
  return {
    found: false,
    formatError: true,
    formatHint: `❌ **游戏暂不支持**\n\n目前仅支持 One Piece 卡牌搜索。`
  };
}

// --- TCGPlayer API (多游戏支持 - Pokemon, Yu-Gi-Oh, Magic 等) ---
async function queryTCGPlayerPrice(card) {
  if (!TCGPLAYER_CLIENT_ID || !TCGPLAYER_CLIENT_SECRET) {
    return { found: false };
  }
  try {
    const token = await getTCGPlayerToken();
    if (!token) {
      console.error('TCGPlayer: Failed to get access token');
      return { found: false };
    }

    // 先搜索产品获取 ProductID
    const searchResp = await fetch(
      `https://api.tcgplayer.com/v2.0/catalog/products?productName=${encodeURIComponent(card.name_en)}&limit=5`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
    );

    if (!searchResp.ok) {
      console.error(`TCGPlayer search error: ${searchResp.status}`);
      return { found: false };
    }

    const searchData = await searchResp.json();

    if (searchData.results?.length > 0) {
      const product = searchData.results[0];
      const productId = product.productId;

      // 获取价格
      const priceResp = await fetch(
        `https://api.tcgplayer.com/v1.39/pricing/product/${productId}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
      );

      if (!priceResp.ok) {
        console.error(`TCGPlayer price error: ${priceResp.status}`);
        return { found: false };
      }

      const priceData = await priceResp.json();

      // 解析价格数据
      const prices = {};
      if (priceData.results?.length > 0) {
        for (const item of priceData.results) {
          const key = item.subTypeName || 'normal';
          prices[key] = {
            market: item.marketPrice,
            low: item.lowPrice,
            mid: item.midPrice,
            high: item.highPrice
          };
        }
      }

      return {
        found: true,
        name: product.name,
        set: product.productUrl?.split('/')?.[4] || card.set_name,
        number: product.productVariant || card.card_number,
        rarity: null,
        image: product.imageUrl || null,
        prices,
        source: 'TCGPlayer API',
        url: `https://www.tcgplayer.com/product/${productId}`,
      };
    }
    return { found: false };
  } catch (e) {
    console.error('TCGPlayer error:', e.message);
    return { found: false, error: e.message };
  }
}

// --- 根据价格历史生成 QuickChart.io 折线图 URL ---
function generatePriceChartUrl(priceHistory, cardName) {
  if (!priceHistory?.length) return null;

  // 最多取 30 个点，均匀采样避免 URL 过长
  const maxPoints = 30;
  const step = Math.max(1, Math.floor(priceHistory.length / maxPoints));
  const sampled = priceHistory.filter((_, i) => i % step === 0).slice(-maxPoints);

  const labels = sampled.map(pt => {
    const d = new Date(pt.t * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
  const prices = sampled.map(pt => Number(pt.p.toFixed(2)));

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const padding = (maxPrice - minPrice) * 0.15 || 1;

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Price (USD)',
        data: prices,
        fill: true,
        borderColor: '#5865F2',
        backgroundColor: 'rgba(88,101,242,0.15)',
        pointRadius: sampled.length > 15 ? 0 : 3,
        borderWidth: 2,
        tension: 0.3,
      }],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { fontSize: 10, maxTicksLimit: 8, fontColor: '#555' } }],
        yAxes: [{
          ticks: {
            fontSize: 10,
            fontColor: '#555',
            min: Math.max(0, Math.floor(minPrice - padding)),
            max: Math.ceil(maxPrice + padding),
          },
        }],
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?c=${encoded}&width=600&height=200&bkg=white`;
}

// ============================================================
// eBay API 模块（OAuth Client Credentials + Finding API 成交记录）
// ============================================================

// Token 缓存（有效期 2 小时，提前 1 分钟刷新）
let ebayTokenCache = { token: null, expiresAt: 0 };
// eBay 查询结果缓存（同一关键词 30 分钟内不重复请求）
const ebayQueryCache = new Map();
// 简单请求队列：同一时刻最多 1 个并发 eBay 请求，间隔 1 秒
let ebayLastCallAt = 0;
const EBAY_MIN_INTERVAL_MS = 1000;
// Rate limit 冷却：被限流后暂停 30 分钟
let ebayRateLimitedUntil = 0;
let ebayLock = false;

function ebayIsSandbox() {
  const appId = process.env.EBAY_APP_ID || '';
  return process.env.EBAY_SANDBOX === 'true'
    || appId.includes('-SBX-')
    || appId.toLowerCase().includes('sandbox');
}

async function getEbayToken() {
  if (ebayTokenCache.token && Date.now() < ebayTokenCache.expiresAt) {
    return ebayTokenCache.token;
  }

  const clientId = process.env.EBAY_APP_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || clientId === 'your_ebay_app_id_here' || !clientSecret || clientSecret === 'your_ebay_client_secret_here') {
    return null;
  }

  const isSandbox = ebayIsSandbox();
  const tokenUrl = isSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token';

  const base64 = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${base64}`,
      },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[eBay OAuth] Failed ${res.status}: ${err.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    ebayTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    console.log(`[eBay OAuth] Token obtained (${isSandbox ? 'Sandbox' : 'Production'}, expires in ${data.expires_in}s)`);
    return data.access_token;
  } catch (e) {
    console.error(`[eBay OAuth] Error: ${e.message}`);
    return null;
  }
}

// 特殊 sentinel：表示已被限流，让 safeEbayQuery 立即停止所有重试
const EBAY_RATE_LIMITED = Symbol('EBAY_RATE_LIMITED');

async function queryEbaySoldHistory(keyword) {
  // 被限流冷却中，直接跳过
  if (Date.now() < ebayRateLimitedUntil) {
    const remaining = Math.ceil((ebayRateLimitedUntil - Date.now()) / 60000);
    console.warn(`[eBay] Rate limited, cooling down ${remaining} min`);
    return EBAY_RATE_LIMITED;
  }

  // 命中缓存则直接返回（6 小时内同关键词不重复请求）
  const cacheKey = keyword.toLowerCase();
  const cached = ebayQueryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 6 * 60 * 60 * 1000) {
    console.log(`[eBay] Cache hit for "${keyword}"`);
    return cached.data;
  }

  const appId = process.env.EBAY_APP_ID;
  if (!appId || appId === 'your_ebay_app_id_here') return null;

  // 限速：两次请求间隔至少 1 秒
  const now = Date.now();
  const wait = EBAY_MIN_INTERVAL_MS - (now - ebayLastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  ebayLastCallAt = Date.now();

  const isSandbox = ebayIsSandbox();
  // Finding API findCompletedItems：唯一能准确获取真实成交价的接口
  const findingUrl = isSandbox
    ? 'https://svcs.sandbox.ebay.com/services/search/FindingService/v1'
    : 'https://svcs.ebay.com/services/search/FindingService/v1';

  const params = new URLSearchParams({
    'OPERATION-NAME': 'findCompletedItems',
    'SERVICE-VERSION': '1.0.0',
    'SECURITY-APPNAME': appId,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'keywords': keyword,
    'itemFilter(0).name': 'SoldItemsOnly',
    'itemFilter(0).value': 'true',
    'sortOrder': 'EndTimeSoonest',
    'paginationInput.entriesPerPage': '50',
    'paginationInput.pageNumber': '1',
  });

  try {
    console.log(`[eBay] Finding API ${isSandbox ? 'SANDBOX' : 'PROD'} keyword="${keyword}"`);
    const response = await fetch(`${findingUrl}?${params}`);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[eBay] HTTP ${response.status}: ${errText.substring(0, 300)}`);
      // 被限流：冷却 30 分钟，通知 safeEbayQuery 停止后续 fallback
      if (response.status === 500 && errText.includes('10001')) {
        ebayRateLimitedUntil = Date.now() + 30 * 60 * 1000;
        console.warn('[eBay] Rate limit hit, pausing all eBay queries for 30 min');
        return EBAY_RATE_LIMITED;
      }
      return null;
    }

    const data = await response.json();
    const ack = data?.findCompletedItemsResponse?.[0]?.ack?.[0];
    if (ack !== 'Success' && ack !== 'Warning') {
      const errMsg = data?.findCompletedItemsResponse?.[0]?.errorMessage?.[0]?.error?.[0]?.message?.[0] || ack;
      console.error(`[eBay] Finding API error: ${errMsg}`);
      return null;
    }

    const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    const sold = items
      .filter(item => item.sellingStatus?.[0]?.sellingState?.[0] === 'EndedWithSales')
      .map(item => ({
        price: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0),
        currency: item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'USD',
        date: item.listingInfo?.[0]?.endTime?.[0] || '',
        title: item.title?.[0] || '',
      }))
      .filter(item => item.price > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log(`[eBay] Finding API → ${sold.length} sold items`);
    const result = sold.length > 0 ? sold : null;
    ebayQueryCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch (e) {
    console.error(`[eBay] query error: ${e.message}`);
    return null;
  }
}

// 双阶段过滤异常价格
// 第一阶段：百分位截断（去掉最低 10% 和最高 10%）
// 第二阶段：中位数倍数限制（价格必须在中位数的 0.2x ~ 5x 之间）
function filterEbayOutliers(items) {
  if (!items || items.length < 4) return items;

  const sorted = [...items].sort((a, b) => a.price - b.price);

  // 阶段一：去掉底部和顶部 10%
  const trimCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);

  // 阶段二：中位数倍数限制
  const mid = trimmed[Math.floor(trimmed.length / 2)].price;
  const lo = mid * 0.2;
  const hi = mid * 5;
  const filtered = trimmed.filter(i => i.price >= lo && i.price <= hi);

  console.log(`[eBay] Outlier filter: ${items.length} → ${filtered.length} items (median $${mid.toFixed(0)}, range $${lo.toFixed(0)}~$${hi.toFixed(0)})`);
  return filtered.length >= 2 ? filtered : trimmed;
}

// 并发锁 + fallback 关键词的安全查询入口
async function safeEbayQuery(card) {
  // 等待锁释放（最多等 10 秒）
  const lockTimeout = Date.now() + 10000;
  while (ebayLock) {
    if (Date.now() > lockTimeout) {
      console.warn('[eBay] Lock timeout, skipping query');
      return null;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  ebayLock = true;
  try {
    const skw = card.search_keywords || {};
    const cardName = card.name_en || card.name_cn || '';
    const gameTag = card.game === 'pokemon' ? 'Pokemon card'
      : card.game === 'onepiece' ? 'One Piece card'
      : card.game === 'yugioh' ? 'Yu-Gi-Oh card'
      : 'trading card';
    // 包含 grade_label（如 PRISTINE）让关键词更精准
    const gradingSuffix = card.grading_company
      ? [card.grading_company, card.grade_label, card.grade].filter(Boolean).join(' ')
      : '';

    const setName = card.set_name || '';
    const cardNumber = (card.card_number || '').split('/')[0].trim();
    // variant：来自标签的变体信息（如 "2023 Champ. World Finals"）
    const variantStr = card.variant || '';

    // 第一次：{卡名} {系列} {variant} {编号} {评级}（与 Google/eBay 链接完全一致）
    const primaryKeyword = [cardName, setName, variantStr, cardNumber, gradingSuffix].filter(Boolean).join(' ');
    let result = await queryEbaySoldHistory(primaryKeyword);

    // 被限流 → 立刻停止所有 fallback
    if (result === EBAY_RATE_LIMITED) return null;

    // Fallback 1：去掉系列名，保留 variant + 编号 + 评级
    if (!result) {
      const fallback1 = [cardName, variantStr, cardNumber, gradingSuffix].filter(Boolean).join(' ');
      if (fallback1 !== primaryKeyword) {
        console.log(`[eBay] Fallback 1: "${fallback1}"`);
        result = await queryEbaySoldHistory(fallback1);
        if (result === EBAY_RATE_LIMITED) return null;
      }
    }

    // Fallback 2：仅角色名 + 评级（最宽松）
    if (!result) {
      const charName = skw.character || cardName;
      const fallback2 = [charName, gradingSuffix].filter(Boolean).join(' ');
      if (fallback2 !== primaryKeyword) {
        console.log(`[eBay] Fallback 2: "${fallback2}"`);
        result = await queryEbaySoldHistory(fallback2);
        if (result === EBAY_RATE_LIMITED) return null;
      }
    }

    return result;
  } finally {
    ebayLock = false;
  }
}

function generateEbayChartUrl(soldItems) {
  if (!soldItems || soldItems.length < 2) return null;

  const maxPoints = 30;
  const step = Math.max(1, Math.floor(soldItems.length / maxPoints));
  const sampled = soldItems.filter((_, i) => i % step === 0).slice(-maxPoints);

  const labels = sampled.map(item => {
    const d = new Date(item.date);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
  const prices = sampled.map(item => Number(item.price.toFixed(2)));

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const padding = (maxPrice - minPrice) * 0.15 || 5;

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'eBay Sold (USD)',
        data: prices,
        fill: true,
        borderColor: '#e53935',
        backgroundColor: 'rgba(229,57,53,0.12)',
        pointRadius: sampled.length > 15 ? 0 : 3,
        borderWidth: 2,
        tension: 0.3,
      }],
    },
    options: {
      legend: { display: true },
      scales: {
        xAxes: [{ ticks: { fontSize: 10, maxTicksLimit: 8, fontColor: '#555' } }],
        yAxes: [{
          ticks: {
            fontSize: 10,
            fontColor: '#555',
            min: Math.max(0, Math.floor(minPrice - padding)),
            max: Math.ceil(maxPrice + padding),
          },
        }],
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?c=${encoded}&width=600&height=200&bkg=white`;
}


// ============================================================
// 智能数据源路由器和健康监控
// ============================================================

// 数据源健康状态监控
const dataSourceHealth = {
  pokemonAPI: { healthy: true, lastCheck: 0, responseTime: 0, failures: 0 },
  tcgplayerAPI: { healthy: true, lastCheck: 0, responseTime: 0, failures: 0 },
  optcgAPI: { healthy: true, lastCheck: 0, responseTime: 0, failures: 0 },
};

// Pokemon 数据源链（外部 API 从中国服务器不可访问，已禁用）
const POKEMON_DATA_SOURCES = [];

// 智能路由：尝试所有数据源，返回最快成功的结果
async function queryPokemonWithFallback(card) {
  const startTime = Date.now();

  // 并行请求所有数据源
  const promises = POKEMON_DATA_SOURCES.map(async (source) => {
    const sourceStartTime = Date.now();
    try {
      const result = await Promise.race([
        source.fn(card),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 12000)
        )
      ]);

      const responseTime = Date.now() - sourceStartTime;

      if (result.found) {
        updateSourceHealth(source.key, true, responseTime);
        return { ...result, sourceName: source.name, responseTime };
      }
      updateSourceHealth(source.key, false, responseTime);
      return null;
    } catch (e) {
      const responseTime = Date.now() - sourceStartTime;
      updateSourceHealth(source.key, false, responseTime);
      console.error(`${source.name} error:`, e.message);
      return null;
    }
  });

  // 等待所有请求完成
  const results = await Promise.allSettled(promises);

  // 找出所有成功的结果
  const successResults = results
    .filter(r => r.status === 'fulfilled' && r.value?.found)
    .map(r => r.value);

  if (successResults.length > 0) {
    // 选择响应时间最快的结果
    const bestResult = successResults.sort((a, b) => a.responseTime - b.responseTime)[0];
    console.log(`✅ Price found from ${bestResult.sourceName} (${bestResult.responseTime}ms)`);
    return bestResult;
  }

  // 所有数据源都失败，返回搜索链接
  console.log('ℹ️ Pokemon 主数据源不可用，返回搜索链接');

  // 生成搜索链接
  const searchParts = [card.name_en];
  if (card.card_number) {
    searchParts.push(card.card_number.split('/')[0]);
  }
  if (card.set_name) {
    searchParts.push(card.set_name);
  }
  const searchQuery = searchParts.join(' ');

  return {
    found: true,
    name: card.name_en,
    set: card.set_name || 'Unknown',
    number: card.card_number || '???',
    rarity: card.rarity || null,
    image: null,
    prices: null, // 无价格数据
    source: 'Search Links (APIs unavailable)',
    // 提供多个搜索链接
    searchLinks: [
      { name: 'TCGPlayer', url: `https://www.tcgplayer.com/search/all?productLineName=pokemon&q=${encodeURIComponent(searchQuery)}` },
      { name: 'Google', url: `https://www.google.com/search?q=${encodeURIComponent(searchQuery + ' price')}` },
      { name: 'CardMarket', url: `https://www.cardmarket.com/en/Pokemon/Search?searchString=${encodeURIComponent(searchQuery)}` }
    ]
  };
}

function updateSourceHealth(key, healthy, responseTime) {
  if (dataSourceHealth[key]) {
    const current = dataSourceHealth[key];
    current.lastCheck = Date.now();
    current.responseTime = responseTime;
    if (healthy) {
      current.healthy = true;
      current.failures = 0;
    } else {
      current.failures++;
      // 连续失败 3 次标记为不健康
      if (current.failures >= 3) {
        current.healthy = false;
      }
    }
  }
}

// --- 路由：根据游戏类型查询价格 ---
async function getCardPrice(card) {
  console.log(`[getCardPrice] Game: ${card.game}, Card: ${card.name_en}`);
  switch (card.game) {
    case 'pokemon':
      // 使用智能多数据源
      return await queryPokemonWithFallback(card);
    case 'onepiece':
      return await queryOnePiecePrice(card);
    case 'yugioh':
      return await queryTCGPlayerPrice(card);
    default:
      return { found: false, source: 'Unknown game' };
  }
}

// ============================================================
// 核心模块 3: 构建 Discord Embed 回复
// ============================================================
const EMOJI = { pokemon: '⚡', onepiece: '🏴‍☠️', yugioh: '🃏', other: '🎴' };

// 辅助函数: 获取搜索类型标签
function getTypeLabel(type) {
  const labels = {
    news: '📰 新闻资讯',
    price_trend: '📈 价格趋势',
    release: '📦 发售信息',
    all: '🔍 全部'
  };
  return labels[type] || '🔍 全部';
}

// ============================================================
// 收藏价值评估函数
// ============================================================

// ============================================================
// 市场资讯查询函数
// ============================================================
async function getCardMarketInfo(card) {
  if (!ENABLE_WEB_SEARCH) return null;

  try {
    const gameNames = {
      'pokemon': 'Pokemon TCG',
      'onepiece': 'One Piece TCG',
      'yugioh': 'Yu-Gi-Oh TCG'
    };
    const gameName = gameNames[card.game] || card.game || 'TCG';

    // 构建搜索查询
    const searchTerms = [
      card.name_en,
      gameName,
      'price',
      'news'
    ].filter(Boolean).join(' ');

    const searchResults = await webSearch(searchTerms);

    if (searchResults.results && searchResults.results.length > 0) {
      const result = searchResults.results[0];
      return {
        title: result.title?.slice(0, 50) || '市场资讯',
        snippet: result.snippet?.slice(0, 120) || '暂无简介',
        url: result.url
      };
    }
  } catch (e) {
    console.error('Market info search error:', e.message);
  }
  return null;
}

// ============================================================
// 收藏价值多维评分系统
// ============================================================
const POKEMON_RARITY_SCORE = {
  'Common': 1, 'Uncommon': 2, 'Rare': 3, 'Holo Rare': 3.5,
  'Double Rare': 3.8, 'Illustration Rare': 4, 'Art Rare': 4,
  'Full Art': 4, 'Ultra Rare': 4.5, 'SAR': 5, 'Secret Rare': 5, 'Gold': 5,
};
const ONEPIECE_RARITY_SCORE = {
  'C': 1, 'UC': 2, 'R': 3, 'SR': 4, 'SEC': 4.8,
  'L': 3.5, 'SP': 5, 'Gold': 5, 'Manga': 6,
};
const VARIANT_SCORE = {
  normal: 1, full_art: 1.5, alt_art: 2, gold: 2.5, sp: 3, manga: 4,
};
const RELEASE_SCORE = { pack: 1, promo: 2, event: 3, tournament: 4 };
const TOP_CHARACTERS = [
  'charizard', 'pikachu', 'mewtwo', 'umbreon', 'eevee', 'gengar',
  'luffy', 'zoro', 'shanks', 'ace', 'whitebeard', 'kaido',
];

function getRarityScore(card) {
  const r = (card.rarity || '').trim();
  const rt = (card.release_type || '').toLowerCase();

  if (card.game === 'onepiece') return ONEPIECE_RARITY_SCORE[r] || 2;

  // Promo + event/tournament = 竞赛奖品卡（极其稀有），与普通促销卡区别对待
  if (r.toLowerCase() === 'promo') {
    const name = (card.name_en || card.name_cn || card.name_jp || '').toLowerCase();
    const set  = (card.set_name || '').toLowerCase();
    const isContestAward = rt === 'tournament' || rt === 'event'
      || name.includes('illustrator') || set.includes('illustrator')
      || name.includes('contest') || set.includes('contest')
      || name.includes('award') || set.includes('award');
    if (rt === 'tournament') return 6;
    if (isContestAward) return 5.5; // event 或关键词匹配的竞赛奖品卡
    return 2; // 普通促销卡（如麦当劳联名）
  }

  return POKEMON_RARITY_SCORE[r] || 2;
}

function getVariantScore(card) {
  const r = (card.rarity || '').toLowerCase();
  const set = (card.set_name || '').toLowerCase();
  if (r.includes('manga')) return VARIANT_SCORE.manga;
  if (r.includes('sp') || set.includes('sp')) return VARIANT_SCORE.sp;
  if (r.includes('gold') || r.includes('sar') || r.includes('secret')) return VARIANT_SCORE.gold;
  if (r.includes('alt art') || r.includes('alt_art')) return VARIANT_SCORE.alt_art;
  if (r.includes('full art') || r.includes('illustration') || r.includes('art rare')) return VARIANT_SCORE.full_art;
  return VARIANT_SCORE.normal;
}

function getReleaseScore(card) {
  const rt = (card.release_type || '').toLowerCase();
  const set = (card.set_name || '').toLowerCase();
  const name = (card.name_en || card.name_cn || card.name_jp || '').toLowerCase();

  if (rt === 'tournament' || set.includes('tournament') || set.includes('championship')
      || set.includes('world finals') || set.includes('world champ')) return RELEASE_SCORE.tournament;

  // 插画比赛/竞赛奖品卡 → event（即使 set_name 含 "promo"）
  if (rt === 'event' || set.includes('event') || set.includes('league')
      || name.includes('illustrator') || set.includes('illustrator')
      || name.includes('contest') || set.includes('contest')
      || name.includes('award') || set.includes('award')) return RELEASE_SCORE.event;

  if (rt === 'promo' || set.includes('promo') || (card.card_number || '').toUpperCase().includes('PR')) return RELEASE_SCORE.promo;
  return RELEASE_SCORE.pack;
}

function getPopularityScore(card) {
  const name = (card.character_name || card.name_en || card.name_cn || '').toLowerCase();
  if (TOP_CHARACTERS.some(c => name.includes(c))) return 3;
  // 主角/知名角色
  const known = ['nami', 'robin', 'sanji', 'chopper', 'brook', 'franky', 'ussop',
    'bulbasaur', 'charmander', 'squirtle', 'snorlax', 'mew', 'rayquaza'];
  if (known.some(c => name.includes(c))) return 2;
  return 1;
}

function gradeScore(grade) {
  if (!grade) return 0;
  const g = parseFloat(grade);
  if (g >= 10) return 3;
  if (g >= 9) return 2;
  if (g >= 8) return 1;
  return 0;
}

function calculateCollectibleValue(card) {
  const rarity     = getRarityScore(card);
  const variant    = getVariantScore(card);
  const release    = getReleaseScore(card);
  const popularity = getPopularityScore(card);
  const grade      = gradeScore(card.grade);

  // 基础分：稀有度 + 变体 + 人气 + 评级（不含发行类型）
  const base = rarity * 0.38 + variant * 0.24 + popularity * 0.22 + grade * 0.10;

  // 发行类型作为乘数：tournament/event 让竞赛奖品卡分数大幅拉高
  const relMultiplier = release >= 4 ? 1.45   // tournament
                      : release >= 3 ? 1.25   // event
                      : release >= 2 ? 1.05   // promo
                      : 1.00;                 // pack

  const total = base * relMultiplier + release * 0.06;

  if (total >= 3.8) return '收藏级珍品';
  if (total >= 2.8) return '高收藏价值';
  if (total >= 1.9) return '中等收藏价值';
  if (total >= 1.1) return '普通卡牌';
  return '基础卡牌';
}

/**
 * 程序化计算市场热度（5级🔥），基于角色人气 + 稀有度 + 评级 + 发行类型
 */
function calculateMarketPopularity(card) {
  const popularity = getPopularityScore(card);   // 1-3
  const rarity     = getRarityScore(card);        // 1-6
  const release    = getReleaseScore(card);        // 1-4
  const grade      = gradeScore(card.grade);       // 0-3

  // 综合热度分（加权，侧重人气与稀有度）
  const score = popularity * 0.45 + rarity * 0.30 + release * 0.15 + grade * 0.10;
  // score 理论范围：min ~0.55 (1*0.45+1*0.30+1*0.15+0*0.10) → max ~4.185 (3+6*0.30+4*0.15+3*0.10)
  if (score >= 3.5) return '🔥🔥🔥🔥🔥';
  if (score >= 2.8) return '🔥🔥🔥🔥';
  if (score >= 2.1) return '🔥🔥🔥';
  if (score >= 1.4) return '🔥🔥';
  return '🔥';
}

function buildPriceEmbed(card, priceResult, marketInfo = null, language = 'zh-CN', ebaySoldData = null) {
  const t = TRANSLATIONS[language] || TRANSLATIONS['zh-CN'];

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle(`${EMOJI[card.game] || '🎴'} ${card.name_en || card.name_cn}${t.title_suffix}`);

  const names = [card.name_cn, card.name_jp].filter(Boolean).join(' | ');
  if (names) embed.setDescription(names);

  // 评级信息（优先显示在最上方）
  if (card.grading_company && card.grade != null) {
    const gc = card.grading_company.toUpperCase();
    const certUrl = gc.includes('PSA')
      ? `https://www.psacard.com/cert/${card.cert_number}`
      : gc.includes('CGC')
      ? `https://www.cgccards.com/certlookup/${card.cert_number}/`
      : null;

    const gradeLine = `${card.grade_label ? card.grade_label + ' ' : ''}**${card.grade}**`;
    const certLine = (card.cert_number && certUrl)
      ? `[🔍 ${t.cert} #${card.cert_number}](${certUrl})`
      : card.cert_number ? `${t.cert} #${card.cert_number}` : null;

    embed.addFields({
      name: `🏆 ${card.grading_company} ${t.grading}`,
      value: [gradeLine, certLine].filter(Boolean).join('  ·  '),
      inline: false,
    });
  }

  // 卡牌信息（整合 AI 分析）
  const info = [
    (card.set_name) && `${t.series}: ${card.set_name}`,
    (card.card_number) && `${t.number}: ${card.card_number}`,
    (card.rarity) && `${t.rarity}: ${card.rarity}`,
  ].filter(Boolean);

  // 添加发布时间
  if (card.release_date) {
    info.push(`${t.release}: ${card.release_date}`);
  }

  {
    // 用多维评分系统计算，不依赖 Gemini 字符串
    const calcValue = calculateCollectibleValue(card);
    const starsMap = {
      '收藏级珍品': '⭐⭐⭐⭐⭐', '高收藏价值': '⭐⭐⭐⭐',
      '中等收藏价值': '⭐⭐⭐', '普通卡牌': '⭐⭐', '基础卡牌': '⭐',
    };
    info.push(`${t.collectible}: ${starsMap[calcValue]}`);
  }
  info.push(`${t.popularity}: ${calculateMarketPopularity(card)}`);

  info.push(t.warning);

  if (info.length) {
    embed.addFields({
      name: t.card_info || '📋 卡牌信息',
      value: info.join('\n')
    });
  }

  // 简介：AI 生成的自然段落（已整合效果文字）
  if (card.description) {
    const introValue = card.description.length > 1024
      ? card.description.substring(0, 1021) + '...'
      : card.description;
    embed.addFields({
      name: t.intro || '💬 简介',
      value: introValue,
    });
  }

  // 值得关注的卡牌（同系列或同角色）
  if (card.related_cards && Array.isArray(card.related_cards) && card.related_cards.length > 0) {
    // 去重（同名卡只保留第一条）
    const seen = new Set();
    const deduped = card.related_cards.filter(c => {
      if (!c.name || seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });
    if (deduped.length > 0) {
      const relatedText = deduped.map(c => {
        const googleSearch = `https://www.google.com/search?q=${encodeURIComponent(c.name + ' ' + (card.game === 'pokemon' ? 'pokemon card' : 'card') + ' price')}`;
        return `• [**${c.name}**](${googleSearch}) - ${c.reason}`;
      }).join('\n');
      embed.addFields({
        name: t.related,
        value: relatedText,
      });
    }
  }

  // 搜索链接（优先用 Gemini 提供的 search_keywords）
  const skw = card.search_keywords || {};
  const kwChar = skw.character || card.character_name || card.name_en || card.name_cn || '';
  const variantStr = card.variant || '';
  // 基础完整关键词（含 variant）
  const baseKwFull = [
    card.name_en || card.name_cn || '',
    card.set_name || '',
    variantStr,
    card.card_number || '',
  ].filter(Boolean).join(' ');
  const kwFull = skw.full ? `${skw.full} ${variantStr}`.trim() : baseKwFull;
  // 含 grade_label（PRISTINE / GEM MT）让搜索结果更精准
  const gradingSuffix = card.grading_company
    ? [card.grading_company, card.grade_label, card.grade].filter(Boolean).join(' ')
    : '';

  const googleCharUrl = `https://www.google.com/search?q=${encodeURIComponent(kwChar + (card.game === 'pokemon' ? ' pokemon card price' : ' card price'))}`;
  const fullSearchKw = [kwFull, gradingSuffix].filter(Boolean).join(' ');
  const googleFullUrl = `https://www.google.com/search?q=${encodeURIComponent(fullSearchKw + ' price')}`;
  const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(fullSearchKw)}&LH_Sold=1`;

  // 判断是否为拍卖级高价卡（⭐⭐⭐⭐⭐ + tournament/event 发行）
  const isAuctionTier = calculateCollectibleValue(card) === '收藏级珍品'
    && ['tournament', 'event'].includes((card.release_type || '').toLowerCase());

  const priceQueryLines = [
    `[${t.name_only}](${googleCharUrl}) | [${t.full_info}](${googleFullUrl})`,
    `[${t.ebay_sold}](${ebayUrl})`,
  ];

  embed.addFields({
    name: t.price_query,
    value: priceQueryLines.join('\n'),
  });

  // eBay 真实成交折线图
  if (ebaySoldData && ebaySoldData.length >= 2) {
    const cleanData = filterEbayOutliers(ebaySoldData);
    const ebayChartUrl = generateEbayChartUrl(cleanData);
    if (ebayChartUrl) {
      const prices = cleanData.map(i => i.price);
      const avgPrice = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
      const minP = Math.min(...prices).toFixed(2);
      const maxP = Math.max(...prices).toFixed(2);
      embed.addFields({
        name: t.ebay_chart || '📊 eBay 成交走势',
        value: t.ebay_chart_stats
          ? t.ebay_chart_stats(cleanData.length, avgPrice, minP, maxP)
          : `最近 ${cleanData.length} 笔 · 均价 **$${avgPrice}** · 区间 $${minP} ~ $${maxP}`,
      });
      embed.setImage(ebayChartUrl);
    }
  }

  // 新增: 显示 API 返回的额外信息
  if (priceResult && priceResult.found) {
    const detailFields = [];

    // 基本详情
    const basicDetails = [];
    if (priceResult.releaseDate) basicDetails.push(`${t.release_date}: ${priceResult.releaseDate}`);
    if (priceResult.artist) basicDetails.push(`${t.artist}: ${priceResult.artist}`);
    if (priceResult.set && !card.set_name) basicDetails.push(`${t.set_name}: ${priceResult.set}`);
    if (basicDetails.length) {
      detailFields.push({ name: t.basic_details, value: basicDetails.join('\n') });
    }

    // Pokemon 特有信息
    if (priceResult.extraInfo && card.game === 'pokemon') {
      const info = priceResult.extraInfo;
      const pokemonDetails = [];

      if (info.types) pokemonDetails.push(`${t.types}: ${info.types.join(', ')}`);
      if (info.hp) pokemonDetails.push(`${t.hp}: ${info.hp}`);
      if (info.set?.series) pokemonDetails.push(`${t.series_info}: ${info.set.series}`);
      if (info.set?.ptcgoCode) pokemonDetails.push(`${t.code}: ${info.set.ptcgoCode}`);

      // 比赛合法性 - 扩展显示
      if (info.legalities) {
        const formats = [];

        // Standard 赛制
        if (info.legalities.standard === 'Legal') formats.push(`${t.legal} Standard`);
        else if (info.legalities.standard === 'Banned') formats.push(`${t.banned} Standard`);

        // Expanded 赛制
        if (info.legalities.expanded === 'Legal') formats.push(`${t.legal} Expanded`);
        else if (info.legalities.expanded === 'Banned') formats.push(`${t.banned} Expanded`);

        // Unlimited 赛制 (几乎所有卡都合法)
        if (info.legalities.unlimited === 'Legal') formats.push(`${t.legal} Unlimited`);

        // Legacy 赛制
        if (info.legalities.legacy === 'Legal') formats.push(`${t.legal} Legacy`);

        if (formats.length) {
          pokemonDetails.push(`${t.formats}: ${formats.join(' | ')}`);
        }
      }

      if (pokemonDetails.length) {
        detailFields.push({ name: t.pokemon_details, value: pokemonDetails.join('\n') });
      }

      // 招式信息 (最多显示前2个)
      if (info.attacks && info.attacks.length > 0) {
        const attackText = info.attacks.slice(0, 2).map(a => {
          const cost = a.cost ? a.cost.join('') : '';
          const dmg = a.damage ? ` (${a.damage})` : '';
          return `${cost} ${a.name}${dmg}`;
        }).join('\n');
        detailFields.push({ name: t.attacks, value: attackText, inline: false });
      }

      // 弱点
      if (info.weaknesses && info.weaknesses.length > 0) {
        const weakText = info.weaknesses.map(w => `${w.type} ${w.value}`).join(', ');
        detailFields.push({ name: t.weakness, value: weakText });
      }

      // 卡牌描述文字 (如果有)
      if (info.flavorText) {
        detailFields.push({ name: t.card_description, value: info.flavorText.slice(0, 100) + (info.flavorText.length > 100 ? '...' : '') });
      }

      // 系列详细信息（新）
      if (info.set) {
        const setInfo = [];

        // 系列名称
        if (info.set.name && info.set.name !== card.set_name) {
          setInfo.push(`📖 ${info.set.name}`);
        }

        // 编号/总数
        if (info.set.printedTotal && priceResult.number) {
          const currentNum = priceResult.number?.split('/')[0] || '?';
          setInfo.push(`📚 编号: ${currentNum}/${info.set.printedTotal}`);
        }

        // 发售日期和距今年数
        if (info.set.releaseDate) {
          const releaseDate = new Date(info.set.releaseDate);
          const yearsAgo = Math.floor((Date.now() - releaseDate) / (365 * 24 * 60 * 60 * 1000));
          const month = String(releaseDate.getMonth() + 1).padStart(2, '0');
          const day = String(releaseDate.getDate()).padStart(2, '0');
          const year = releaseDate.getFullYear();
          setInfo.push(`📅 发售: ${year}-${month}-${day} (${yearsAgo}年前)`);
        }

        if (setInfo.length) {
          detailFields.push({ name: t.set_details, value: setInfo.join('\n'), inline: false });
        }
      }
    }

    // One Piece 特有信息（不重复显示基本信息）
    // 基本信息（系列、编号、稀有度）已在 "📋 卡牌信息" 字段中显示
    // 这里只添加额外的 One Piece API 特有信息

    // 添加所有详情字段
    if (detailFields.length > 0) {
      // Discord 最多允许 25 个字段，需要限制
      const maxFields = 8;
      detailFields.slice(0, maxFields).forEach(field => {
        embed.addFields(field);
      });
    }

    // 价格趋势信息（如果可用）
    if (priceResult.priceTrend) {
      const trendInfo = [];
      if (priceResult.priceTrend.week1) trendInfo.push(`1周: ${priceResult.priceTrend.week1}`);
      if (priceResult.priceTrend.month1) trendInfo.push(`1月: ${priceResult.priceTrend.month1}`);
      if (trendInfo.length) {
        embed.addFields({
          name: '📈 价格趋势',
          value: trendInfo.join(' | ')
        });
      }
    }
  }

  // 如果 API 查询失败，添加搜索链接提示
  if (priceResult && !priceResult.found) {
    if (priceResult.searchLinks) {
      const links = priceResult.searchLinks.map(l => `[${l.name}](${l.url})`).join(' | ');
      embed.addFields({
        name: '🔗 搜索卡牌价格',
        value: `API 暂时无法访问，请使用以下链接搜索价格:\n${links}`
      });
    }
  }

  // 价格信息 - 显示 API 查询的真实价格（海贼王不显示）
  if (card.game !== 'onepiece' && priceResult && priceResult.found && priceResult.prices) {
    const p = priceResult.prices;
    const price = p.market || Object.values(p)[0]?.market || p.low || p.mid || p.high;
    const priceText = price ? `$${price.toFixed(2)} USD` : '暂无价格数据';
    embed.addFields({
      name: t.market_price,
      value: `**${priceText}**\n${t.data_source}: ${priceResult.source}`
    });
    if (priceResult.url) {
      embed.addFields({ name: '🔗 购买链接', value: `[查看 TCGPlayer](${priceResult.url})` });
    }

    // 价格趋势信息（如果可用）
    if (priceResult.priceTrend) {
      const trendInfo = [];
      if (priceResult.priceTrend.week1) trendInfo.push(`1周: ${priceResult.priceTrend.week1}`);
      if (priceResult.priceTrend.month1) trendInfo.push(`1月: ${priceResult.priceTrend.month1}`);
      if (trendInfo.length) {
        embed.addFields({
          name: '📈 价格趋势',
          value: trendInfo.join(' | ')
        });
      }
    }

    // 显示卡牌图片（如果有）
    if (priceResult.image) {
      embed.setImage(priceResult.image);
    }
  }


  // Store card data in footer for translation functionality (base64 encoded)
  const cardDataForStorage = {
    game: card.game,
    name_en: card.name_en,
    name_jp: card.name_jp,
    name_cn: card.name_cn,
    character_name: card.character_name ?? null,
    set_name: card.set_name,
    card_number: card.card_number,
    rarity: card.rarity,
    language: card.language ?? null,
    release_date: card.release_date ?? null,
    collectible_value: card.collectible_value ?? null,
    market_popularity: card.market_popularity ?? null,
    grading_company: card.grading_company ?? null,
    grade: card.grade ?? null,
    grade_label: card.grade_label ?? null,
    variant: card.variant ?? null,
    cert_number: card.cert_number ?? null,
    release_type: card.release_type ?? null,
    effect_text: card.effect_text ?? null,
    description: card.description ?? null,
    search_keywords: card.search_keywords ?? null,
    related_cards: card.related_cards ?? null,
    priceResult: priceResult,
  };
  const cardDataJSON = JSON.stringify(cardDataForStorage);
  const cardDataBase64 = Buffer.from(cardDataJSON).toString('base64');

  const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
  embed.setFooter({ text: `${t.pack_wish || '🧧 祝你开包大吉！'} | ${t.warning} | ⚡ Powered by Gemini Vision | ${nowStr} UTC` });
  embed.data.cardData = cardDataBase64; // Store in embed data
  return embed;
}

// ============================================================
// 搜索结果 Embed 构建函数（支持多语言）
// ============================================================
function buildSearchEmbed(searchResult, query, game, language = 'zh-CN') {
  const t = TRANSLATIONS[language] || TRANSLATIONS['zh-CN'];

  // 格式错误或未找到
  if (searchResult.formatError || !searchResult.found) {
    const embed = new EmbedBuilder()
      .setColor(0xff6b6b)
      .setTitle(`${t.search_result_title}: ${query}`)
      .setDescription(searchResult.formatHint || '😅 未找到匹配的卡牌，请检查卡牌编号是否正确。');
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query + ' ' + game + ' card')}`;
    embed.addFields({
      name: t.manual_search,
      value: `[Google](${googleUrl})`
    });
    return [embed];
  }

  // 多版本结果（One Piece 同一编号的不同版本）
  if (searchResult.multiple) {
    const cards = searchResult.cards;
    const embeds = [];
    const summaryEmbed = new EmbedBuilder()
      .setColor(0x00bfff)
      .setTitle(`${t.search_result_title}: ${query}`)
      .setDescription(`📋 ${t.found_versions.replace('{n}', cards.length)}`)
      .setFooter({ text: `${t.pack_wish || '🧧 祝你开包大吉！'} | ${t.warning} | ⚡ ${t.data_source}: OPTCG API | ${new Date().toISOString().replace('T', ' ').substring(0, 16)} UTC` });
    embeds.push(summaryEmbed);

    cards.forEach((card, index) => {
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle(`${t.version} ${index + 1}: ${card.name}`);
      const info = [
        (card.name) && `${t.name_label}: ${card.name}`,
        (card.set) && `${t.series}: ${card.set}`,
        (card.number) && `${t.number}: ${card.number}`,
        (card.rarity) && `${t.rarity}: ${card.rarity}`,
      ].filter(Boolean);
      if (card.card_color) info.push(`${t.color}: ${card.card_color}`);
      if (card.card_type) info.push(`${t.card_type}: ${card.card_type}`);
      if (card.card_cost) info.push(`${t.cost}: ${card.card_cost}`);
      if (card.card_power) info.push(`${t.power}: ${card.card_power}`);
      if (card.prices && card.prices.market) {
        info.push(`${t.market_price}: $${card.prices.market.toFixed(2)} USD`);
      }
      if (info.length) {
        embed.addFields({ name: t.card_info || '📋 卡牌信息', value: info.join('\n') });
      }
      if (card.image) embed.setImage(card.image);
      embeds.push(embed);
    });
    return embeds.slice(0, 10);
  }

  // 单张卡牌结果
  const card = searchResult;
  const embed = new EmbedBuilder()
    .setColor(0x00bfff)
    .setTitle(`${t.search_result_title}: ${query}`);
  const info = [
    (card.name) && `${t.name_label}: ${card.name}`,
    (card.set) && `${t.series}: ${card.set}`,
    (card.number) && `${t.number}: ${card.number}`,
    (card.rarity) && `${t.rarity}: ${card.rarity}`,
  ].filter(Boolean);
  if (card.card_color) info.push(`${t.color}: ${card.card_color}`);
  if (card.card_type) info.push(`${t.card_type}: ${card.card_type}`);
  if (card.card_cost) info.push(`${t.cost}: ${card.card_cost}`);
  if (card.card_power) info.push(`${t.power}: ${card.card_power}`);
  if (card.hp) info.push(`${t.hp}: ${card.hp}`);
  if (card.types && Array.isArray(card.types)) info.push(`${t.types}: ${card.types.join(', ')}`);
  if (card.prices && card.prices.market) {
    info.push(`${t.market_price}: $${card.prices.market.toFixed(2)} USD`);
  }
  if (info.length) {
    embed.addFields({ name: t.card_info || '📋 卡牌信息', value: info.join('\n') });
  }
  if (card.image) embed.setImage(card.image);
  embed.setFooter({ text: `${t.pack_wish || '🧧 祝你开包大吉！'} | ${t.warning} | ⚡ ${t.data_source}: ${card.source || 'OPTCG API'} | ${new Date().toISOString().replace('T', ' ').substring(0, 16)} UTC` });
  return [embed];
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
    const priceResult = await getCardPrice(card);

    // 将查询结果附到 card 上，供后续翻译时重建 embed 使用
    card.priceResult = priceResult;

    // 获取市场资讯（异步，不阻塞）
    let marketInfo = null;
    if (ENABLE_WEB_SEARCH && priceResult.found) {
      try {
        marketInfo = await getCardMarketInfo(card);
      } catch (e) {
        console.error('Market info fetch error:', e.message);
      }
    }

    // eBay 真实成交记录
    let ebaySoldData = null;
    if (process.env.EBAY_APP_ID && process.env.EBAY_APP_ID !== 'your_ebay_app_id_here') {
      try {
        ebaySoldData = await safeEbayQuery(card);
      } catch (e) {
        console.error('eBay query error:', e.message);
      }
    }

    card.ebaySoldData = ebaySoldData;
    embeds.push(buildPriceEmbed(card, priceResult, marketInfo, 'zh-CN', ebaySoldData));
  }

  return { cards, embeds };
}

// ============================================================
// Discord: 消息触发 (!scan + 图片, !search + 编号)
// ============================================================
discord.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  const isScan = msg.content.toLowerCase().startsWith('!scan');
  const isSearch = msg.content.toLowerCase().startsWith('!search');
  const isAuto = msg.channel.name === 'card-pulls';
  if (!isScan && !isSearch && !isAuto) return;

  // 处理 !search 命令
  if (isSearch) {
    // 提取卡牌编号
    const args = msg.content.split(' ');
    const cardNumber = args[1]?.trim();

    if (!cardNumber) {
      msg.reply('请输入卡牌编号！格式：`!search <编号>`\n例如：`!search OP01-001`');
      return;
    }

    msg.reply(`🔍 正在搜索: ${cardNumber}...`).then(reply => {
      searchCard(cardNumber, 'onepiece').then(searchResult => {
        const embeds = buildSearchEmbed(searchResult, cardNumber, 'onepiece');
        reply.edit({ embeds: embeds.slice(0, 10), components: [createTranslationButtons()] })
          .then(editedMsg => { cacheSearchDataForMessage(editedMsg.id, searchResult, cardNumber, 'onepiece'); })
          .catch(e => {
            console.error('Error:', e);
            reply.edit('❌ 搜索出错了，请稍后重试。');
          });
      });
    });
    return;
  }

  // 处理 !scan 命令和自动扫描
  // 确定要处理的图片URL
  let imageUrl = null;

  // 情况1: 直接发送图片 + !scan
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
    msg.reply('请上传卡牌截图，或回复一张包含截图的消息！📸');
    return;
  }

  const reply = await msg.reply('🔍 Identifying card...');

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

    const editedMsg = await reply.edit({ content: '✅ Done!', embeds: embeds.slice(0, 10), components: [createTranslationButtons()] });
    cacheCardDataForMessage(editedMsg.id, cards.slice(0, 10));
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
      .setName('scan')
      .setDescription('📸 扫描卡牌图片并查询价格')
      .addAttachmentOption(o => o.setName('image').setDescription('卡牌截图').setRequired(true))
      .addStringOption(o => o.setName('game').setDescription('指定游戏 (可选)')
        .addChoices(
          { name: 'Pokemon', value: 'pokemon' },
          { name: 'One Piece', value: 'onepiece' },
        )),
    new SlashCommandBuilder()
      .setName('search')
      .setDescription('🔍 精确卡牌编号搜索 (Pokemon API暂不可用)')
      .addStringOption(o => o.setName('game').setDescription('选择游戏类型 (⚠️ Pokemon API暂不可用)').setRequired(true)
        .addChoices(
          { name: 'One Piece', value: 'onepiece' },
          { name: 'Pokemon ⚠️ API暂不可用', value: 'pokemon' },
        ))
      .addStringOption(o => o.setName('query').setDescription('卡牌编号 (One Piece: OP01-001 | Pokemon: swsh4-136)').setRequired(true)),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_APP_ID), { body: cmds.map(c => c.toJSON()) });
    console.log('✅ Slash Commands 注册成功');
  } catch (e) { console.error('注册命令失败:', e); }
}

discord.on(Events.InteractionCreate, async (i) => {
  // 处理翻译按钮点击（优先用内存缓存，因 Discord 不保存 embed 自定义 cardData）
  if (i.isButton() && i.customId.startsWith('translate_')) {
    console.log('🔔 Translation button clicked:', i.customId);
    const language = i.customId.replace('translate_', '');

    try {
      await i.deferUpdate();

      const messageId = i.message?.id;
      const cached = messageId ? messageCardDataCache.get(String(messageId)) : null;

      // Search 结果：直接按语言重建 embed，无需 Gemini
      if (cached && cached.type === 'search') {
        const translatedEmbeds = buildSearchEmbed(cached.searchResult, cached.query, cached.game, language);
        await i.editReply({ content: '', embeds: translatedEmbeds, components: [createTranslationButtons()] });
        console.log(`✅ Search result translated to ${language}`);
        return;
      }

      // Scan 结果：使用卡牌数据数组
      let cardDataArray = Array.isArray(cached) ? cached : null;
      if (!cardDataArray?.length && i.message?.embeds?.length) {
        cardDataArray = [];
        for (const embed of i.message.embeds) {
          const raw = embed.data?.cardData ?? embed.cardData;
          if (!raw) continue;
          try {
            cardDataArray.push(JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')));
          } catch (_) {}
        }
      }

      if (!cardDataArray?.length) {
        await i.editReply({
          content: '❌ 无法获取原始卡牌数据，请重新扫描/搜索后再使用翻译。',
          components: [createTranslationButtons()]
        });
        return;
      }

      // 非简体中文时用 Gemini 翻译卡牌正文
      let cardsToShow = cardDataArray;
      if (language !== 'zh-CN') {
        const langLabel = language === 'zh-TW' ? '繁體中文' : language === 'en-US' ? 'English' : '한국어';
        await i.editReply({ content: `🔄 Translating to ${langLabel}…`, embeds: [], components: [] }).catch(() => {});
        const results = await Promise.allSettled(
          cardDataArray.map(card => translateCardContentWithGemini(card, language))
        );
        cardsToShow = results.map((r, idx) => (r.status === 'fulfilled' ? r.value : cardDataArray[idx]));
      }

      const translatedEmbeds = cardsToShow.map(cardData =>
        buildPriceEmbed(cardData, cardData.priceResult, null, language, cardData.ebaySoldData ?? null)
      );

      await i.editReply({
        content: '',
        embeds: translatedEmbeds,
        components: [createTranslationButtons()]
      });

      console.log(`✅ Successfully translated to ${language}`);
    } catch (error) {
      console.error('Translation button error:', error);
      await i.editReply({
        content: '❌ 翻译失败，请稍后重试。',
        components: [createTranslationButtons()]
      });
    }
    return;
  }

  if (!i.isChatInputCommand()) return;

  try {
    if (i.commandName === 'scan') {
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

        console.log('📤 Sending reply with translation buttons...');
        const sentMsg = await i.editReply({
          embeds: embeds.slice(0, 10),
          components: [createTranslationButtons()]
        });
        cacheCardDataForMessage(sentMsg.id, cards.slice(0, 10));
        console.log('✅ Reply sent with buttons');
      } catch (e) { console.error(e); await i.editReply('❌ 出错了，请稍后重试'); }
    }

    // search 命令处理
    if (i.commandName === 'search') {
      await i.deferReply();
      try {
        const query = i.options.getString('query');
        const game = i.options.getString('game');

        console.log(`[Search Command] Query: ${query}, Game: ${game}`);

        // 调用搜索
        const searchResult = await searchCard(query, game);

        // 构建回复并加翻译按钮
        const embeds = buildSearchEmbed(searchResult, query, game);
        const sentMsg = await i.editReply({
          embeds: embeds.slice(0, 10),
          components: [createTranslationButtons()]
        });
        cacheSearchDataForMessage(sentMsg.id, searchResult, query, game);
      } catch (e) {
        console.error('[Search] Error:', e);
        await i.editReply('❌ 搜索出错了，请稍后重试。');
      }
    }

    // market 命令处理 - PSA 评级卡片市场报告
    if (i.commandName === 'market') {
      await i.deferReply();
      try {
        const cardInput = i.options.getString('card');
        const numberInput = i.options.getString('number') || '';
        const setInput = i.options.getString('set') || '';
        const grade = i.options.getString('grade') || 'PSA 10';
        const region = i.options.getString('region') || 'en';
        const isJapanese = region === 'jp';

        console.log(`[Market] card="${cardInput}" number="${numberInput}" set="${setInput}" grade="${grade}" jp=${isJapanese}`);

        await i.editReply(`🔍 正在查詢 **${cardInput}${numberInput ? ' ' + numberInput : ''}** ${grade} 市場報告...`);

        // 构建临时卡牌对象
        const card = {
          game: 'pokemon',
          name_en: cardInput,
          name_jp: isJapanese ? cardInput : null,
          name_cn: cardInput,
          card_number: numberInput,
          set_name: setInput,
          release_date: null,
          artist: null,
          market_popularity: null,
          highlights: null,
          collectible_value: null,
          competitive_usage: null,
          description: null,
        };

        // 并行查询 PriceCharting + SNKRDUNK 链接
        const [pcResult, snkrResult] = await Promise.all([
          queryPriceCharting(cardInput, numberInput, setInput, isJapanese),
          querySNKRDUNK(cardInput, numberInput, grade),
        ]);

        const report = buildMarketReportText(card, pcResult, snkrResult, grade);

        // Discord 消息最多 2000 字符
        await i.editReply(report.length > 1990 ? report.substring(0, 1990) + '\n...(內容已截斷)' : report);
        console.log(`[Market] Report generated, length: ${report.length}`);
      } catch (e) {
        console.error('[Market] Error:', e);
        await i.editReply('❌ 查詢失敗，請稍後重試。');
      }
    }
  } catch (error) {
    // 处理 Unknown interaction 等错误 - 不要让 bot 崩溃
    if (error.code === 10062 || error.message?.includes('Unknown interaction')) {
      console.log('Interaction expired or already handled');
    } else {
      console.error('Interaction error:', error);
    }
  }
});

// ============================================================
// 启动
// ============================================================
discord.on(Events.ClientReady, () => {
  console.log(`✅ Bot 上线: ${discord.user.tag}`);
  // 测试按钮函数
  try {
    console.log('🧪 Testing createTranslationButtons() function...');
    const testButtons = createTranslationButtons();
    console.log('✅ Button function works! Button data:', JSON.stringify(testButtons));
  } catch (error) {
    console.error('❌ Button function error:', error);
  }
});
console.log('📡 正在注册 Slash 命令...');
registerCommands();
console.log('🔐 正在连接 Discord...');
discord.login(process.env.DISCORD_TOKEN);

// ============================================================
// 💡 成本估算
// ============================================================
//
// ┌──────────────────────────────────────────────────────────┐
// │  Gemini 免费层                                            │
// │  • gemini-2.5-flash: ~15-50次请求/天                       │
// │  • gemini-2.5-flash-lite: ~1500次请求/天 (推荐)           │
// │  • 每张图片识别: ~1-2秒                                    │
// │                                                          │
// │  价格 API: 全部免费                                        │
// │  • Pokemon TCG API: 免费                                   │
// │  • OPTCG API: 免费                                         │
// │                                                          │
// │  总计: 小规模 = 完全免费 🎉                                 │
// └──────────────────────────────────────────────────────────┘
