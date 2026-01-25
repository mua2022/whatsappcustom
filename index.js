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

/* ── CONFIG & INIT ── */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", credentials: true }
});

app.use(cors());
app.use(express.json({ limit: "5mb" })); // Reduced limit for better performance

const adapter = new JSONFile("db.json");
const db = new Low(adapter, { sessions: [], messages: [], scheduledMessages: [] });
await db.read();

/* ── WHATSAPP SETUP ── */
let chatCache = new Map(); // Using a Map for O(1) lookups instead of Array.find
let isClientReady = false;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "whatsapp-scheduler" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  }
});

/* ── HELPER: UPDATE CACHE & EMIT ── */
const updateChatInCache = async (chatId) => {
  try {
    const chat = await client.getChatById(chatId);
    const simplifiedChat = {
      id: chat.id._serialized,
      name: chat.name,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp
    };
    chatCache.set(chatId, simplifiedChat);
    io.emit("chat_update", Array.from(chatCache.values()));
  } catch (e) {
    console.error("Cache update failed", e);
  }
};

/* ── CLIENT EVENTS ── */
client.on("qr", async (qr) => {
  const qrImage = await qrcode.toDataURL(qr);
  io.emit("qr", { qrImage });
});

client.on("ready", async () => {
  isClientReady = true;
  console.log("🚀 Client Ready");
  
  // Initial Load (Only once)
  const chats = await client.getChats();
  chats.slice(0, 50).forEach(c => {
    chatCache.set(c.id._serialized, {
      id: c.id._serialized,
      name: c.name,
      unreadCount: c.unreadCount
    });
  });
  io.emit("ready", { chats: Array.from(chatCache.values()) });
});

// Update UI instantly on new message instead of polling
client.on("message", async (msg) => {
  await updateChatInCache(msg.from);
  io.emit("new_message", { chatId: msg.from, content: msg.body, fromMe: false });
});

client.initialize();

/* ── OPTIMIZED API ROUTES ── */
app.get("/api/chats", (req, res) => {
  res.json({ chats: Array.from(chatCache.values()) });
});

app.post("/api/send-bulk", async (req, res) => {
  const { contacts, message } = req.body; // contacts: Array of IDs
  
  res.json({ success: true, message: "Bulk process started" });

  // Process in background so API doesn't hang
  for (const contact of contacts) {
    try {
      await client.sendMessage(contact, message);
      // Wait 2 seconds between each message to avoid ban/lag
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      console.error(`Failed to send to ${contact}`);
    }
  }
});

/* ── OPTIMIZED SCHEDULER ── */
cron.schedule("* * * * *", async () => {
  if (!isClientReady) return;

  const now = new Date();
  let hasChanged = false;

  // Only process pending messages
  const pending = db.data.scheduledMessages.filter(m => !m.sent && new Date(m.sendAt) <= now);

  for (const msg of pending) {
    try {
      await client.sendMessage(msg.chatId, msg.content);
      msg.sent = true;
      msg.sentAt = new Date().toISOString();
      hasChanged = true;
      
      // Delay to prevent CPU spikes
      await new Promise(res => setTimeout(res, 1500));
    } catch (err) {
      msg.error = err.message;
    }
  }

  if (hasChanged) await db.write(); // Only write if something actually happened
});

server.listen(5000, () => console.log("🌐 Server on 5000"));
