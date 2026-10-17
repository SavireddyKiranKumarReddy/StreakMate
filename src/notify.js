// Credentials read lazily so dotenv.config() timing never matters.
const creds = () => ({
  BOT: process.env.TELEGRAM_BOT_TOKEN,
  CHAT: process.env.TELEGRAM_CHAT_ID,
});

export async function tg(text) {
  const { BOT, CHAT } = creds();
  if (!BOT || !CHAT) { console.log('TG skip (no creds):', text); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML' }),
    });
    console.log('TG sent:', r.status);
  } catch (e) { console.log('TG send fail:', e.message); }
}

export async function tgPhoto(path, caption) {
  const { BOT, CHAT } = creds();
  if (!BOT || !CHAT) return;
  try {
    const fs = await import('fs');
    const blob = new Blob([fs.readFileSync(path)]);
    const fd = new FormData();
    fd.append('chat_id', CHAT);
    fd.append('caption', (caption || '').slice(0, 900));
    fd.append('photo', blob, 'shot.png');
    const r = await fetch(`https://api.telegram.org/bot${BOT}/sendPhoto`, { method: 'POST', body: fd });
    console.log('TG photo sent:', r.status);
  } catch (e) { console.log('TG photo fail:', e.message); }
}
