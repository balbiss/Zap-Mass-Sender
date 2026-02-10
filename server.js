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

const SYNCPAY_CLIENT_ID = "35ddcafe-42a8-44e4-8714-93741e398e2a";
const SYNCPAY_CLIENT_SECRET = "00f73c7a-922f-4f17-8e7c-e85afa6d1b0f";
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

    let text = `🚀 *ZapMass* [V1.220]\n\n`;
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
    ctx.editMessageText(`👑 *Admin* [V1.220]\n\nDiária: R$ ${cfg.dailyPrice.toFixed(2)}`, Markup.inlineKeyboard([
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
    try {
        const days = parseInt(ctx.match[1]);
        const cfg = await getSystemConfig();
        const amount = cfg.dailyPrice * days;

        ctx.reply(`⏳ Gerando PIX de R$ ${amount.toFixed(2)}...`);
        console.log(`\n💰 [PIX] Iniciando pagamento: ${days} dias x R$ ${cfg.dailyPrice} = R$ ${amount}`);

        // Auth
        console.log(`🔑 [PIX] Autenticando com SyncPay...`);
        const authRes = await fetch(`${SYNC_BASE_URL}/api/partner/v1/auth-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: SYNCPAY_CLIENT_ID,
                client_secret: SYNCPAY_CLIENT_SECRET
            })
        });

        const authText = await authRes.text();
        console.log(`🔑 [PIX] Auth Response [${authRes.status}]:`, authText);

        let auth;
        try {
            auth = JSON.parse(authText);
        } catch (e) {
            console.error(`❌ [PIX] Erro ao parsear resposta de auth:`, e);
            return ctx.reply("❌ Erro na autenticação do pagamento.");
        }

        if (!auth.access_token) {
            console.error(`❌ [PIX] Token não encontrado:`, auth);
            return ctx.reply("❌ Erro na autenticação do pagamento.");
        }

        console.log(`✅ [PIX] Autenticado com sucesso!`);

        // Create PIX
        console.log(`💳 [PIX] Criando cobrança...`);
        const pixPayload = {
            amount: amount,
            description: `ZapMass ${days} dias`,
            external_id: `ZAPMASS_${ctx.chat.id}`,
            client: {
                name: "Cliente ZapMass",
                email: "cliente@zapmass.com",
                cpf: "00000000000",
                phone: "00000000000"
            }
        };
        console.log(`💳 [PIX] Payload:`, JSON.stringify(pixPayload, null, 2));

        const pixRes = await fetch(`${SYNC_BASE_URL}/api/partner/v1/cash-in`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${auth.access_token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(pixPayload)
        });

        const pixText = await pixRes.text();
        console.log(`💳 [PIX] Response [${pixRes.status}]:`, pixText);

        let pix;
        try {
            pix = JSON.parse(pixText);
        } catch (e) {
            console.error(`❌ [PIX] Erro ao parsear resposta:`, e);
            return ctx.reply("❌ Erro ao gerar PIX.");
        }

        if (pix.pix_code) {
            console.log(`✅ [PIX] QR Code gerado com sucesso!`);
            const qr = await QRCode.toBuffer(pix.pix_code);
            await ctx.replyWithPhoto({ source: qr }, {
                caption: `💰 *PIX - ${days} Dias*\n\nValor: R$ ${amount.toFixed(2)}\n\nCopia e Cola:\n\`${pix.pix_code}\``,
                parse_mode: "Markdown"
            });
        } else {
            console.error(`❌ [PIX] QR Code não encontrado:`, pix);
            ctx.reply(`❌ Erro ao gerar PIX: ${pix.message || pix.error || "Desconhecido"}`);
        }
    } catch (e) {
        console.error(`❌ [PIX] Exception:`, e);
        ctx.reply("❌ Erro ao processar pagamento.");
    }
});

bot.action("connect_instance", async (ctx) => {
    const s = await getSession(ctx.chat.id);
    const cfg = await getSystemConfig();
    const maxInstances = s.maxInstances || cfg.defaultMaxInstances;

    let text = `📱 *Gerenciar Dispositivos*\n\n`;

    if (!s.whatsapp || !s.whatsapp.instances) {
        s.whatsapp = { instances: [] };
    }

    if (s.whatsapp.instances.length === 0) {
        text += `Você ainda não tem dispositivos conectados.\n\n`;
        text += `Limite: ${s.whatsapp.instances.length}/${maxInstances}`;
    } else {
        text += `Dispositivos conectados: ${s.whatsapp.instances.length}/${maxInstances}\n\n`;
        s.whatsapp.instances.forEach((inst, i) => {
            text += `${i + 1}. 📱 ${inst.name || `Dispositivo ${i + 1}`}\n`;
            text += `   Status: ${inst.connected ? "🟢 Conectado" : "🔴 Desconectado"}\n\n`;
        });
    }

    const buttons = [];

    if (s.whatsapp.instances.length < maxInstances) {
        buttons.push([Markup.button.callback("➕ Adicionar Dispositivo", "add_instance")]);
    }

    if (s.whatsapp.instances.length > 0) {
        buttons.push([Markup.button.callback("🔄 Atualizar Status", "refresh_instances")]);
    }

    buttons.push([Markup.button.callback("🔙 Voltar", "start_menu")]);

    ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action("add_instance", async (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("⏳ Gerando QR Code...");

    try {
        const userToken = `mass_${ctx.chat.id}`;

        // Step 1: Connect
        const connectRes = await fetch(`${WUZAPI_BASE_URL}/session/connect`, {
            method: "POST",
            headers: { "token": userToken, "Content-Type": "application/json" },
            body: JSON.stringify({ Immediate: false, Subscribe: ["Message"] })
        });
        await connectRes.text();

        // Step 2: Get QR
        const qrRes = await fetch(`${WUZAPI_BASE_URL}/session/qr`, {
            headers: { "token": userToken }
        });
        const data = await qrRes.json();

        if (data.data && data.data.QRCode) {
            const qrBuffer = Buffer.from(data.data.QRCode.split(',')[1], 'base64');
            await ctx.replyWithPhoto({ source: qrBuffer }, {
                caption: "📱 *Escaneie o QR Code*\n\nAbra o WhatsApp no seu celular e escaneie este código.",
                parse_mode: "Markdown",
                ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "connect_instance")]])
            });

            // Adiciona a instância na sessão
            const s = await getSession(ctx.chat.id);
            if (!s.whatsapp.instances) s.whatsapp.instances = [];
            s.whatsapp.instances.push({
                token: `mass_${ctx.chat.id}`,
                name: `Dispositivo ${s.whatsapp.instances.length + 1}`,
                connected: false,
                addedAt: new Date().toISOString()
            });
            await saveSession(ctx.chat.id, s);
        } else {
            ctx.reply("❌ Erro ao gerar QR Code. Tente novamente.");
        }
    } catch (e) {
        console.error("❌ Erro ao conectar instância:", e);
        ctx.reply("❌ Erro ao conectar. Tente novamente.");
    }
});

bot.action("refresh_instances", async (ctx) => {
    ctx.answerCbQuery("Atualizando...");
    // Aqui você pode adicionar lógica para verificar o status real das instâncias via WUZAPI
    bot.handleUpdate({ callback_query: { ...ctx.callbackQuery, data: "connect_instance" } });
});

bot.on("text", async (ctx) => {
    const s = await getSession(ctx.chat.id);
    if (isAdmin(ctx)) {
        if (s.stage === "ADMIN_WAIT_PRICE") {
            const p = parseFloat(ctx.message.text.replace(",", "."));
            if (isNaN(p)) return ctx.reply("❌ Valor inválido.");
            const cfg = await getSystemConfig(); cfg.dailyPrice = p;
            await supabase.from('bot_sessions').upsert({ chat_id: 'ZAPMASS_CONFIG', data: cfg });
            s.stage = "START"; await saveSession(ctx.chat.id, s);
            ctx.reply(`✅ Preço alterado para R$ ${p.toFixed(2)}`);
            return renderStart(ctx);
        }
        if (s.stage === "ADMIN_WAIT_USER_ID") {
            const tid = ctx.message.text.trim(), ts = await getSession(tid);
            ts.isVip = true; const now = new Date(); now.setDate(now.getDate() + 30);
            ts.subscriptionExpiry = now.toISOString();
            await saveSession(tid, ts);
            s.stage = "START"; await saveSession(ctx.chat.id, s);
            ctx.reply(`✅ VIP 30d ativado para ${tid}!`);
            return renderStart(ctx);
        }
    }
});

bot.action("admin_set_price", async (ctx) => {
    const s = await getSession(ctx.chat.id); s.stage = "ADMIN_WAIT_PRICE";
    await saveSession(ctx.chat.id, s); ctx.reply("Novo valor da diária:");
});

bot.action("admin_give_vip", async (ctx) => {
    const s = await getSession(ctx.chat.id); s.stage = "ADMIN_WAIT_USER_ID";
    await saveSession(ctx.chat.id, s); ctx.reply("ID do Usuário:");
});

// Webhook
app.post("/webhook", async (req, res) => {
    const { external_id, status, amount } = req.body;
    console.log(`📥 [WEBHOOK] Recebido:`, { external_id, status, amount });

    if ((status === "paid" || status === "approved") && external_id && external_id.startsWith("ZAPMASS_")) {
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

            console.log(`✅ [WEBHOOK] VIP ativado para ${cid}: +${days} dias`);
            try {
                await bot.telegram.sendMessage(cid, `💎 *Pagamento Confirmado!*\n\n+${days} dias de acesso VIP.\nValidade: ${exp.toLocaleDateString()}`, { parse_mode: "Markdown" });
            } catch (e) {
                console.error(`❌ [WEBHOOK] Erro ao enviar mensagem:`, e);
            }
        }
    }
    res.sendStatus(200);
});

bot.launch().then(() => {
    console.log(`🚀 [ZAPMASS] V1.220 - ONLINE`);
    bot.telegram.deleteWebhook().catch(() => { });
});
app.listen(PORT, () => console.log(`🌍 ZapMass [V1.220] PORT ${PORT}`));
