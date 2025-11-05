import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";
import fs from "fs";
import qrcode from "qrcode";
import pkg from "whatsapp-web.js";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

const { Client, LocalAuth } = pkg;

/* ────────────────────────────────
   ⚙️ SERVER & SOCKET.IO CONFIG
──────────────────────────────── */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://whatsappweb.marulahomedecor.net"],
    credentials: true,
  },
});

// Global Middleware
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));


/* ────────────────────────────────
   🗃️ DATABASE (LowDB)
──────────────────────────────── */
const DB_FILE = "db.json";
const DEFAULT_DATA = { sessions: [], messages: [], scheduledMessages: [] };

function initDatabase() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      console.log("[INFO] Creating new DB file...");
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
    } else {
      const content = fs.readFileSync(DB_FILE, "utf8").trim();
      try {
        if (!content) throw new Error("Empty");
        JSON.parse(content);
      } catch {
        console.warn("[WARN] Corrupted or empty DB. Reinitializing...");
        fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
      }
    }
  } catch (err) {
    console.error("[FATAL] Database initialization failed:", err);
    process.exit(1);
  }
}

initDatabase();

const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter, DEFAULT_DATA);
await db.read();
await db.write();

console.log("[INFO] Database loaded successfully.");


/* ────────────────────────────────
   🤖 WHATSAPP CLIENT SETUP
──────────────────────────────── */
let chatCache = [];
let currentQrCode = null;
let isClientReady = false;

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "whatsapp-scheduler",
    dataPath: "/opt/render/project/src/.wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
});


/* ────────────────────────────────
   🔔 CLIENT EVENT HANDLERS
──────────────────────────────── */
client.on("qr", async (qr) => {
  console.log("🔐 QR Code generated");
  try {
    const qrImage = await qrcode.toDataURL(qr);
    currentQrCode = qrImage;
    io.emit("qr", { qrImage });
    io.emit("status", { message: "📱 Scan the QR code", type: "info" });
  } catch (err) {
    console.error("QR Error:", err);
  }
});

client.on("authenticated", () => {
  console.log("🔑 Authenticated successfully");
  io.emit("status", { message: "Authenticated", type: "success" });
});

client.on("ready", async () => {
  console.log("✅ WhatsApp client ready!");
  isClientReady = true;
  currentQrCode = null;

  const chats = await client.getChats();
  chatCache = chats
    .filter((c) => c.id.server !== "broadcast" && c.id.server !== "status")
    .slice(0, 100)
    .map((c) => ({
      id: c.id._serialized,
      name: c.name || c.id.user,
      isGroup: c.isGroup,
      unreadCount: c.unreadCount || 0,
    }));

  console.log(`💬 Cached ${chatCache.length} chats.`);
  io.emit("ready", { message: "✅ WhatsApp is ready!" });
});

client.on("auth_failure", (msg) => {
  console.error("❌ Auth failure:", msg);
  isClientReady = false;
  io.emit("status", {
    message: "Auth failed. Rescan QR.",
    type: "error",
  });
});

client.on("disconnected", (reason) => {
  console.log("⚠️ Disconnected:", reason);
  isClientReady = false;
  io.emit("status", { message: "Reconnecting...", type: "warning" });
  setTimeout(() => client.initialize(), 4000);
});

client.initialize();


/* ────────────────────────────────
   🔄 CHAT CACHE REFRESH (5 min)
──────────────────────────────── */
setInterval(async () => {
  if (!isClientReady) return;
  try {
    const chats = await client.getChats();
    chatCache = chats
      .filter((c) => c.id.server !== "broadcast" && c.id.server !== "status")
      .slice(0, 100)
      .map((c) => ({
        id: c.id._serialized,
        name: c.name || c.id.user,
        isGroup: c.isGroup,
        unreadCount: c.unreadCount || 0,
      }));
    console.log("🔄 Chat cache refreshed.");
  } catch (err) {
    console.error("Chat refresh failed:", err.message);
  }
}, 1000 * 60 * 5);


/* ────────────────────────────────
   📡 API ROUTES
──────────────────────────────── */
app.get("/api/health", (req, res) => {
  res.json({
    status: isClientReady ? "connected" : "disconnected",
    hasQr: !!currentQrCode,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/chats", (req, res) => {
  if (!isClientReady)
    return res.status(503).json({ error: "WhatsApp not ready" });
  res.json({ chats: chatCache });
});

app.post("/api/chats/:chatId/messages", async (req, res) => {
  if (!isClientReady)
    return res.status(503).json({ error: "WhatsApp not ready" });

  const { chatId } = req.params;
  const { content } = req.body;

  try {
    const sentMsg = await client.sendMessage(chatId, content);

    const messageData = {
      id: sentMsg.id._serialized,
      chatId,
      content,
      timestamp: new Date().toISOString(),
      fromMe: true,
      sender: "You",
      type: "chat",
      status: "sent",
    };

    db.data.messages.push(messageData);
    await db.write();
    io.emit("new_message", messageData);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Message send failed:", err);
    res.status(500).json({ error: err.message });
  }
});


/* ────────────────────────────────
   ⏰ MESSAGE SCHEDULER (every min)
──────────────────────────────── */
cron.schedule("* * * * *", async () => {
  if (!isClientReady) return;
  const now = new Date();

  for (const msg of db.data.scheduledMessages || []) {
    if (!msg.sent && new Date(msg.sendAt) <= now) {
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
          timestamp: new Date(),
        });
      } catch (err) {
        msg.error = err.message;
      }
    }
  }

  await db.write();
});


/* ────────────────────────────────
   🚀 SERVER START
──────────────────────────────── */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp Scheduler Backend Ready`);
});

process.on("SIGINT", async () => {
  console.log("🛑 Gracefully shutting down...");
  await client.destroy();
  process.exit(0);
});
