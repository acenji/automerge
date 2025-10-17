// server.js — Automerge 0.14, FULL wire (string), "persisted" ACK, no-cache HTTP, hello + ping + debug_echo
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const Automerge = require("automerge");

// ---------- helpers ----------
const ts = () => new Date().toISOString().split("T")[1].replace("Z", "");
const qText = (d) => {
  try { return d?.pages?.[0]?.questionRows?.[0]?.elements?.[0]?.questionText ?? "(missing)"; }
  catch { return "(error)"; }
};
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ---------- config / paths ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const SNAPSHOT_JSON = path.join(__dirname, "manifest.json");

console.log("[SERVER vD] boot", new Date().toISOString());
log("[paths] SNAPSHOT_JSON:", SNAPSHOT_JSON);

// ---------- load or seed ----------
let doc;

function persistJson() {
  try {
    fs.writeFileSync(SNAPSHOT_JSON, JSON.stringify(doc, null, 2));
    log(`[persist] manifest.json saved; questionText="${qText(doc)}"`);
  } catch (e) {
    console.error(`[${ts()}] [persist] write error:`, e);
  }
}

function loadInitial() {
  if (fs.existsSync(SNAPSHOT_JSON)) {
    log("[load] found manifest.json");
    try {
      const seed = JSON.parse(fs.readFileSync(SNAPSHOT_JSON, "utf8"));
      doc = Automerge.from(seed);
      log(`[load] loaded; questionText="${qText(doc)}"`);
    } catch (e) {
      console.error(`[${ts()}] [load] parse error; starting empty:`, e);
      doc = Automerge.from({
        pages: [], tiles: [], merges: [], actions: [],
        databases: [], connections: [], styles: { theme: {} }
      });
      persistJson();
    }
  } else {
    log("[load] no manifest.json; starting empty");
    doc = Automerge.from({
      pages: [], tiles: [], merges: [], actions: [],
      databases: [], connections: [], styles: { theme: {} }
    });
    persistJson();
  }
}
loadInitial();

// ---------- HTTP (no-cache) ----------
const server = http.createServer((req, res) => {
  console.log("[http]", req.method, req.url);
  const pathname = (req.url || "/").split("?")[0];

  if (pathname === "/" || pathname === "/client.html") {
    const file = path.join(__dirname, "client.html");
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    };

    if (!fs.existsSync(file)) {
      res.writeHead(200, headers);
      return res.end("Place client.html next to server.js (server is running).");
    }

    const html = fs.readFileSync(file, "utf8");
    res.writeHead(200, { ...headers, "Content-Length": Buffer.byteLength(html, "utf8") });
    return res.end(html);
  }

  res.writeHead(404, { "Cache-Control": "no-store" });
  res.end("Not found");
});

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ server });
let nextClientId = 1;

wss.on("connection", (ws) => {
  const id = nextClientId++;
  log(`[ws] client#${id} CONNECTED (total: ${wss.clients.size})`);

  // 0) initial FULL on connect — payload is the *string* returned by Automerge.save(doc)
  try {
    const serial = Automerge.save(doc); // string
    const msg = JSON.stringify({ type: "full", payload: serial });
    ws.send(msg, { binary: false });
    log(`[ws->#${id}] initial FULL sent; len=${msg.length}; questionText="${qText(doc)}"`);
  } catch (e) {
    console.error(`[${ts()}] [ws->#${id}] initial send failed:`, e);
  }

  // periodic ping for visibility
  const pingId = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      const msg = JSON.stringify({ type: "ping", t: Date.now() });
      ws.send(msg, { binary: false });
    }
  }, 2000);

  ws.on("close", () => {
    clearInterval(pingId);
    log(`[ws] client#${id} DISCONNECTED (total: ${wss.clients.size})`);
  });

  ws.on("error", (e) => console.error(`[${ts()}] [ws] client#${id} error:`, e));

  // message handling
  ws.on("message", (data) => {
    // ---- DEBUG: prove the server received the frame ----
    const isBuf = Buffer.isBuffer(data);
    const text = isBuf ? data.toString("utf8") : String(data);
    const peek = (text || "").slice(0, 120).replace(/\n/g, "\\n");
    console.log(`[recv #${id}] len=${text.length}, isBuf=${isBuf}\n---\n${peek}\n---`);

    // optional immediate echo (client will log it as debug_echo)
    try {
      ws.send(JSON.stringify({ type: "debug_echo", bytes: text.length }), { binary: false });
    } catch (e) {
      console.error("[debug_echo] failed:", e);
    }

    // ---- normal handling below ----
    let msg;
    try { msg = JSON.parse(text); }
    catch (e) { console.error(`[recv #${id}] invalid JSON: ${e.message}`); return; }

    const { type, payload } = msg || {};

    // "hello" → send FULL now
    if (type === "hello") {
      try {
        const serial = Automerge.save(doc); // string
        const reply = JSON.stringify({ type: "full", payload: serial });
        ws.send(reply, { binary: false });
        log(`[hello->#${id}] FULL sent on hello; questionText="${qText(doc)}"`);
      } catch (e) {
        console.error(`[${ts()}] [hello->#${id}] failed:`, e);
      }
      return;
    }

    if (type !== "full") {
      console.log(`[ws #${id}] ignoring msg type:`, type);
      return;
    }

    // client sent FULL string → load & merge
    let incomingDoc;
    try {
      incomingDoc = Automerge.load(payload); // payload is the *string* from save()
    } catch (e) {
      console.error(`[recv #${id}] load(string) failed:`, e);
      return;
    }

    const before = qText(doc);
    const incomingVal = qText(incomingDoc);

    // merge into server doc
    doc = Automerge.merge(doc, incomingDoc);
    const after = qText(doc);
    console.log(`[merge #${id}] incoming="${incomingVal}" | before="${before}" -> after="${after}"`);

    // persist to disk
    persistJson();

    // Step 4 — persisted ACK to sender
    try {
      const ack = JSON.stringify({
        type: "persisted",
        payload: { at: new Date().toISOString(), questionText: qText(doc) }
      });
      ws.send(ack, { binary: false });
      console.log(`[ack->#${id}] persisted OK`);
    } catch (e) {
      console.error(`[${ts()}] [ack->#${id}] failed:`, e);
    }

    // Step 5 — broadcast FULL to all clients
    try {
      const serial = Automerge.save(doc); // string
      const outMsg = JSON.stringify({ type: "full", payload: serial });
      let sent = 0;
      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) { c.send(outMsg, { binary: false }); sent++; }
      });
      console.log(`[broadcast] sent to ${sent} clients; questionText="${qText(doc)}"`);
    } catch (e) {
      console.error(`[${ts()}] [broadcast] failed:`, e);
    }
  });
});

// ---------- start ----------
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
