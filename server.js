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
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

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

// --- Configuração Global do Sistema ---
async function getSystemConfig() {
    const { data } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('chat_id', 'ZAPMASS_CONFIG')
        .single();

    if (data) return data.data;

    const defaultConfig = {
        dailyPrice: 5.00,
        defaultMaxInstances: 1
    };
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

// --- Persistência Isolação (PREFIXO ZAPMASS_) ---
async function getSession(chatId) {
    const id = `ZAPMASS_${chatId}`;
    const { data } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('chat_id', id)
        .single();

    if (data) return data.data;

    const newSession = {
        stage: "START",
        isVip: false,
        subscriptionExpiry: null,
        maxInstances: null, // null usa o default do sistema
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

// --- Webhook para SyncPay (PROPORCIONAL) ---
app.post("/webhook", async (req, res) => {
    const { external_id, status, amount } = req.body;
    if (status === "paid" || status === "approved") {
        if (external_id.startsWith("ZAPMASS_")) {
            const chatId = external_id.replace("ZAPMASS_", "");
            const session = await getSession(chatId);
            const config = await getSystemConfig();

            const daysToAdd = Math.floor(amount / config.dailyPrice);
            if (daysToAdd > 0) {
                session.isVip = true;
                let currentExpiry = session.subscriptionExpiry ? new Date(session.subscriptionExpiry) : new Date();
                if (currentExpiry < new Date()) currentExpiry = new Date();

                currentExpiry.setDate(currentExpiry.getDate() + daysToAdd);
                session.subscriptionExpiry = currentExpiry.toISOString();
                await saveSession(chatId, session);

                try {
                    await bot.telegram.sendMessage(chatId, `💎 *PAGAMENTO CONFIRMADO!*\n\nSua assinatura foi renovada por +${daysToAdd} dias.\nValidade atual: ${currentExpiry.toLocaleDateString()}`);
                } catch (e) { }
            }
        }
    }
    res.sendStatus(200);
});

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
            external_id: `ZAPMASS_${chatId}`,
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

// --- Bot Logic & UI ---
const isAdmin = (ctx) => String(ctx.chat.id) === String(ADMIN_CHAT_ID);

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

    if (isAdmin(ctx)) {
        buttons.push([Markup.button.callback("👑 Painel Admin", "admin_panel")]);
    }

    const keyboard = Markup.inlineKeyboard(buttons);

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
        } else {
            await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
        }
    } catch (e) {
        await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
    }
}

const checkVip = async (ctx) => {
    const session = await getSession(ctx.chat.id);
    if (session.isVip && new Date(session.subscriptionExpiry) > new Date()) return true;

    const config = await getSystemConfig();
    await ctx.reply(`💎 *Acesso Restrito*\n\nEste bot funciona no modelo pré-pago.\nDiária: *R$ ${config.dailyPrice.toFixed(2)}*\n\nPara usar, adicione créditos:`, Markup.inlineKeyboard([
        [Markup.button.callback(`💳 7 Dias (R$ ${(config.dailyPrice * 7).toFixed(2)})`, "pay_7d")],
        [Markup.button.callback(`💳 30 Dias (R$ ${(config.dailyPrice * 30).toFixed(2)})`, "pay_30d")],
        [Markup.button.callback("🔙 Voltar", "start_menu")]
    ]));
    return false;
};

bot.start(renderStart);
bot.action("start_menu", renderStart);

// --- Admin Area ---
bot.action("admin_panel", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Acesso negado.");
    const config = await getSystemConfig();
    const text = `👑 *Painel Administrativo*\n\nPreço Diária: R$ ${config.dailyPrice.toFixed(2)}\nInstâncias Padrão: ${config.defaultMaxInstances}`;

    ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("💰 Alterar Preço Diária", "admin_set_price")],
            [Markup.button.callback("👤 Liberar Acesso VIP", "admin_give_vip")],
            [Markup.button.callback("⚙️ Limite de Instâncias", "admin_set_limit")],
            [Markup.button.callback("🔙 Voltar", "start_menu")]
        ])
    });
});

bot.action("admin_set_price", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_PRICE";
    await syncSession(ctx, session);
    ctx.reply("Digite o novo valor da diária (ex: 4.50):");
});

bot.action("admin_give_vip", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_USER_ID";
    await syncSession(ctx, session);
    ctx.reply("Envie o ID do usuário (Chat ID) que deseja liberar:");
});

bot.action("admin_set_limit", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const session = await getSession(ctx.chat.id);
    session.stage = "ADMIN_WAIT_LIMIT_USER";
    await syncSession(ctx, session);
    ctx.reply("Envie o ID do usuário e o novo limite (ex: 12345678 5):");
});

// --- User Actions ---
bot.action("connect_instance", async (ctx) => {
    const session = await getSession(ctx.chat.id);
    const config = await getSystemConfig();
    const limit = session.maxInstances || config.defaultMaxInstances;

    ctx.answerCbQuery().catch(() => { });
    ctx.reply("⏳ Gerando QR Code...");

    const res = await callWuzapi(`/instance/init?token=mass_${ctx.chat.id}`, "GET");
    if (res.qrcode) {
        const qrBuffer = await QRCode.toBuffer(res.qrcode);
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `Escaneie para conectar.\n\nSeu limite: ${limit} instância(s).`,
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start_menu")]])
        });
    } else {
        ctx.reply("✅ WhatsApp já está conectado ou erro na API.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start_menu")]]));
    }
});

bot.action(/^pay_(\d+)d$/, async (ctx) => {
    const days = parseInt(ctx.match[1]);
    const config = await getSystemConfig();
    const amount = config.dailyPrice * days;

    ctx.answerCbQuery().catch(() => { });
    ctx.reply(`⏳ Gerando PIX para ${days} dias...`);

    const pix = await createSyncPayPix(ctx.chat.id, amount);
    if (pix.pix_code) {
        const qrBuffer = await QRCode.toBuffer(pix.pix_code);
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption: `💰 *Pagamento de ${days} Dias*\n\nValor: R$ ${amount.toFixed(2)}\n\nCopia e Cola:\n\`${pix.pix_code}\``,
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "start_menu")]])
        });
    } else {
        ctx.reply("❌ Erro ao gerar pagamento.");
    }
});

bot.action("my_sub", async (ctx) => {
    ctx.answerCbQuery().catch(() => { });
    await checkVip(ctx);
});

bot.on("text", async (ctx) => {
    const session = await getSession(ctx.chat.id);
    if (!session.stage || session.stage === "START") return;

    if (isAdmin(ctx)) {
        if (session.stage === "ADMIN_WAIT_PRICE") {
            const price = parseFloat(ctx.message.text.replace(",", "."));
            if (isNaN(price)) return ctx.reply("❌ Valor inválido.");
            const config = await getSystemConfig();
            config.dailyPrice = price;
            await saveSystemConfig(config);
            session.stage = "START";
            await syncSession(ctx, session);
            ctx.reply(`✅ Novo preço diária: R$ ${price.toFixed(2)}`);
            return renderStart(ctx);
        }

        if (session.stage === "ADMIN_WAIT_USER_ID") {
            const targetId = ctx.message.text.trim();
            const targetSession = await getSession(targetId);
            targetSession.isVip = true;
            const now = new Date();
            now.setDate(now.getDate() + 30);
            targetSession.subscriptionExpiry = now.toISOString();
            await saveSession(targetId, targetSession);
            session.stage = "START";
            await syncSession(ctx, session);
            ctx.reply(`✅ VIP liberado por 30 dias para o ID ${targetId}`);
            try { await bot.telegram.sendMessage(targetId, "👑 Seu acesso VIP foi liberado manualmente pelo administrador!"); } catch (e) { }
            return renderStart(ctx);
        }

        if (session.stage === "ADMIN_WAIT_LIMIT_USER") {
            const parts = ctx.message.text.split(" ");
            const targetId = parts[0];
            const limit = parseInt(parts[1]);
            if (!targetId || isNaN(limit)) return ctx.reply("❌ Formato inválido. Use: ID LIMITE");
            const targetSession = await getSession(targetId);
            targetSession.maxInstances = limit;
            await saveSession(targetId, targetSession);
            session.stage = "START";
            await syncSession(ctx, session);
            ctx.reply(`✅ Limite de ${limit} instâncias definido para ${targetId}`);
            return renderStart(ctx);
        }
    }
});

bot.launch();
app.listen(PORT, () => console.log(`🌍 ZapMass rodando na porta ${PORT}`));
