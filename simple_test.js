import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Events } from 'discord.js';

// 直接加载 .env.test
dotenv.config({ path: '.env.test' });

console.log('🔍 测试 Discord 连接...');
console.log(`🔑 Token: ${process.env.DISCORD_TOKEN?.substring(0, 20)}...`);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.ClientReady, () => {
  console.log(`✅ 成功连接 Discord!`);
  console.log(`🤖 Bot 名称: ${client.user.tag}`);
  console.log(`🆔 Bot ID: ${client.user.id}`);
  process.exit(0);
});

client.on(Events.Error, (error) => {
  console.error('❌ Discord 错误:', error.message);
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('❌ 登录失败:', error.message);
  process.exit(1);
});

// 超时处理
setTimeout(() => {
  console.error('❌ 连接超时 (15秒)');
  process.exit(1);
}, 15000);
