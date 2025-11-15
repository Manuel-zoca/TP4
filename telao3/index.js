require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
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
const AUTH_FOLDER = "./auth_info_baileys";

let pendingMessages = [];
let authReady = false;
let qrSent = false;
let sock = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;

// ===================== Funções de sincronização com Supabase =====================

async function syncAuthFromSupabase() {
  console.log("🔄 Verificando sessão salva no Supabase...");

  if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  }

  try {
    const { data, error } = await supabase.storage.from(BUCKET).list("", { limit: 100 });
    if (error) throw error;

    if (!data || data.length === 0) {
      console.log("ℹ️ Nenhuma sessão encontrada no Supabase. Será necessário escanear o QR.");
      return false;
    }

    console.log(`📥 Baixando ${data.length} arquivos de sessão...`);
    for (const file of data) {
      const { data: fileData, error: downloadErr } = await supabase.storage.from(BUCKET).download(file.name);
      if (downloadErr) throw downloadErr;
      const buffer = Buffer.from(await fileData.arrayBuffer());
      fs.writeFileSync(path.join(AUTH_FOLDER, file.name), buffer);
    }

    console.log("✅ Sessão carregada do Supabase. Não será necessário QR.");
    return true;
  } catch (err) {
    console.log("ℹ️ Nenhuma sessão válida encontrada. Será necessário escanear o QR.");
    // Limpa pasta local se corrompida
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    return false;
  }
}

async function syncAuthToSupabase() {
  if (!fs.existsSync(AUTH_FOLDER)) return;

  const files = fs.readdirSync(AUTH_FOLDER);
  console.log(`☁️ Enviando ${files.length} arquivos de sessão para o Supabase...`);

  for (const file of files) {
    try {
      const filePath = path.join(AUTH_FOLDER, file);
      const content = fs.readFileSync(filePath);
      await supabase.storage.from(BUCKET).upload(file, content, { upsert: true });
    } catch (err) {
      console.error(`❌ Erro ao enviar ${file}:`, err.message);
    }
  }
  console.log("✅ Sessão salva com sucesso no Supabase.");
}

// ===================== Health Check e Keep Alive =====================
function setupHealthChecks() {
  // Health check endpoint
  app.get("/health", (_, res) => {
    const status = authReady ? "connected" : "disconnected";
    res.json({ 
      status, 
      reconnectionAttempts: reconnectAttempts,
      timestamp: new Date().toISOString()
    });
  });

  // Keep alive ping every 5 minutes
  setInterval(() => {
    if (sock && authReady) {
      try {
        // Envia um ping para manter a conexão ativa
        sock.ev.emit("connection.update", { connection: "ping" });
      } catch (error) {
        console.log("🔄 Ping de manutenção...");
      }
    }
  }, 5 * 60 * 1000);
}

// ===================== Bot =====================
async function iniciarBot(deviceName) {
  console.log(`🟢 Iniciando o bot no modo MULTI-DEVICE para: ${deviceName}...`);
  
  // Limpa tentativas anteriores se for uma reconexão bem-sucedida
  if (authReady) {
    reconnectAttempts = 0;
  }

  // 1️⃣ Tenta carregar sessão do Supabase
  const hasSession = await syncAuthFromSupabase();
  qrSent = false;

  // 2️⃣ Configura autenticação
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, saveCreds)
    },
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    markOnlineOnConnect: true, // Mantém online
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => {
      return { conversation: "placeholder" };
    },
    // Configurações adicionais para estabilidade
    retryRequestDelayMs: 1000,
    maxRetries: 10,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000 // Keep alive a cada 30 segundos
  });

  const processPendingMessages = async () => {
    if (pendingMessages.length > 0) {
      console.log(`📨 Processando ${pendingMessages.length} mensagens pendentes...`);
      for (const { jid, msg } of pendingMessages) {
        try {
          await sock.sendMessage(jid, msg);
        } catch (e) {
          console.error("❌ Falha ao reenviar mensagem pendente:", e.message);
        }
      }
      pendingMessages = [];
    }
  };

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !qrSent) {
      qrSent = true;
      reconnectAttempts = 0; // Reset na contagem quando QR é gerado
      try {
        const qrBase64 = await QRCode.toDataURL(qr);
        console.log(`\n\n📌 QR CODE PARA CONECTAR (escaneie nos próximos 30s):\n`);
        console.log(qrBase64.split(",")[1]);
        console.log("\n");
      } catch (err) {
        console.error("❌ Erro ao gerar QR Code:", err);
      }
    }

    if (connection === "close") {
      const motivo = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.error(`⚠️ Conexão fechada: ${motivo}`);
      
      reconnectAttempts++;
      
      // Estratégia de reconexão exponencial
      const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), 30000);

      if (motivo === DisconnectReason.loggedOut) {
        console.log("❌ Sessão inválida. Limpando e pedindo novo QR...");
        if (fs.existsSync(AUTH_FOLDER)) {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        }
        reconnectAttempts = 0;
        setTimeout(() => iniciarBot(deviceName), 3000);
      } else if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.log("🔴 Máximo de tentativas de reconexão atingido. Reiniciando processo...");
        process.exit(1); // Força reinício completo pelo PM2/Uptimer
      } else {
        console.log(`🔄 Tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}. Reconectando em ${delay}ms...`);
        authReady = false;
        setTimeout(() => iniciarBot(deviceName), delay);
      }
    } else if (connection === "open") {
      console.log(`✅✅✅ BOT CONECTADO COM SUCESSO!`);
      console.log(`✅ Tentativas de reconexão: ${reconnectAttempts}`);
      console.log(`✅ Grupos antigos DEVEM funcionar normalmente.`);
      authReady = true;
      reconnectAttempts = 0; // Reset no contador ao conectar
      await processPendingMessages();
      await syncAuthToSupabase(); // salva sessão logo após conectar
    } else if (connection === "connecting") {
      console.log("🔄 Conectando...");
    }
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await syncAuthToSupabase();
  });

  // ===================== SenderKey cache & throttle =====================
  const senderReadyGroups = new Set();
  const senderAttemptAt = new Map();
  const SENDER_COOLDOWN_MS = 60 * 1000; // 60 segundos

  const ensureGroupReady = async (groupId) => {
    if (!groupId || !groupId.endsWith("@g.us")) return true;

    if (senderReadyGroups.has(groupId)) return true;

    const lastAttempt = senderAttemptAt.get(groupId) || 0;
    const now = Date.now();
    if (now - lastAttempt < SENDER_COOLDOWN_MS) {
      return false;
    }

    senderAttemptAt.set(groupId, now);

    try {
      await sock.sendMessage(groupId, { text: "🔐 Inicializando grupo..." });
      senderReadyGroups.add(groupId);
      return true;
    } catch (err) {
      console.warn(`⚠️ Falha na inicialização do grupo ${groupId}: ${err.message}`);
      return false;
    }
  };

  // ===================== Processamento de mensagens =====================
  const processMessage = async (msg) => {
    const senderJid = msg.key.remoteJid;
    let messageText = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.text ||
      ""
    ).replace(/[\u200e\u200f\u2068\u2069]/g, "").trim();
    const lowerText = messageText.toLowerCase();

    try { 
      await handleAntiLinkMessage(sock, msg); 
    } catch (err) { 
      console.error("AntiLink:", err); 
    }

    try {
      if (msg.message?.imageMessage && senderJid.endsWith("@g.us")) await handleComprovanteFoto(sock, msg);
      await handleMensagemPix(sock, msg);

      if (senderJid.endsWith("@g.us")) {
        const ready = await ensureGroupReady(senderJid);
        if (!ready) {
          console.log(`ℹ️ SenderKey não pronta para ${senderJid}. Processando comandos leves.`);
          if (lowerText === "@tabela" || ['.t', '.n', '.i', '.s'].includes(lowerText)) {
            try {
              await handleTabela(sock, msg, { fallbackTextOnly: true });
            } catch (e) {
              try { 
                await handleTabela(sock, msg); 
              } catch (err) { 
                console.error("Tabela fallback erro:", err.message); 
              }
            }
            return;
          }
        }
      }

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
      if (authReady) {
        try {
          await sock.sendMessage(senderJid, { text: "❌ Ocorreu um erro ao processar sua solicitação." });
        } catch (e) {
          pendingMessages.push({ jid: senderJid, msg: { text: "❌ Ocorreu um erro ao processar sua solicitação." } });
        }
      } else {
        pendingMessages.push({ jid: senderJid, msg: { text: "❌ Ocorreu um erro ao processar sua solicitação." } });
      }
    }
  };

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages.length) return;
    const msg = messages[0];
    if (msg.key.fromMe) return;

    if (!authReady) {
      pendingMessages.push({ 
        jid: msg.key.remoteJid, 
        msg: { text: "⏳ Bot iniciando, aguarde..." } 
      });
      return;
    }

    process.nextTick(() => {
      processMessage(msg).catch(err => console.error("processMessage catch:", err));
    });
  });

  sock.ev.on("messages.reaction", async reactions => {
    for (const reactionMsg of reactions) {
      try {
        await handleReaction({ reactionMessage: reactionMsg, sock });
      } catch (err) {
        console.error("Erro reação:", err);
      }
    }
  });

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action === "add") {
      for (let participant of participants) {
        const nome = participant.split("@")[0];
        const mensagem = `@${nome}  *👋 Seja muito bem-vindo(a) ao grupo!*\n\n🎉 Ficamos felizes em ter você conosco.\n\nQualquer dúvida, estamos aqui para ajudar!`.trim();

        try {
          const ppUrl = await sock.profilePictureUrl(participant, "image").catch(() => null);
          if (ppUrl) {
            await sock.sendMessage(id, { 
              image: { url: ppUrl }, 
              caption: mensagem, 
              mentions: [participant] 
            });
          } else {
            await sock.sendMessage(id, { 
              text: mensagem, 
              mentions: [participant] 
            });
          }
        } catch (err) { 
          console.error("Erro ao dar boas-vindas:", err);
        }
      }
    }
  });

  return sock;
}

// ===================== Inicialização =====================
setupHealthChecks();

// Função de inicialização com tratamento de erro global
async function startBot() {
  try {
    await iniciarBot("Dispositivo 1");
  } catch (error) {
    console.error("❌ Erro crítico ao iniciar bot:", error);
    console.log("🔄 Tentando reiniciar em 10 segundos...");
    setTimeout(startBot, 10000);
  }
}

// Inicia o bot
startBot();

// ===================== Servidor HTTP =====================
const PORT = process.env.PORT || 10000;
app.get("/", (_, res) => {
  const status = authReady ? "conectado" : "desconectado";
  res.send(`
    <html>
      <head>
        <title>TopBot Status</title>
        <meta http-equiv="refresh" content="30">
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
          .status { padding: 20px; border-radius: 10px; color: white; font-weight: bold; }
          .connected { background: #28a745; }
          .disconnected { background: #dc3545; }
          .info { background: white; padding: 20px; margin-top: 20px; border-radius: 10px; }
        </style>
      </head>
      <body>
        <h1>🤖 TopBot MULTI-DEVICE</h1>
        <div class="status ${authReady ? 'connected' : 'disconnected'}">
          Status: ${authReady ? '✅ CONECTADO' : '❌ DESCONECTADO'}
        </div>
        <div class="info">
          <p><strong>Tentativas de reconexão:</strong> ${reconnectAttempts}</p>
          <p><strong>Porta:</strong> ${PORT}</p>
          <p><strong>Última atualização:</strong> ${new Date().toLocaleString()}</p>
          <p><a href="/health">Ver JSON completo</a></p>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`🌐 Servidor HTTP ativo na porta ${PORT}`));

// ===================== Process Handlers =====================
// Tratamento de sinais para graceful shutdown
process.on('SIGINT', () => {
  console.log('🔄 Recebido SIGINT. Encerrando gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🔄 Recebido SIGTERM. Encerrando gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Exceção não capturada:', error);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada não tratada:', reason);
});
