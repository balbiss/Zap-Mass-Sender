import express from "express";
import { Telegraf, Markup } from "telegraf";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

dotenv.config();

const app = express();
app.use(express.json());

// --- Configs ---
const PORT = process.env.PORT || 8899;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL;
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const SYNCPAY_CLIENT_ID = "c2687695-57c9-4f3e-8d59-36fbdabb0a44";
const SYNCPAY_CLIENT_SECRET = "42f39fd6-00bc-4f11-96d7-e98e4db9b93a";
const SYNC_BASE_URL = "https://api.syncpayments.com.br";

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Erro: Variáveis de ambiente faltando.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(TELEGRAM_TOKEN);

// --- Utils ---
async function getSystemConfig() {
    const { data } = await supabase.from('bot_sessions').select('data').eq('chat_id', 'ZAPMASS_CONFIG').single();
    if (data) return data.data;
    const cfg = { dailyPrice: 5.00, defaultMaxInstances: 1 };
    await supabase.from('bot_sessions').upsert({ chat_id: 'ZAPMASS_CONFIG', data: cfg });
    return cfg;
}

async function getSession(chatId) {
    const id = `ZAPMASS_${chatId}`;
    const { data } = await supabase.from('bot_sessions').select('data').eq('chat_id', id).single();
    if (data) return data.data;
    const s = { stage: "START", isVip: false, subscriptionExpiry: null, maxInstances: null, whatsapp: { instances: [] } };
    await supabase.from('bot_sessions').upsert({ chat_id: id, data: s });
    return s;
}

async function saveSession(chatId, s) {
    await supabase.from('bot_sessions').upsert({ chat_id: `ZAPMASS_${chatId}`, data: s, updated_at: new Date().toISOString() });
}

// --- Bot Logic ---
const isAdmin = (ctx) => {
    const userID = String(ctx.chat.id);
    const adminID = String(ADMIN_CHAT_ID);
    console.log(`🔍 Admin Check - User: ${userID} | Admin Config: ${adminID} | Match: ${userID === adminID}`);
    return ADMIN_CHAT_ID && userID === adminID;
};

const renderStart = async (ctx) => {
    const s = await getSession(ctx.chat.id);
    const cfg = await getSystemConfig();
    const isVip = s.isVip && new Date(s.subscriptionExpiry) > new Date();

    let text = `🚀 *ZapMass* [V1.210]\n\n`;
    text += `Status: ${isVip ? "💎 VIP" : "👤 Gratuito"}\n`;
    if (isVip) text += `Validade: ${new Date(s.subscriptionExpiry).toLocaleDateString()}\n`;
    text += `Limite: ${s.maxInstances || cfg.defaultMaxInstances} dispositivo(s)`;

    const kb = Markup.inlineKeyboard([
        [Markup.button.callback("📱 Conectar", "connect_instance")],
        [Markup.button.callback("📨 Novo Disparo", "new_campaign")],
        [Markup.button.callback("💎 Assinatura", "my_sub")],
        ...(isAdmin(ctx) ? [[Markup.button.callback("👑 ADMIN", "admin_panel")]] : [])
    ]);

    if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }).catch(() => ctx.reply(text, { parse_mode: "Markdown", ...kb }));
    else await ctx.reply(text, { parse_mode: "Markdown", ...kb });
}

bot.start(renderStart);
bot.command("id", (ctx) => ctx.reply(`🆔 ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" }));
bot.command("admin", (ctx) => isAdmin(ctx) ? bot.handleUpdate({ callback_query: { data: "admin_panel" } }) : ctx.reply("Negado."));

bot.action("start_menu", renderStart);
bot.action("admin_panel", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const cfg = await getSystemConfig();
    ctx.editMessageText(`👑 *Admin* [V1.210]\n\nDiária: R$ ${cfg.dailyPrice.toFixed(2)}`, Markup.inlineKeyboard([
        [Markup.button.callback("💰 Preço", "admin_set_price"), Markup.button.callback("👤 VIP", "admin_give_vip")],
        [Markup.button.callback("🔙 Voltar", "start_menu")]
    ]));
});

bot.action("my_sub", async (ctx) => {
    const cfg = await getSystemConfig();
    ctx.editMessageText(`💎 *Upgrade*\nDiária: R$ ${cfg.dailyPrice.toFixed(2)}`, Markup.inlineKeyboard([
        [Markup.button.callback("7 Dias", "pay_7d"), Markup.button.callback("30 Dias", "pay_30d")],
        [Markup.button.callback("🔙 Voltar", "start_menu")]
    ]));
});

bot.action(/^pay_(\d+)d$/, async (ctx) => {
    const days = ctx.match[1], cfg = await getSystemConfig();
    ctx.reply(`⏳ Gerando PIX...`);
    const authRes = await fetch(`${SYNC_BASE_URL}/api/partner/v1/auth-token`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: SYNCPAY_CLIENT_ID, client_secret: SYNCPAY_CLIENT_SECRET })
    });
    const auth = await authRes.json();
    const pixRes = await fetch(`${SYNC_BASE_URL}/api/partner/v1/cash-in`, {
        method: "POST", headers: { "Authorization": `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            amount: cfg.dailyPrice * days, description: `ZapMass ${days}d`, external_id: `ZAPMASS_${ctx.chat.id}`,
            client: { name: "Cliente", email: "c@z.com", cpf: "0", phone: "0" }
        })
    });
    const pix = await pixRes.json();
    if (pix.pix_code) {
        const qr = await QRCode.toBuffer(pix.pix_code);
        await ctx.replyWithPhoto({ source: qr }, { caption: `Copia e Cola:\n\`${pix.pix_code}\``, parse_mode: "Markdown" });
    } else ctx.reply("Erro PIX.");
});

bot.action("connect_instance", async (ctx) => {
    ctx.reply("⏳ QR Code...");
    const res = await fetch(`${WUZAPI_BASE_URL}/instance/init?token=mass_${ctx.chat.id}`, { headers: { pk: WUZAPI_ADMIN_TOKEN } });
    const data = await res.json();
    if (data.qrcode) {
        const qr = await QRCode.toBuffer(data.qrcode);
        await ctx.replyWithPhoto({ source: qr }, { caption: "Escaneie.", ...Markup.inlineKeyboard([[Markup.button.callback("🔙", "start_menu")]]) });
    } else ctx.reply("Erro ou Já Conectado.");
});

bot.on("text", async (ctx) => {
    const s = await getSession(ctx.chat.id);
    if (isAdmin(ctx)) {
        if (s.stage === "ADMIN_WAIT_PRICE") {
            const p = parseFloat(ctx.message.text);
            const cfg = await getSystemConfig(); cfg.dailyPrice = p;
            await supabase.from('bot_sessions').upsert({ chat_id: 'ZAPMASS_CONFIG', data: cfg });
            s.stage = "START"; await saveSession(ctx.chat.id, s);
            ctx.reply("Preço alterado!"); return renderStart(ctx);
        }
        if (s.stage === "ADMIN_WAIT_USER_ID") {
            const tid = ctx.message.text.trim(), ts = await getSession(tid);
            ts.isVip = true; const now = new Date(); now.setDate(now.getDate() + 30);
            ts.subscriptionExpiry = now.toISOString();
            await saveSession(tid, ts);
            s.stage = "START"; await saveSession(ctx.chat.id, s);
            ctx.reply("VIP 30d Ativado!"); return renderStart(ctx);
        }
    }
});

bot.action("admin_set_price", async (ctx) => {
    const s = await getSession(ctx.chat.id); s.stage = "ADMIN_WAIT_PRICE";
    await saveSession(ctx.chat.id, s); ctx.reply("Novo valor:");
});

bot.action("admin_give_vip", async (ctx) => {
    const s = await getSession(ctx.chat.id); s.stage = "ADMIN_WAIT_USER_ID";
    await saveSession(ctx.chat.id, s); ctx.reply("ID Usuário:");
});

bot.launch().then(() => {
    console.log(`🚀 [ZAPMASS] V1.210 - ONLINE`);
    bot.telegram.deleteWebhook().catch(() => { });
});
app.listen(PORT, () => console.log(`🌍 ZapMass [V1.210] PORT ${PORT}`));
