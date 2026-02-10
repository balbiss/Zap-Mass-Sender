import express from "express";
import { Telegraf, Markup } from "telegraf";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8899;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WUZAPI_BASE_URL = process.env.WUZAPI_BASE_URL || "http://wuzapi:8080";
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN;

if (!TELEGRAM_TOKEN) {
    console.error("❌ TELEGRAM_TOKEN não definido!");
    process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// --- Armazenamento em Memória (MVP) ---
// Em produção, usar SQLite ou Supabase
const sessions = new Map();

// --- Utilitários ---
async function callWuzapi(endpoint, method = "GET", body = null, token = null) {
    const headers = {
        "Content-Type": "application/json",
        "pk": WUZAPI_ADMIN_TOKEN
    };
    if (token) headers["token"] = token;

    try {
        const options = { method, headers };
        if (body) options.body = JSON.stringify(body);
        const res = await fetch(`${WUZAPI_BASE_URL}${endpoint}`, options);
        return await res.json();
    } catch (e) {
        console.error(`[WUZAPI] Erro: ${e.message}`);
        return { error: true };
    }
}

// --- Comandos do Bot ---

bot.start((ctx) => {
    ctx.reply("🚀 *ZapMass Sender*\n\nBem-vindo ao sistema de disparos em massa via Telegram.\n\nEscolha uma opção:", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("📱 Conectar Instância", "connect_instance")],
            [Markup.button.callback("📨 Novo Disparo", "new_campaign")],
            [Markup.button.callback("📊 Status", "status")]
        ])
    });
});

bot.action("connect_instance", async (ctx) => {
    const id = ctx.chat.id;
    // Lógica simplificada: 1 usuário = 1 instância fixa baseada no Chat ID
    const instanceName = `user_${id}`;

    ctx.reply("⏳ Gerando QR Code...");

    const res = await callWuzapi(`/instance/init?token=${instanceName}`, "GET");
    if (res.qrcode) {
        // Converter base64 para buffer e enviar imagem
        const buffer = Buffer.from(res.qrcode.replace(/^data:image\/png;base64,/, ""), 'base64');
        await ctx.replyWithPhoto({ source: buffer }, { caption: "Escaneie o QR Code acima no seu WhatsApp." });
    } else if (res.error) {
        ctx.reply("❌ Erro ao gerar QR Code. Tente novamente.");
    } else {
        ctx.reply("✅ Instância já conectada!");
    }
});

bot.action("new_campaign", (ctx) => {
    ctx.editMessageText("🎯 *Novo Disparo*\n\nQual o tipo de envio?", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("👤 Individual (.txt)", "camp_individual")],
            [Markup.button.callback("👥 Grupos", "camp_groups")],
            [Markup.button.callback("🔙 Voltar", "start")]
        ])
    });
});

bot.action("start", (ctx) => {
    // Retorna ao menu principal (mesma lógica do /start)
    ctx.editMessageText("🚀 *ZapMass Sender*\n\nBem-vindo ao sistema de disparos em massa via Telegram.\n\nEscolha uma opção:", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("📱 Conectar Instância", "connect_instance")],
            [Markup.button.callback("📨 Novo Disparo", "new_campaign")],
            [Markup.button.callback("📊 Status", "status")]
        ])
    });
});

// --- Inicialização ---

bot.launch();
console.log(`🤖 Bot ZapMass iniciado!`);

app.get("/", (req, res) => res.send("ZapMass Running 🚀"));
app.listen(PORT, () => console.log(`🌍 Server rodando na porta ${PORT}`));

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
