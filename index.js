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

const LIKE_TARGET_BASE = 1000;
const LIKE_CHECK_INTERVAL_BASE_MS = 2 * 60 * 1000;
const LIKE_GROWTH_FACTOR = 2;
let nextLikeTarget = LIKE_TARGET_BASE;
let nextCheckIntervalMs = LIKE_CHECK_INTERVAL_BASE_MS;
let latestTotalLikeCount = 0;
let likeCheckTimer = null;

const advanceLikeTarget = () => {
  nextLikeTarget *= LIKE_GROWTH_FACTOR;
  nextCheckIntervalMs *= LIKE_GROWTH_FACTOR;
};

const handleLikeTargetHit = (source) => {
  if (latestTotalLikeCount >= nextLikeTarget) {
    logEvent("like-target-hit", {
      source,
      target: nextLikeTarget,
      totalLikes: latestTotalLikeCount,
    });
    sendVlcCommand();
    advanceLikeTarget();
    return true;
  }
  return false;
};

function runLikeCheck(source) {
  logEvent("like-check", {
    source,
    totalLikes: latestTotalLikeCount,
    target: nextLikeTarget,
    checkIntervalMs: nextCheckIntervalMs,
  });

  handleLikeTargetHit(source);
  scheduleLikeCheck();
}

const scheduleLikeCheck = () => {
  if (likeCheckTimer) {
    clearTimeout(likeCheckTimer);
  }
  likeCheckTimer = setTimeout(() => runLikeCheck("timer"), nextCheckIntervalMs);
};

const CONNECTION_RETRY_BASE_MS = 10 * 1000;
const MAX_CONNECTION_RETRY_MS = 5 * 60 * 1000;
let connectRetryAttempt = 0;
let connectRetryTimer = null;
let isConnecting = false;

const scheduleConnectionRetry = (reason) => {
  if (connectRetryTimer) {
    return;
  }
  connectRetryAttempt += 1;
  const delay = Math.min(CONNECTION_RETRY_BASE_MS * connectRetryAttempt, MAX_CONNECTION_RETRY_MS);
  logEvent("connection-retry", { attempt: connectRetryAttempt, delay, reason });
  connectRetryTimer = setTimeout(() => {
    connectRetryTimer = null;
    startConnection();
  }, delay);
};

const startConnection = () => {
  if (isConnecting) {
    return;
  }
  isConnecting = true;
  connection
    .connect()
    .then(() => {
      isConnecting = false;
      connectRetryAttempt = 0;
      if (connectRetryTimer) {
        clearTimeout(connectRetryTimer);
        connectRetryTimer = null;
      }
    })
    .catch((err) => {
      isConnecting = false;
      logEvent("connect-failed", err);
      scheduleConnectionRetry(err?.name ?? err?.message ?? "connect-failed");
    });
};

const logEvent = (label, data) => {
  console.log(`[${label}]`, data);
};

connection.on(ControlEvent.CONNECTED, (state) => {
  logEvent("connected", { roomId: state.roomId });
  connectRetryAttempt = 0;
  isConnecting = false;
  if (connectRetryTimer) {
    clearTimeout(connectRetryTimer);
    connectRetryTimer = null;
  }
});

connection.on(ControlEvent.DISCONNECTED, () => {
  logEvent("disconnected");
  scheduleConnectionRetry("disconnected");
});

connection.on(ControlEvent.ERROR, (error) => {
  logEvent("error", error);
  if (
    error?.exception?.name === "UserOfflineError" ||
    error?.name === "UserOfflineError" ||
    error?.message?.includes("isn't online")
  ) {
    scheduleConnectionRetry("user-offline");
  }
});

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

connection.on(WebcastEvent.LIKE, (likeMessage) => {
  const totalLikes = likeMessage.totalLikeCount ?? 0;
  latestTotalLikeCount = Math.max(latestTotalLikeCount, totalLikes);
  logEvent("like", {
    user: likeMessage.user?.uniqueId,
    likeCount: likeMessage.likeCount,
    totalLikes,
  });

  if (handleLikeTargetHit("likeEvent")) {
    scheduleLikeCheck();
  }
});

connection.on(WebcastEvent.FOLLOW, (followMessage) => {
  logEvent("follow", {
    user: followMessage.user?.uniqueId,
    displayText: followMessage.displayTextForAudience?.defaultPattern,
  });
  sendVlcCommand();
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

scheduleLikeCheck();
startConnection();
