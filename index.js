require("dotenv").config({ override: true });
const { execFile } = require("node:child_process");
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require("tiktok-live-connector");

const username = process.env.TIKTOK_USERNAME;
const signApiKey = process.env.SIGN_API_KEY;

const VLC_URL = process.env.VLC_URL || "http://localhost:8080/requests/status.json";
const VLC_COMMAND = process.env.VLC_COMMAND || "pl_next";
const VLC_USERNAME = (process.env.VLC_USERNAME ?? "").trim();
const VLC_PASSWORD = (process.env.VLC_PASSWORD ?? "").trim();
const VLC_TIMEOUT_MS = Number.parseInt(process.env.VLC_TIMEOUT_MS || "5000", 10);

if (!username || !signApiKey) {
  console.error("Please set TIKTOK_USERNAME and SIGN_API_KEY in your environment.");
  process.exit(1);
}

let vlcStatusUrl;
try {
  vlcStatusUrl = new URL(VLC_URL);
} catch (err) {
  console.error("VLC_URL must be a valid absolute URL:", err.message);
  process.exit(1);
}

const connection = new TikTokLiveConnection(username, {
  signApiKey,
  enableExtendedGiftInfo: true,
});

const GIFT_SKIP_CACHE_MS = 5000;
const GIFT_SKIP_PRUNE_MS = 60000;
const processedGiftKeys = new Map();

const buildGiftKey = (gift) => {
  return (
    gift.logId ||
    gift.orderId ||
    gift.common?.msgId?.toString?.() ||
    gift.groupId ||
    `${gift.user?.uniqueId || gift.user?.userId || "anonymous"}:${gift.giftId}:${
      gift.repeatCount
    }:${gift.repeatEnd ?? false}`
  );
};

const cleanupGiftKeyCache = (now) => {
  for (const [key, timestamp] of processedGiftKeys) {
    if (now - timestamp > GIFT_SKIP_PRUNE_MS) {
      processedGiftKeys.delete(key);
    }
  }
};

const isDuplicateGiftSkip = (key) => {
  if (!key) {
    return false;
  }
  const now = Date.now();
  const existing = processedGiftKeys.get(key);
  const isDuplicate = existing && now - existing < GIFT_SKIP_CACHE_MS;
  if (isDuplicate) {
    processedGiftKeys.set(key, now);
  }
  return isDuplicate;
};

const markGiftSkipSent = (key) => {
  const now = Date.now();
  processedGiftKeys.set(key, now);
  cleanupGiftKeyCache(now);
};

const logEvent = (label, data) => {
  console.log(`[${label}]`, data);
};

connection.on(ControlEvent.CONNECTED, (state) => {
  logEvent("connected", { roomId: state.roomId });
});

connection.on(ControlEvent.DISCONNECTED, () => logEvent("disconnected"));
connection.on(ControlEvent.ERROR, (error) => logEvent("error", error));
connection.on(ControlEvent.STREAM_END, ({ action }) => {
  logEvent("streamEnd", { action });
});

connection.on(WebcastEvent.CHAT, (message) => {
  logEvent("chat", {
    user: message.user.uniqueId,
    text: message.comment,
  });

  if (
    typeof message.comment === "string" &&
    message.comment.trim().toLowerCase() === "/skip"
  ) {
    sendVlcCommand();
  }
});

const sendVlcCommand = () => {
  const commandUrl = new URL(vlcStatusUrl);
  commandUrl.searchParams.set("command", VLC_COMMAND);

  const args = [
    "--user",
    `:${VLC_PASSWORD}`,
    commandUrl.toString(),
  ];

  logEvent("vlc-command", {
    command: "curl",
    args: args,
    url: commandUrl.toString(),
  });

  const child = execFile("curl", args, { timeout: VLC_TIMEOUT_MS }, (error, stdout, stderr) => {
    if (error) {
      logEvent("vlc-error", { error: error.message, stderr: stderr?.toString() });
      return;
    }
    logEvent("vlc", { command: VLC_COMMAND, stdout: stdout?.toString() });
  });

  child.on("error", (err) => {
    logEvent("vlc-error", { error: err.message });
  });
};

connection.on(WebcastEvent.GIFT, (gift) => {
  const giftKey = buildGiftKey(gift);

  logEvent("gift", {
    user: gift.user.uniqueId,
    name: gift.giftName,
    quantity: gift.repeatCount,
    streakEnd: gift.repeatEnd === true,
    giftKey,
  });

  if (gift.giftType === 1 && !gift.repeatEnd) {
    return;
  }

  if (isDuplicateGiftSkip(giftKey)) {
    logEvent("gift", {
      user: gift.user.uniqueId,
      name: gift.giftName,
      duplicateSkip: true,
      giftKey,
    });
    return;
  }

  markGiftSkipSent(giftKey);
  sendVlcCommand();
});

connection.connect().catch((err) => {
  logEvent("connect-failed", err);
  process.exit(1);
});
