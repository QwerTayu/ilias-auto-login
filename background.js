// オン・オフの切り替え（ツールバーのアイコン）と、連続ログインの防止を受け持つ。
// ID・パスワードはここでは扱わない。

const COOLDOWN_MS = 60 * 1000;

async function isEnabled() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  return enabled;
}

async function updateBadge() {
  const enabled = await isEnabled();
  await chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: "#888888" });
  await chrome.action.setTitle({
    title: `ILIAS Auto Login: ${enabled ? "オン" : "オフ"}（クリックで切り替え）`,
  });
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);

chrome.action.onClicked.addListener(async () => {
  const enabled = await isEnabled();
  await chrome.storage.local.set({ enabled: !enabled });
  await updateBadge();
});

// content.js がボタンを押す直前に呼ぶ。オンで、直前の自動ログインから
// COOLDOWN_MS 以上たっていれば、今の時刻を記録して許可する。
// 判定と記録を service worker 1 か所で行うので、複数のタブが同時に来ても 1 つしか通らない。
let lastClaim = 0;

async function claim() {
  if (!(await isEnabled())) return { ok: false, reason: "disabled" };
  const { lastAutoLogin = 0 } = await chrome.storage.session.get("lastAutoLogin");
  const last = Math.max(lastAutoLogin, lastClaim);
  const now = Date.now();
  if (now - last < COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  lastClaim = now;
  await chrome.storage.session.set({ lastAutoLogin: now });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "isEnabled") {
    isEnabled().then((enabled) => sendResponse({ enabled }));
    return true;
  }
  if (message?.type === "claim") {
    claim().then(sendResponse);
    return true;
  }
  return false;
});
