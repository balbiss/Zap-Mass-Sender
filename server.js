import express from "express";
import { Telegraf, Markup } from "telegraf";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

dotenv.config();

const app = express();
app.use(express.json());

// --- Variáveis de Ambiente ---
const PORT = process.env.PORT || 8899;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL;
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// SyncPay (Usando env vars ou fallback para placeholders se o usuário preferir)
const SYNCPAY_CLIENT_ID = process.env.SYNCPAY_CLIENT_ID || "c2687695-57c9-4f3e-8d59-36fbdabb0a44";
const SYNCPAY_CLIENT_SECRET = process.env.SYNCPAY_CLIENT_SECRET || "42f39fd6-00bc-4f11-96d7-e98e4db9b93a";
const SYNC_BASE_URL = "https://api.syncpayments.com.br";

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ ERROR: Variáveis críticas faltando (TELEGRAM_TOKEN, SUPABASE_URL ou SUPABASE_KEY)");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(TELEGRAM_TOKEN);

// --- Configuração Global ---
async function getSystemConfig() {
    try {
        const { data } = await supabase
            .from('bot_sessions')
            .select('data')
            .eq('chat_id', 'ZAPMASS_CONFIG')
            .single();
        if (data) return data.data;
    } catch (e) { }

    const defaultConfig = { dailyPrice: 5.00, defaultMaxInstances: 1 };
    await saveSystemConfig(defaultConfig);
    return defaultConfig;
}

async function saveSystemConfig(config) {
    await supabase.from('bot_sessions').upsert({
        chat_id: 'ZAPMASS_CONFIG',
        data: config,
        updated_at: new Date().toISOString()
    });
}

// --- Persistência Isolação ---
async function getSession(chatId) {
    const id = `ZAPMASS_${chatId}`;
    try {
        const { data } = await supabase.from('bot_sessions').select('data').eq('chat_id', id).single();
        if (data) return data.data;
    } catch (e) { }

    const newSession = {
        stage: "START",
        isVip: false,
        subscriptionExpiry: null,
        maxInstances: null,
        whatsapp: { instances: [] }
    };
    await saveSession(chatId, newSession);
    return newSession;
}

async function saveSession(chatId, sessionData) {
    const id = `ZAPMASS_${chatId}`;
    await supabase.from('bot_sessions').upsert({
        chat_id: id,
        data: sessionData,
        updated_at: new Date().toISOString()
    });
}

async function syncSession(ctx, session) {
    await saveSession(ctx.chat.id, session);
}

// --- API Helpers (Logando erros para Debug) ---
async function callWuzapi(endpoint, method = "GET", body = null, token = null) {
    try {
        const headers = { "Content-Type": "application/json" };
        if (token) headers["token"] = token;
        else headers["pk"] = WUZAPI_ADMIN_TOKEN;

        const options = { method, headers };
        if (body) options.body = JSON.stringify(body);

        const res = await fetch(`${WUZAPI_BASE_URL}${endpoint}`, options);
        if (!res.ok) {
            const errBody = await res.text();
            console.error(`❌ WUZAPI Error [${res.status}]:`, errBody);
        }
        return await res.json();
    } catch (e) {
        console.error("❌ WUZAPI Exception:", e.message);
        return { error: e.message };
    }
}

async function createSyncPayPix(chatId, amount) {
    try {
        // Auth
        const authRes = await fetch(`${SYNC_BASE_URL}/api/partner/v1/auth-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: SYNCPAY_CLIENT_ID, client_secret: SYNCPAY_CLIENT_SECRET })
        });
        const auth = await authRes.json();
        if (!auth.access_token) throw new Error("Falha na autenticação SyncPay");

        // Pix
        const res = await fetch(`${SYNC_BASE_URL}/api/partner/v1/cash-in`, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${auth.access_token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                amount: parseFloat(amount),
                description: `Assinatura ZapMass - ID ${chatId}`,
                external_id: `ZAPMASS_${chatId}`,
                client: { name: "Cliente ZapMass", email: "cliente@zapmass.com", cpf: "00000000000", phone: "00000000000" }
            })
        });
        return await res.json();
    } catch (e) {
        console.error("❌ SyncPay Exception:", e.message);
        return { error: e.message };
    }
}

// --- Bot Logic ---
const isAdmin = (ctx) => {
    if (!ADMIN_CHAT_ID) return false;
    return String(ctx.chat.id) === String(ADMIN_CHAT_ID);
};

const renderStart = async (ctx) => {
    const session = await getSession(ctx.chat.id);
    const config = await getSystemConfig();

    let text = `🚀 *ZapMass Sender*\n\nO robô de disparos mais rápido do mercado.\n\n`;
    const isVip = session.isVip && new Date(session.subscriptionExpiry) > new Date();

    text += `Status: ${isVip ? "💎 VIP" : "👤 Gratuito"}\n`;
    if (isVip) text += `Validade: ${new Date(session.subscriptionExpiry).toLocaleDateString()}\n`;
    text += `Limite: ${session.maxInstances || config.defaultMaxInstances} instância(s)`;

    const buttons = [
        [Markup.button.callback("📱 Conectar WhatsApp", "connect_instance")],
        [Markup.button.callback("📨 Novo Disparo", "new_campaign")],
        [Markup.button.callback("💎 Minha Assinatura / Upgrade", "my_sub")]
    ];

    if (isAdmin(ctx)) buttons.push([Markup.button.callback("👑 Painel Admin", "admin_panel")]);

    const keyboard = Markup.inlineKeyboard(buttons);

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard }).catch(() => ctx.reply(text, { parse_mode: "Markdown", ...keyboard }));
        } else {
            await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
        }
    } catch (e) { }
}

const checkVip = async (ctx) => {
    const session = await getSession(ctx.chat.id);
    if (session.isVip && new Date(session.subscriptionExpiry) > new Date()) return true;

    const config = await getSystemConfig();
    const txt = `💎 *Acesso Restrito*\n\nModelo Pré-pago.\nDiária: *R$ ${config.dailyPrice.toFixed(2)}*\n\nEscolha seu pacote:`;
    const kb = Markup.inlineKeyboard([
        [Markup.button.callback(`💳 7 Dias (R$ ${(config.dailyPrice * 7).toFixed(2)})`, "pay_7d")],
        [Markup.button.callback(`💳 30 Dias (R$ ${(config.dailyPrice * 30).toFixed(2)})`, "pay_30d")],
        [Markup.button.callback("🔙 Voltar", "start_menu")]
    ]);

    if (ctx.callbackQuery) await ctx.editMessageText(txt, { parse_mode: "Markdown", ...kb }).catch(() => ctx.reply(txt, { parse_mode: "Markdown", ...kb }));
    else await ctx.reply(txt, { parse_mode: "Markdown", ...kb });

    return false;
};

// Handlers
bot.start(renderStart);
bot.command("id", (ctx) => ctx.reply(`🆔 Seu Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" }));
bot.command("admin", (ctx) => isAdmin(ctx) ? bot.handleUpdate({ callback_query: { data: "admin_panel", message: ctx.message, from: ctx.from } }) : ctx.reply("Acesso negado."));

// Actions
bot.action("start_menu", renderStart);

bot.action("admin_panel", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Acesso negado.");
    const config = await getSystemConfig();
    const text = `👑 *Painel Administrativo*\n\nDiária: R$ ${config.dailyPrice.toFixed(2)}\nInstâncias Padrão: ${config.defaultMaxInstances}`;
    ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("💰 Diária", "admin_set_price"), Markup.button.callback("⚙️ Limite", "admin_set_limit")],
            [Markup.button.callback("👤 Dar VIP", "admin_give_vip")],
            [Markup.button.callback("🔙 Voltar", "start_menu")]
        ])
    }).catch(() => { });
});

bot.action("admin_set_price", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const s = await getSession(ctx.chat.id);
    s.stage = "ADMIN_WAIT_PRICE";
    await syncSession(ctx, s);
    ctx.reply("Novo valor diária:");
});

bot.action("admin_give_vip", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const s = await getSession(ctx.chat.id);
    s.stage = "ADMIN_WAIT_USER_ID";
    await syncSession(ctx, s);
    ctx.reply("Chat ID:");
});

bot.action("admin_set_limit", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const s = await getSession(ctx.chat.id);
    s.stage = "ADMIN_WAIT_LIMIT_USER";
    await syncSession(ctx, s);
    ctx.reply("ID e Limite (ID 5):");
});

bot.action("connect_instance", async (ctx) => {
    ctx.answerCbQuery().catch(() => { });
    const s = await getSession(ctx.chat.id);
    const config = await getSystemConfig();
    const limit = s.maxInstances || config.defaultMaxInstances;

    ctx.reply("⏳ Gerando QR Code...");
    const res = await callWuzapi(`/instance/init?token=mass_${ctx.chat.id}`, "GET");
    if (res.qrcode) {
        const qrBuffer = await QRCode.toBuffer(res.qrcode);
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `Escaneie.\nLimite: ${limit} instância(s).`,
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start_menu")]])
        });
    } else {
        ctx.reply("✅ Conectado ou Erro API.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start_menu")]]));
    }
});

bot.action(/^pay_(\d+)d$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => { });
    const days = parseInt(ctx.match[1]);
    const config = await getSystemConfig();
    const amount = config.dailyPrice * days;

    ctx.reply(`⏳ Gerando PIX R$ ${amount.toFixed(2)}...`);
    const pix = await createSyncPayPix(ctx.chat.id, amount);
    if (pix.pix_code) {
        const qrBuffer = await QRCode.toBuffer(pix.pix_code);
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `💰 Copia e Cola:\n\`${pix.pix_code}\``,
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start_menu")]])
        });
    } else {
        ctx.reply("❌ Erro ao gerar PIX.");
    }
});

bot.action("my_sub", async (ctx) => {
    ctx.answerCbQuery().catch(() => { });
    await checkVip(ctx);
});

bot.action("new_campaign", async (ctx) => {
    ctx.answerCbQuery().catch(() => { });
    if (!await checkVip(ctx)) return;
    ctx.editMessageText("🎯 *Novo Disparo*\n\nEngine sendo preparada...", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start_menu")]])
    }).catch(() => { });
});

// Text Handling
bot.on("text", async (ctx) => {
    const s = await getSession(ctx.chat.id);
    if (!s.stage || s.stage === "START") return;

    if (isAdmin(ctx)) {
        if (s.stage === "ADMIN_WAIT_PRICE") {
            const val = parseFloat(ctx.message.text.replace(",", "."));
            if (isNaN(val)) return ctx.reply("❌ Inválido.");
            const cfg = await getSystemConfig();
            cfg.dailyPrice = val;
            await saveSystemConfig(cfg);
            s.stage = "START";
            await syncSession(ctx, s);
            ctx.reply(`✅ Diária: R$ ${val.toFixed(2)}`);
            return renderStart(ctx);
        }

        if (s.stage === "ADMIN_WAIT_USER_ID") {
            const tid = ctx.message.text.trim();
            const ts = await getSession(tid);
            ts.isVip = true;
            const now = new Date();
            now.setDate(now.getDate() + 30);
            ts.subscriptionExpiry = now.toISOString();
            await saveSession(tid, ts);
            s.stage = "START";
            await syncSession(ctx, s);
            ctx.reply(`✅ VIP 30d para ${tid}`);
            return renderStart(ctx);
        }

        if (s.stage === "ADMIN_WAIT_LIMIT_USER") {
            const p = ctx.message.text.split(" ");
            const tid = p[0], lim = parseInt(p[1]);
            if (!tid || isNaN(lim)) return ctx.reply("❌ Inválido. Use ID LIMITE");
            const ts = await getSession(tid);
            ts.maxInstances = lim;
            await saveSession(tid, ts);
            s.stage = "START";
            await syncSession(ctx, s);
            ctx.reply(`✅ Limite ${lim} para ${tid}`);
            return renderStart(ctx);
        }
    }
});

// Webhook
app.post("/webhook", async (req, res) => {
    const { external_id, status, amount } = req.body;
    if (status === "paid" || status === "approved") {
        if (external_id.startsWith("ZAPMASS_")) {
            const cid = external_id.replace("ZAPMASS_", "");
            const s = await getSession(cid);
            const cfg = await getSystemConfig();
            const days = Math.floor(amount / cfg.dailyPrice);
            if (days > 0) {
                s.isVip = true;
                let exp = s.subscriptionExpiry ? new Date(s.subscriptionExpiry) : new Date();
                if (exp < new Date()) exp = new Date();
                exp.setDate(exp.getDate() + days);
                s.subscriptionExpiry = exp.toISOString();
                await saveSession(cid, s);
                try { await bot.telegram.sendMessage(cid, `💎 Confirmado! +${days} dias.`); } catch (e) { }
            }
        }
    }
    res.sendStatus(200);
});

bot.launch()
    .then(() => {
        console.log("🚀 [ZAPMASS] Bot iniciado com sucesso [V1.202]");
        bot.telegram.deleteWebhook().catch(() => { });
    });

app.listen(PORT, () => console.log(`🌍 ZapMass [V1.202] rodando na porta ${PORT}`));
