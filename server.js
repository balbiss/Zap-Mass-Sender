import express from "express";
import { Telegraf, Markup } from "telegraf";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8899;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL;
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// -- SyncPay Config --
const SYNCPAY_CLIENT_ID = "c2687695-57c9-4f3e-8d59-36fbdabb0a44";
const SYNCPAY_CLIENT_SECRET = "42f39fd6-00bc-4f11-96d7-e98e4db9b93a";
const SYNC_BASE_URL = "https://api.syncpayments.com.br";

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Variáveis de ambiente faltando!");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(TELEGRAM_TOKEN);

// --- Persistência (Supabase) ---
async function getSession(chatId) {
    const id = String(chatId);
    const { data, error } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('chat_id', id)
        .single();

    if (data) return data.data;

    const newSession = {
        stage: "START",
        isVip: false,
        subscriptionExpiry: null,
        whatsapp: { instances: [] }
    };
    await saveSession(id, newSession);
    return newSession;
}

async function saveSession(chatId, sessionData) {
    await supabase.from('bot_sessions').upsert({
        chat_id: String(chatId),
        data: sessionData,
        updated_at: new Date().toISOString()
    });
}

async function syncSession(ctx, session) {
    await saveSession(ctx.chat.id, session);
}

// --- SyncPay Integration ---
async function getSyncPayToken() {
    const res = await fetch(`${SYNC_BASE_URL}/api/partner/v1/auth-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: SYNCPAY_CLIENT_ID, client_secret: SYNCPAY_CLIENT_SECRET })
    });
    const json = await res.json();
    return json.access_token;
}

async function createSyncPayPix(chatId, amount) {
    const token = await getSyncPayToken();
    const res = await fetch(`${SYNC_BASE_URL}/api/partner/v1/cash-in`, {
        method: "POST",
        headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            amount: amount,
            description: `Assinatura ZapMass - ID ${chatId}`,
            external_id: String(chatId),
            client: { name: "Cliente ZapMass", email: "cliente@zapmass.com", cpf: "00000000000", phone: "00000000000" }
        })
    });
    return await res.json();
}

// --- WUZAPI Helper ---
async function callWuzapi(endpoint, method = "GET", body = null, token = null) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["token"] = token;
    else headers["pk"] = WUZAPI_ADMIN_TOKEN;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${WUZAPI_BASE_URL}${endpoint}`, options);
    return await res.json();
}

// --- Bot Logic ---
const checkVip = async (ctx) => {
    const session = await getSession(ctx.chat.id);
    if (session.isVip && new Date(session.subscriptionExpiry) > new Date()) return true;

    await ctx.reply("💎 *Acesso Restrito*\n\nPara usar esta função, você precisa de uma assinatura ativa.", Markup.inlineKeyboard([
        [Markup.button.callback("💳 Assinar Agora (R$ 49,90)", "pay_vip")]
    ]));
    return false;
};

bot.start(async (ctx) => {
    const session = await getSession(ctx.chat.id);
    ctx.reply(`🚀 *ZapMass Sender*\n\nO robô de disparos mais rápido do mercado.\n\nStatus: ${session.isVip ? "💎 VIP" : "👤 Gratuito"}`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("📱 Conectar WhatsApp", "connect_instance")],
            [Markup.button.callback("📨 Novo Disparo", "new_campaign")],
            [Markup.button.callback("💎 Minha Assinatura", "my_sub")]
        ])
    });
});

bot.action("connect_instance", async (ctx) => {
    const instId = `mass_${ctx.chat.id}`;
    ctx.reply("⏳ Gerando QR Code...");

    const res = await callWuzapi(`/instance/init?token=${instId}`, "GET");
    if (res.qrcode) {
        const qrBuffer = await QRCode.toBuffer(res.qrcode);
        await ctx.replyWithPhoto({ source: qrBuffer }, { caption: "Escaneie para conectar." });
    } else {
        ctx.reply("✅ WhatsApp já está conectado ou erro na API.");
    }
});

bot.action("pay_vip", async (ctx) => {
    ctx.reply("⏳ Gerando PIX...");
    const pix = await createSyncPayPix(ctx.chat.id, 49.90);
    if (pix.pix_code) {
        const qrBuffer = await QRCode.toBuffer(pix.pix_code);
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `💰 *Pagamento da Assinatura*\n\nValor: R$ 49,90\n\nCopia e Cola:\n\`${pix.pix_code}\``,
            parse_mode: "Markdown"
        });
    } else {
        ctx.reply("❌ Erro ao gerar pagamento. Tente novamente.");
    }
});

bot.action("new_campaign", async (ctx) => {
    if (!await checkVip(ctx)) return;
    ctx.reply("🎯 *Novo Disparo*\n\n(Em construção...)");
});

bot.action("my_sub", async (ctx) => {
    const session = await getSession(ctx.chat.id);
    const status = session.isVip ? `✅ Ativa até ${new Date(session.subscriptionExpiry).toLocaleDateString()}` : "❌ Inativa";
    ctx.reply(`💎 *Sua Assinatura*\n\nStatus: ${status}`, Markup.inlineKeyboard([
        [Markup.button.callback("💳 Renovação/Upgrade", "pay_vip")],
        [Markup.button.callback("🔙 Voltar", "start_menu")]
    ]));
});

bot.action("start_menu", (ctx) => {
    // Trigger start logic
});

// --- Webhook para SyncPay ---
app.post("/webhook", async (req, res) => {
    const { external_id, status } = req.body;
    if (status === "paid" || status === "approved") {
        const session = await getSession(external_id);
        session.isVip = true;
        const now = new Date();
        now.setDate(now.getDate() + 30);
        session.subscriptionExpiry = now.toISOString();
        await saveSession(external_id, session);

        try {
            await bot.telegram.sendMessage(external_id, "💎 *SUCESSO!* Sua assinatura ZapMass foi ativada por 30 dias. Aproveite!");
        } catch (e) { }
    }
    res.sendStatus(200);
});

bot.launch();
app.listen(PORT, () => console.log(`🌍 ZapMass rodando na porta ${PORT}`));
