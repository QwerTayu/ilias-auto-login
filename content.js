// ILIAS のログイン画面で、LDAP 認証を選び、パスワードマネージャが ID・パスワードを
// 入れたらログインボタンを押す。ID・パスワードの値は読まない・残さない（入っているかだけ見る）。

(() => {
  const LOG = "[ILIAS Auto Login]";
  const WAIT_MS = 15 * 1000; // 欄が埋まるのを待つ最大時間
  const SETTLE_MS = 300; // 2 つとも埋まってから押すまでの間（入力の途中で押さないため）

  const SELECTORS = {
    form: 'form[name="login_form"]',
    ldap: 'input[type="radio"][value="2_1"]',
    user: 'input[name="login_form/input_4/input_6"]',
    password: 'input[type="password"]',
    error: ".alert-danger",
  };

  const log = (...args) => console.info(LOG, ...args);

  function waitForElement(selector, timeoutMs) {
    const found = document.querySelector(selector);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) finish(el);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      function finish(el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // タブが表示されるまで待つ。裏のタブで勝手にログインし直さないため。
  function waitUntilVisible() {
    if (document.visibilityState === "visible") return Promise.resolve();
    log("タブが表示されるのを待ちます");
    return new Promise((resolve) => {
      document.addEventListener("visibilitychange", function onChange() {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", onChange);
        resolve();
      });
    });
  }

  function matchesSafe(el, selector) {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  // ブラウザ標準の自動入力は、ユーザーがページに触れるまで value が空に見えるので、
  // :autofill / :-webkit-autofill でも「入っている」と判定する。
  function isFilled(el) {
    return el.value !== "" || matchesSafe(el, ":autofill") || matchesSafe(el, ":-webkit-autofill");
  }

  // 手で打っている途中で押さないよう、文字を打つキー入力（isTrusted）があったら "typed" で終える。
  // パスワードマネージャの入力や、自動入力の候補を選ぶ操作では "typed" にならない。
  // Chrome の自動入力も isTrusted な keydown を送るが、key を持たない（KeyboardEvent ではない）ので除く。
  function isTypingKey(event) {
    const { key } = event;
    if (!event.isTrusted || typeof key !== "string") return false;
    return key.length === 1 || key === "Backspace" || key === "Delete";
  }

  // 欄が埋まれば "filled"、手で打たれたら "typed"、時間切れなら "timeout" を返す。
  function waitUntilFilled(fields, timeoutMs) {
    return new Promise((resolve) => {
      let settleTimer = null;
      // ポーリングでは、埋まっている間はタイマーをそのまま進める。欄の値が変わったら（input / change）、
      // 入力の途中かもしれないので、そこから測り直す。
      const check = (restart) => {
        if (!fields.every(isFilled)) {
          clearTimeout(settleTimer);
          settleTimer = null;
          return;
        }
        if (settleTimer !== null && !restart) return;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (fields.every(isFilled)) finish("filled");
        }, SETTLE_MS);
      };
      const onFieldEvent = () => check(true);
      const onKeydown = (event) => {
        if (isTypingKey(event)) finish("typed");
      };
      const poll = setInterval(() => check(false), 250);
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      const events = ["input", "change"];
      for (const field of fields) for (const type of events) field.addEventListener(type, onFieldEvent);
      for (const field of fields) field.addEventListener("keydown", onKeydown);
      function finish(state) {
        clearInterval(poll);
        clearTimeout(timer);
        clearTimeout(settleTimer);
        for (const field of fields) for (const type of events) field.removeEventListener(type, onFieldEvent);
        for (const field of fields) field.removeEventListener("keydown", onKeydown);
        resolve(state);
      }
      check(false);
    });
  }

  // フォームの欄に触れるか、値が入る（自動入力の候補を選んだときなど）まで待つ。
  function waitForInteraction(form) {
    const events = ["focusin", "input", "change"];
    return new Promise((resolve) => {
      const onEvent = () => {
        for (const type of events) form.removeEventListener(type, onEvent, true);
        resolve();
      };
      for (const type of events) form.addEventListener(type, onEvent, true);
    });
  }

  function findLoginButton(form) {
    return [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "ログイン") ?? null;
  }

  async function main() {
    const form = await waitForElement(SELECTORS.form, WAIT_MS);
    if (!form) return; // ログイン画面ではない

    const { enabled } = await chrome.runtime.sendMessage({ type: "isEnabled" });
    if (!enabled) {
      log("オフなので何もしません");
      return;
    }

    await waitUntilVisible();

    const ldap = form.querySelector(SELECTORS.ldap);
    if (ldap && !ldap.checked) {
      ldap.click();
      log("LDAP 認証を選びました");
    }

    if (document.querySelector(SELECTORS.error)) {
      log("エラーメッセージが出ているので、自動では押しません");
      return;
    }

    const user = form.querySelector(SELECTORS.user);
    const password = form.querySelector(SELECTORS.password);
    const button = findLoginButton(form);
    if (!user || !password || !button) {
      log("ログイン画面の欄やボタンが見つかりません");
      return;
    }

    log("ID とパスワードが入るのを待ちます");
    // 時間切れのあとも、欄に触れるか値が入ったら（自動入力の候補を選んだときなど）、そこからまた待つ。
    let state = await waitUntilFilled([user, password], WAIT_MS);
    while (state === "timeout") {
      log("時間内に入らなかったので待つのをやめます。欄に触れると、また待ちます");
      await waitForInteraction(form);
      log("ID とパスワードが入るのを待ちます");
      state = await waitUntilFilled([user, password], WAIT_MS);
    }
    if (state === "typed") {
      log("手で入力しているので、自動では押しません");
      return;
    }

    const result = await chrome.runtime.sendMessage({ type: "claim" });
    if (!result?.ok) {
      log(result?.reason === "cooldown" ? "直前に自動ログインしたばかりなので押しません" : "押しません", result?.reason);
      return;
    }

    log("ログインボタンを押します");
    button.click();
  }

  main().catch((e) => console.warn(LOG, e));
})();
