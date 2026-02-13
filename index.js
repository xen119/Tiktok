require("dotenv").config();
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

  const cmd = `curl --user :${VLC_PASSWORD} "${commandUrl.toString()}"`;
  const child = execFile("cmd", ["/c", cmd], { timeout: VLC_TIMEOUT_MS }, (error, stdout, stderr) => {
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
  logEvent("gift", {
    user: gift.user.uniqueId,
    name: gift.giftName,
    quantity: gift.repeatCount,
    streakEnd: gift.repeatEnd === true,
  });

  if (gift.giftType === 1 && !gift.repeatEnd) {
    return;
  }

  sendVlcCommand();
});

connection.connect().catch((err) => {
  logEvent("connect-failed", err);
  process.exit(1);
});
