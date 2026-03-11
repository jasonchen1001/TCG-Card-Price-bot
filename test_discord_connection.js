// 测试 Discord token 是否有效
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Events } from 'discord.js';

// 加载测试配置
const envPath = process.argv[2] || '.env';
dotenv.config({ path: envPath });

console.log('🔍 测试 Discord 连接...');
console.log(`📝 配置文件: ${envPath}`);
console.log(`🔑 Token: ${process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.substring(0, 10) + '...' : '未设置'}`);

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ 错误: DISCORD_TOKEN 未设置');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

client.on(Events.ClientReady, () => {
  console.log(`✅ 连接成功! Bot: ${client.user.tag}`);
  console.log(`📊 Bot ID: ${client.user.id}`);
  client.destroy();
  process.exit(0);
});

client.on(Events.Error, (error) => {
  console.error('❌ Discord 错误:', error.message);
  client.destroy();
  process.exit(1);
});

// 连接超时处理
setTimeout(() => {
  console.error('❌ 连接超时 (10秒)');
  client.destroy();
  process.exit(1);
}, 10000);

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('❌ 登录失败:', error.message);
  process.exit(1);
});
