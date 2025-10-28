import express from "express";
import http from "http";
import { Server } from "socket.io";
import pkg from "whatsapp-web.js";
import qrcode from "qrcode";
import cors from "cors";
import cron from "node-cron";
import fs from "fs";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

const { Client, LocalAuth } = pkg;

/* ────────────────────────────────
   ⚙️ Express + Socket.IO Setup
──────────────────────────────── */
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ["https://whatsappweb.marulahomedecor.net"], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000
});

/* ────────────────────────────────
   🗃️ LowDB Optimized Initialization
──────────────────────────────── */
const dbFile = "db.json";
const defaultData = { sessions: [], messages: [], scheduledMessages: [] };

function ensureValidDB() {
  try {
    if (!fs.existsSync(dbFile)) {
      fs.writeFileSync(dbFile, JSON.stringify(defaultData, null, 2));
      return;
    }
    
    const content = fs.readFileSync(dbFile, "utf8").trim();
    if (!content || content === "{}") {
      fs.writeFileSync(dbFile, JSON.stringify(defaultData, null, 2));
      return;
    }
    
    try {
      const parsed = JSON.parse(content);
      // Ensure all required fields exist
      if (!parsed.sessions) parsed.sessions = [];
      if (!parsed.messages) parsed.messages = [];
      if (!parsed.scheduledMessages) parsed.scheduledMessages = [];
      fs.writeFileSync(dbFile, JSON.stringify(parsed, null, 2));
    } catch {
      fs.writeFileSync(dbFile, JSON.stringify(defaultData, null, 2));
    }
  } catch (err) {
    console.error("[FATAL] DB init error:", err.message);
    process.exit(1);
  }
}
ensureValidDB();

const adapter = new JSONFile(dbFile);
const db = new Low(adapter, defaultData);
await db.read();
db.data ||= defaultData;
await db.write();

/* ────────────────────────────────
   🤖 WhatsApp Client Setup (Lazy Init)
──────────────────────────────── */
let chatCache = [];
let isClientReady = false;
let currentQrCode = null;
let client = null;
let initializationPromise = null;

// Optimized client configuration
function createClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: "whatsapp-scheduler",
      dataPath: "/opt/render/project/src/.wwebjs_auth",
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // Better for containers
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
      ],
      timeout: 30000, // 30s timeout
    },
    webVersionCache: {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
    qrMaxRetries: 5,
  });
}

/* ────────────────────────────────
   🧩 WhatsApp Client Events
──────────────────────────────── */
function setupClientEvents(client) {
  client.on("qr", async (qr) => {
    console.log("🔐 QR generated");
    try {
      const qrImage = await qrcode.toDataURL(qr);
      currentQrCode = qrImage;
      io.emit("qr", { qrImage });
      io.emit("status", { message: "📱 Scan QR code", type: "info" });
    } catch (err) {
      console.error("QR error:", err.message);
    }
  });

  client.on("authenticated", () => {
    console.log("🔑 Authenticated");
    io.emit("status", { message: "Authentication successful", type: "success" });
  });

  client.on("ready", async () => {
    console.log("✅ Client ready!");
    isClientReady = true;
    currentQrCode = null;

    // Load chats asynchronously without blocking
    loadChatsAsync();
    
    io.emit("ready", { message: "✅ WhatsApp ready!" });
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ Auth failure:", msg);
    isClientReady = false;
    currentQrCode = null;
    io.emit("status", { message: "Auth failed. Rescan QR.", type: "error" });
  });

  client.on("disconnected", (reason) => {
    console.log("⚠️ Disconnected:", reason);
    isClientReady = false;
    currentQrCode = null;
    io.emit("status", { message: "Reconnecting...", type: "warning" });
    
    // Retry connection with backoff
    setTimeout(() => initializeClient(), 5000);
  });
}

// Async chat loading to avoid blocking
async function loadChatsAsync() {
  try {
    const allChats = await client.getChats();
    chatCache = allChats
      .filter((c) => c.id.server !== "broadcast" && c.id.server !== "status")
      .slice(0, 100)
      .map((chat) => ({
        id: chat.id._serialized,
        name: chat.name || chat.id.user,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount || 0,
      }));
    console.log(`💬 Cached ${chatCache.length} chats`);
  } catch (err) {
    console.error("Chat load error:", err.message);
  }
}

// Lazy initialization - only start WhatsApp when needed
function initializeClient() {
  if (initializationPromise) return initializationPromise;
  
  initializationPromise = (async () => {
    if (!client) {
      client = createClient();
      setupClientEvents(client);
    }
    await client.initialize();
  })();
  
  return initializationPromise;
}

/* ────────────────────────────────
   🔄 Smart Chat Refresh (only when active)
──────────────────────────────── */
let lastActivity = Date.now();
let refreshInterval = null;

function startChatRefresh() {
  if (refreshInterval) return;
  
  refreshInterval = setInterval(async () => {
    // Stop refreshing if inactive for 10 minutes
    if (Date.now() - lastActivity > 10 * 60 * 1000) {
      console.log("💤 Pausing chat refresh (inactive)");
      return;
    }
    
    if (!isClientReady) return;
    
    try {
      await loadChatsAsync();
    } catch (err) {
      console.error("Refresh error:", err.message);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

/* ────────────────────────────────
   💬 API Endpoints
──────────────────────────────── */

// Health check - doesn't require WhatsApp to be initialized
app.get("/api/health", (req, res) => {
  res.json({
    status: isClientReady ? "connected" : "disconnected",
    hasQr: !!currentQrCode,
    timestamp: new Date().toISOString(),
  });
});

// Initialize WhatsApp on first request
app.get("/api/init", async (req, res) => {
  try {
    if (!client) {
      initializeClient();
      return res.json({ 
        message: "Initializing WhatsApp...", 
        status: "initializing" 
      });
    }
    
    res.json({ 
      status: isClientReady ? "ready" : "initializing",
      hasQr: !!currentQrCode 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/chats", async (req, res) => {
  lastActivity = Date.now();
  
  if (!client) {
    return res.status(503).json({ 
      error: "WhatsApp not initialized. Call /api/init first." 
    });
  }
  
  if (!isClientReady) {
    return res.status(503).json({ error: "WhatsApp client not ready" });
  }
  
  res.json({ chats: chatCache });
});

app.post("/api/chats/:chatId/messages", async (req, res) => {
  lastActivity = Date.now();
  const { chatId } = req.params;
  const { content } = req.body;
  
  try {
    if (!client) {
      return res.status(503).json({ 
        error: "WhatsApp not initialized" 
      });
    }
    
    if (!isClientReady) {
      return res.status(503).json({ error: "WhatsApp client not ready" });
    }

    const message = await client.sendMessage(chatId, content);
    const messageData = {
      id: message.id._serialized,
      chatId,
      content,
      timestamp: new Date().toISOString(),
      fromMe: true,
      sender: "You",
      type: "chat",
      status: "sent",
    };

    // Async DB write to not block response
    setImmediate(async () => {
      db.data.messages.push(messageData);
      await db.write();
    });
    
    io.emit("new_message", messageData);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Send error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Schedule message endpoint
app.post("/api/schedule", async (req, res) => {
  const { chatId, content, sendAt } = req.body;
  
  try {
    const scheduledMsg = {
      id: Date.now().toString(),
      chatId,
      content,
      sendAt,
      sent: false,
      createdAt: new Date().toISOString()
    };
    
    db.data.scheduledMessages.push(scheduledMsg);
    await db.write();
    
    res.json({ success: true, message: scheduledMsg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────
   ⏰ Scheduler (only runs if client ready)
──────────────────────────────── */
cron.schedule("* * * * *", async () => {
  if (!isClientReady || !client) return;
  
  const now = new Date();
  const toSend = (db.data.scheduledMessages || [])
    .filter(msg => !msg.sent && new Date(msg.sendAt) <= now);

  if (toSend.length === 0) return;

  for (const msg of toSend) {
    try {
      await client.sendMessage(msg.chatId, msg.content);
      msg.sent = true;
      msg.sentAt = new Date().toISOString();
      
      io.emit("new_message", {
        chatId: msg.chatId,
        content: `[SCHEDULED] ${msg.content}`,
        fromMe: true,
        sender: "You",
        type: "chat",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      msg.error = err.message;
      console.error("Scheduled send failed:", err.message);
    }
  }

  await db.write();
});

/* ────────────────────────────────
   🚀 Start Server (Fast Startup)
──────────────────────────────── */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🌐 Server ready on port ${PORT}`);
  console.log(`📱 WhatsApp: Call /api/init to start`);
  
  // Start chat refresh only after first client init
  startChatRefresh();
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("🛑 Shutting down...");
  if (client) await client.destroy();
  if (refreshInterval) clearInterval(refreshInterval);
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("🛑 Terminating...");
  if (client) await client.destroy();
  if (refreshInterval) clearInterval(refreshInterval);
  process.exit(0);
});