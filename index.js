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
  cors: { origin: ["https://whatsappweb.marulahomedecor.net"], credentials: true }
});

app.use(cors({ origin: "https://whatsappweb.marulahomedecor.net", credentials: true }));


/* ────────────────────────────────
   🗃️ LowDB Safe Initialization
──────────────────────────────── */
const dbFile = "db.json";
const defaultData = { sessions: [], messages: [], scheduledMessages: [] };

function ensureValidDB() {
  try {
    if (!fs.existsSync(dbFile)) {
      console.log("[INFO] Creating new database file...");
      fs.writeFileSync(dbFile, JSON.stringify(defaultData, null, 2));
    } else {
      const content = fs.readFileSync(dbFile, "utf8").trim();
      if (!content) {
        console.log("[WARN] Empty DB detected. Reinitializing...");
        fs.writeFileSync(dbFile, JSON.stringify(defaultData, null, 2));
      } else {
        try {
          JSON.parse(content);
        } catch {
          console.log("[ERROR] Corrupted DB. Resetting...");
          fs.writeFileSync(dbFile, JSON.stringify(defaultData, null, 2));
        }
      }
    }
  } catch (err) {
    console.error("[FATAL] Could not initialize DB file:", err);
    process.exit(1);
  }
}
ensureValidDB();

const adapter = new JSONFile(dbFile);
const db = new Low(adapter, defaultData);
await db.read();
await db.write();
console.log("[INFO] Database loaded successfully.");

/* ────────────────────────────────
   🤖 WhatsApp Client Setup
──────────────────────────────── */
let chatCache = [];
let isClientReady = false;
let currentQrCode = null;

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
   🧩 WhatsApp Client Events
──────────────────────────────── */
client.on("qr", async (qr) => {
  console.log("🔐 QR Code generated");
  try {
    const qrImage = await qrcode.toDataURL(qr);
    currentQrCode = qrImage;
    io.emit("qr", { qrImage });
    io.emit("status", {
      message: "📱 Scan the QR code with WhatsApp",
      type: "info",
    });
  } catch (err) {
    console.error("QR generation error:", err);
  }
});

client.on("authenticated", () => {
  console.log("🔑 Authenticated successfully");
  io.emit("status", {
    message: "Authentication successful",
    type: "success",
  });
});

client.on("ready", async () => {
  console.log("✅ WhatsApp client ready!");
  isClientReady = true;
  currentQrCode = null;

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

  console.log(`💬 Cached ${chatCache.length} chats for quick access.`);
  io.emit("ready", { message: "✅ WhatsApp is ready!" });
});

client.on("auth_failure", (msg) => {
  console.error("❌ Auth failure:", msg);
  isClientReady = false;
  currentQrCode = null;
  io.emit("status", {
    message: "Authentication failed. Please rescan the QR code.",
    type: "error",
  });
});

client.on("disconnected", (reason) => {
  console.log("⚠️ Disconnected:", reason);
  isClientReady = false;
  currentQrCode = null;
  io.emit("status", {
    message: "Disconnected. Reinitializing...",
    type: "warning",
  });

  setTimeout(() => client.initialize(), 4000);
});

client.initialize();

/* ────────────────────────────────
   🔄 Periodic Chat Refresh
──────────────────────────────── */
setInterval(async () => {
  if (!isClientReady) return;
  try {
    const updated = await client.getChats();
    chatCache = updated
      .filter((c) => c.id.server !== "broadcast" && c.id.server !== "status")
      .slice(0, 100)
      .map((chat) => ({
        id: chat.id._serialized,
        name: chat.name || chat.id.user,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount || 0,
      }));
    console.log("🔄 Chat cache refreshed.");
  } catch (err) {
    console.error("Chat refresh error:", err.message);
  }
}, 1000 * 60 * 5); // every 5 minutes

/* ────────────────────────────────
   💬 API Endpoints
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
    return res.status(503).json({ error: "WhatsApp client not ready" });
  res.json({ chats: chatCache });
});

app.post("/api/chats/:chatId/messages", async (req, res) => {
  const { chatId } = req.params;
  const { content } = req.body;
  try {
    if (!isClientReady)
      return res.status(503).json({ error: "WhatsApp client not ready" });

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

    db.data.messages.push(messageData);
    await db.write();
    io.emit("new_message", messageData);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error sending message:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────
   ⏰ Scheduler
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
   🚀 Start Server
──────────────────────────────── */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp Scheduler Backend Ready`);
});

process.on("SIGINT", async () => {
  console.log("🛑 Shutting down...");
  await client.destroy();
  process.exit(0);
});
