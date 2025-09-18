require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const { Boom } = require("@hapi/boom");
const express = require("express");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Handlers
const { handleMessage } = require("./handlers/messageHandler");
const { handleConcorrer } = require("./handlers/concorrerHandler");
const { handleListar } = require("./handlers/listarHandler");
const { handleRemove } = require("./handlers/removeHandler");
const { handlePagamento } = require("./handlers/pagamentoHandler");
const { handleGrupo } = require("./handlers/grupoHandler");
const { handleBan } = require("./handlers/banHandler");
const { handleCompra } = require("./handlers/compraHandler");
const { handleTabela } = require("./handlers/tabelaHandler");
const { handleTodos } = require("./handlers/todosHandler");
const { handleMensagemPix } = require("./handlers/pixHandler");
const { handleComprovanteFoto } = require("./handlers/handleComprovanteFoto");
const { handleReaction } = require("./handlers/reactionHandler");
const { handleAntiLinkMessage } = require("./handlers/antiLink");
const { handleCompra2 } = require("./handlers/compra2Handler");

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = process.env.BUCKET_NAME || "whatsapp-auth";
const AUTH_FOLDER = "./auth1";

let pendingMessages = [];
let authReady = false;

// ===================== Funções de sincronização com Supabase =====================
async function syncAuthFromSupabase() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER);

  console.log("🔄 Listando arquivos de sessão no Supabase...");
  const { data, error } = await supabase.storage.from(BUCKET).list("", { limit: 100 });
  if (error) {
    console.error("❌ Erro ao listar Supabase:", error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.log("ℹ️ Nenhum arquivo de sessão encontrado no Supabase.");
    return;
  }

  console.log(`ℹ️ Encontrados ${data.length} arquivos de sessão. Iniciando download...`);

  for (let i = 0; i < data.length; i++) {
    const file = data[i];
    try {
      const { data: fileData, error: downloadErr } = await supabase.storage.from(BUCKET).download(file.name);
      if (downloadErr) throw downloadErr;

      const buffer = Buffer.from(await fileData.arrayBuffer());
      fs.writeFileSync(path.join(AUTH_FOLDER, file.name), buffer);

      const sizeKB = (buffer.length / 1024).toFixed(2);
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      console.log(`📥 [${i + 1}/${data.length}] Baixado: ${file.name} → ${sizeKB} KB (${sizeMB} MB)`);
    } catch (err) {
      console.error("❌ Erro ao baixar", file.name, ":", err.message);
    }
  }

  console.log("✅ Todos os arquivos de sessão foram carregados do Supabase.");
}

// Upload para Supabase
async function syncAuthToSupabase() {
  if (!fs.existsSync(AUTH_FOLDER)) return;

  const files = fs.readdirSync(AUTH_FOLDER);
  for (const file of files) {
    try {
      const filePath = path.join(AUTH_FOLDER, file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath);
      await supabase.storage.from(BUCKET).upload(file, content, { upsert: true });
    } catch (err) {
      console.error("❌ Erro ao enviar arquivo para Supabase:", file, err.message);
    }
  }
  console.log("☁️ Sessão enviada para Supabase.");
}

// ===================== Bot =====================
async function iniciarBot(deviceName, authFolder) {
  console.log(`🟢 Iniciando o bot para o dispositivo: ${deviceName}...`);

  // 1️⃣ Baixa a sessão do Supabase antes de iniciar
  await syncAuthFromSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    qrTimeout: 60_000,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
  });

  const processPendingMessages = async () => {
    for (const { jid, msg } of pendingMessages) {
      try { await sock.sendMessage(jid, msg); } 
      catch (e) { console.error("❌ Falha ao reenviar mensagem pendente:", e.message); }
    }
    pendingMessages = [];
  };

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrBase64 = await QRCode.toDataURL(qr);
        console.log(`📌 Escaneie o QR Code do dispositivo: ${deviceName}`);
        console.log(qrBase64.split(",")[1]);
      } catch (err) {
        console.error("❌ Erro ao gerar QR Code base64:", err);
      }
    }

    if (connection === "close") {
      const motivo = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.error(`⚠️ Conexão fechada: ${motivo}`);

      if (motivo === DisconnectReason.loggedOut) {
        console.log("❌ Bot deslogado. Encerrando...");
        process.exit(0);
      }

      console.log("🔄 Tentando reconectar...");
      setTimeout(() => iniciarBot(deviceName, authFolder), 3000);
    } else if (connection === "open") {
      console.log(`✅ Bot conectado no dispositivo: ${deviceName}`);
      authReady = true;
      await processPendingMessages();
    }
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await syncAuthToSupabase();
  });

  const processMessage = async (msg) => {
    const senderJid = msg.key.remoteJid;
    let messageText = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.text ||
      ""
    ).replace(/[\u200e\u200f\u2068\u2069]/g, "").trim();
    const lowerText = messageText.toLowerCase();

    try { await handleAntiLinkMessage(sock, msg); } catch (err) { console.error(err); }
    try {
      if (msg.message?.imageMessage && senderJid.endsWith("@g.us")) await handleComprovanteFoto(sock, msg);
      await handleMensagemPix(sock, msg);

      // Comandos
      if (lowerText.startsWith(".compra")) await handleCompra2(sock, msg);
      else if (lowerText === "@concorrentes") await handleListar(sock, msg);
      else if (lowerText.startsWith("@remove") || lowerText.startsWith("/remove")) await handleRemove(sock, msg);
      else if (lowerText.startsWith("@ban") || lowerText.startsWith("/ban")) await handleBan(sock, msg);
      else if (lowerText === "@pagamentos") await handlePagamento(sock, msg);
      else if (["@grupo on", "@grupo off"].includes(lowerText)) await handleGrupo(sock, msg);
      else if (lowerText.startsWith("@compra") || lowerText.startsWith("@rentanas") || lowerText.startsWith("@remove rentanas")) await handleCompra(sock, msg);
      else if (senderJid.endsWith("@g.us") && lowerText === "@concorrencia") await handleConcorrer(sock, msg);
      else if (lowerText === "@tabela") await handleTabela(sock, msg);
      else if (lowerText === "@todos") await handleTodos(sock, msg);
      else if (lowerText.startsWith("@") || lowerText.startsWith("/")) await handleMessage(sock, msg);
      else if (['.n', '.t', '.i', '.s'].includes(lowerText)) await handleTabela(sock, msg);

    } catch (err) {
      console.error("❌ Erro ao processar mensagem:", err);
      pendingMessages.push({ jid: senderJid, msg: { text: "❌ Ocorreu um erro ao processar sua solicitação." } });
    }
  };

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages.length) return;
    const msg = messages[0];
    if (msg.key.fromMe) return;

    if (!authReady) {
      pendingMessages.push({ jid: msg.key.remoteJid, msg: { text: "⏳ Bot iniciando, sua mensagem será processada em breve." } });
      return;
    }

    await processMessage(msg);
  });

  sock.ev.on("messages.reaction", async reactions => {
    for (const reactionMsg of reactions) await handleReaction({ reactionMessage: reactionMsg, sock });
  });

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action === "add") {
      for (let participant of participants) {
        const nome = participant.split("@")[0];
        const mensagem = `@${nome}  *👋 Seja muito bem-vindo(a) ao grupo!*\n\n🎉 Ficamos felizes em ter você conosco.\n\nQualquer dúvida, estamos aqui para ajudar!`.trim();

        try {
          const ppUrl = await sock.profilePictureUrl(participant, "image").catch(() => null);
          if (ppUrl) await sock.sendMessage(id, { image: { url: ppUrl }, caption: mensagem, mentions: [participant] });
          else await sock.sendMessage(id, { text: mensagem, mentions: [participant] });
        } catch (err) { console.error(err); }
      }
    }
  });

  return sock;
}

// ===================== Inicialização =====================
iniciarBot("Dispositivo 1", AUTH_FOLDER);

// ===================== Servidor HTTP =====================
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("✅ TopBot rodando com sucesso!"));
app.listen(PORT, () => console.log(`🌐 Servidor HTTP ativo na porta ${PORT}`));
