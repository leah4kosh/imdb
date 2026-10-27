/* Echo - chat client */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const els = {
    sidebar: $("#sidebar"), scrim: $("#scrim"), chatList: $("#chatList"), search: $("#search"),
    newChat: $("#newChat"), newChatTop: $("#newChatTop"), openSidebar: $("#openSidebar"), closeSidebar: $("#closeSidebar"),
    logoHome: $("#logoHome"), status: $("#status"), chatTitle: $("#chatTitle"),
    thread: $("#thread"), welcome: $("#welcome"), messages: $("#messages"), suggestions: $("#suggestions"),
    composer: $("#composer"), input: $("#input"), send: $("#sendBtn"),
    attachBtn: $("#attachBtn"), fileInput: $("#fileInput"), attachments: $("#attachments"), dropzone: $("#dropzone"),
    menu: $("#chatMenu"), confirm: $("#confirmDialog"), confirmText: $("#confirmText"),
    lightbox: $("#lightbox"), lightboxDownload: $("#lightboxDownload"), lightboxClose: $("#lightboxClose"),
    toasts: $("#toasts"),
  };

  const ICONS = {
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
  };

  const state = {
    chats: [],
    currentId: null,
    messages: [],
    streaming: null, // AbortController while a reply is streaming
    pending: [], // attachments waiting to be sent: {data, media_type, preview}
    menuChatId: null,
  };

  /* ------------------------------------------------------------------ utils */
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  };

  function toast(text) {
    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = text;
    els.toasts.append(node);
    setTimeout(() => node.remove(), 2600);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return res.json();
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  /* ------------------------------------------------------------------ theme */
  function setTheme(name) {
    document.documentElement.dataset.theme = name;
    document.querySelectorAll("[data-set-theme]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.setTheme === name)));
    storage.set("echo-theme", name);
  }
  document.querySelectorAll("[data-set-theme]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.setTheme)));
  setTheme(storage.get("echo-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "pearl"));

  /* ------------------------------------------------------------------ markdown */
  if (window.marked) marked.setOptions({ gfm: true, breaks: true });

  function renderMarkdown(target, text) {
    if (!window.marked || !window.DOMPurify) {
      target.textContent = text;
      return;
    }
    target.innerHTML = DOMPurify.sanitize(marked.parse(text));
    target.querySelectorAll("p, li, h1, h2, h3, h4, blockquote, td, th").forEach((n) => n.setAttribute("dir", "auto"));
    target.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
    target.querySelectorAll("pre > code").forEach((code) => {
      const pre = code.parentElement;
      const lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || "";
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      wrap.innerHTML = `<div class="code-head"><span>${escapeHtml(lang || "code")}</span><button type="button">${"העתקה"}</button></div>`;
      pre.replaceWith(wrap);
      wrap.append(pre);
      wrap.querySelector("button").addEventListener("click", async (e) => {
        await copyText(code.textContent);
        e.target.textContent = "הועתק ✓";
        setTimeout(() => (e.target.textContent = "העתקה"), 1500);
      });
      if (window.hljs) {
        try { hljs.highlightElement(code); } catch { /* unknown language */ }
      }
    });
  }

  /* ------------------------------------------------------------------ sidebar */
  function dayGroup(ts) {
    const d = new Date(ts * 1000);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
    if (diff <= 0) return "היום";
    if (diff === 1) return "אתמול";
    if (diff < 7) return "השבוע";
    if (diff < 30) return "החודש";
    return "קודם";
  }

  function renderChatList() {
    const q = els.search.value.trim().toLowerCase();
    const chats = state.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
    els.chatList.innerHTML = "";
    if (!chats.length) {
      els.chatList.innerHTML = `<div class="empty-list">${q ? "לא נמצאו שיחות 🔍" : "עוד אין שיחות.<br>כתבו משהו כדי להתחיל ✨"}</div>`;
      return;
    }
    let lastGroup = null;
    for (const chat of chats) {
      const group = chat.pinned ? "📌 מוצמדות" : dayGroup(chat.updated);
      if (group !== lastGroup) {
        const label = document.createElement("div");
        label.className = "group-label";
        label.textContent = group;
        els.chatList.append(label);
        lastGroup = group;
      }
      const item = document.createElement("a");
      item.className = "chat-item" + (chat.id === state.currentId ? " active" : "");
      item.href = `#${chat.id}`;
      item.dataset.id = chat.id;
      item.innerHTML = `<span class="t" dir="auto"></span><button class="more" type="button" aria-label="אפשרויות" aria-haspopup="menu">${ICONS.more}</button>`;
      item.querySelector(".t").textContent = chat.title;
      item.querySelector(".more").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(chat.id, e.currentTarget);
      });
      els.chatList.append(item);
    }
  }

  async function loadChats() {
    state.chats = await api("/api/chats");
    renderChatList();
  }

  function upsertChat(chat) {
    const i = state.chats.findIndex((c) => c.id === chat.id);
    if (i >= 0) state.chats[i] = { ...state.chats[i], ...chat };
    else state.chats.unshift(chat);
    state.chats.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
    renderChatList();
  }

  function toggleSidebar(open) {
    els.sidebar.classList.toggle("open", open);
    els.scrim.classList.toggle("show", open);
  }
  els.openSidebar.addEventListener("click", () => toggleSidebar(true));
  els.closeSidebar.addEventListener("click", () => toggleSidebar(false));
  els.scrim.addEventListener("click", () => toggleSidebar(false));
  els.search.addEventListener("input", renderChatList);

  /* chat menu: rename / pin / delete */
  function openMenu(chatId, anchor) {
    const chat = state.chats.find((c) => c.id === chatId);
    state.menuChatId = chatId;
    els.menu.querySelector('[data-action="pin"] span').textContent = chat.pinned ? "ביטול הצמדה" : "הצמדה";
    els.menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = els.menu.offsetWidth;
    els.menu.style.top = `${Math.min(r.bottom + 4, innerHeight - els.menu.offsetHeight - 8)}px`;
    els.menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    anchor.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    els.menu.hidden = true;
    document.querySelectorAll('.more[aria-expanded="true"]').forEach((b) => b.removeAttribute("aria-expanded"));
  }
  document.addEventListener("click", (e) => { if (!els.menu.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeMenu(); closeLightbox(); toggleSidebar(false); }
  });

  els.menu.addEventListener("click", async (e) => {
    const action = e.target.closest("button")?.dataset.action;
    const chat = state.chats.find((c) => c.id === state.menuChatId);
    closeMenu();
    if (!action || !chat) return;
    if (action === "rename") startRename(chat);
    if (action === "pin") upsertChat(await api(`/api/chats/${chat.id}`, { method: "PATCH", body: { pinned: !chat.pinned } }));
    if (action === "delete") {
      els.confirmText.textContent = `"${chat.title}" תימחק לתמיד.`;
      els.confirm.returnValue = "";
      els.confirm.showModal();
      els.confirm.addEventListener("close", async function onClose() {
        els.confirm.removeEventListener("close", onClose);
        if (els.confirm.returnValue !== "ok") return;
        await api(`/api/chats/${chat.id}`, { method: "DELETE" });
        state.chats = state.chats.filter((c) => c.id !== chat.id);
        if (state.currentId === chat.id) goHome();
        else renderChatList();
        toast("השיחה נמחקה");
      });
    }
  });

  function startRename(chat) {
    const item = els.chatList.querySelector(`[data-id="${chat.id}"]`);
    if (!item) return;
    const label = item.querySelector(".t");
    const input = document.createElement("input");
    input.value = chat.title;
    input.dir = "auto";
    label.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener("click", (e) => e.preventDefault());
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title && title !== chat.title) {
        const updated = await api(`/api/chats/${chat.id}`, { method: "PATCH", body: { title } });
        upsertChat(updated);
        if (chat.id === state.currentId) els.chatTitle.textContent = updated.title;
      } else renderChatList();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  /* ------------------------------------------------------------------ thread rendering */
  function showWelcome(show) {
    els.welcome.classList.toggle("gone", !show);
  }

  function scrollToBottom(force = false) {
    const t = els.thread;
    const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 160;
    if (force || nearBottom) t.scrollTop = t.scrollHeight;
  }

  function userMessageEl(msg) {
    const node = document.createElement("div");
    node.className = "msg user";
    const body = document.createElement("div");
    body.className = "body";
    if (msg.attachments?.length) {
      const wrap = document.createElement("div");
      wrap.className = "user-attachments";
      for (const att of msg.attachments) {
        const img = document.createElement("img");
        img.src = att.url || att.preview;
        img.alt = "תמונה מצורפת";
        img.addEventListener("click", () => openLightbox(img.src));
        wrap.append(img);
      }
      body.append(wrap);
    }
    if (msg.text) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.dir = "auto";
      bubble.textContent = msg.text;
      body.append(bubble);
    }
    node.append(body);
    return node;
  }

  function imageEl(img) {
    const card = document.createElement("div");
    card.className = "gen-image";
    const name = `echo-${Date.now()}.${img.url.split(".").pop()}`;
    card.innerHTML = `<img alt="" loading="lazy"><div class="tools">
      <a href="${img.url}" download="${name}" aria-label="הורדה" title="הורדה">${ICONS.download}</a>
      <button type="button" aria-label="הגדלה" title="הגדלה">${ICONS.expand}</button></div>`;
    const el = card.querySelector("img");
    el.src = img.url;
    el.alt = img.caption || img.prompt || "תמונה";
    el.title = img.prompt || "";
    el.addEventListener("click", () => openLightbox(img.url));
    card.querySelector("button").addEventListener("click", () => openLightbox(img.url));
    return card;
  }

  function pendingImageEl(prompt) {
    const card = document.createElement("div");
    card.className = "gen-image pending";
    card.innerHTML = `<div class="painting"><div class="rings"><span></span><span></span><span></span></div><div>מצייר בשבילך…</div><small></small></div>`;
    card.querySelector("small").textContent = prompt;
    return card;
  }

  /**
   * Builds an assistant message node and returns helpers to update it.
   * The reply is a flow of text segments with images between them: images only ever
   * arrive at the end while streaming, so new text always goes to the last segment.
   */
  function assistantView(msg = { text: "", images: [] }) {
    const node = document.createElement("div");
    node.className = "msg assistant";
    node.innerHTML = `<div class="avatar" aria-hidden="true"></div><div class="body"><div class="flow"></div><div class="actions"></div></div>`;
    const flow = node.querySelector(".flow");
    const actions = node.querySelector(".actions");
    let text = msg.text || "";
    let segStart = 0; // where the last text segment begins in `text`
    let segment = null;
    let frame = 0;

    const newSegment = () => {
      segment = document.createElement("div");
      segment.className = "content";
      flow.append(segment);
      segStart = text.length;
    };

    const view = {
      node,
      get text() { return text; },
      render(streaming = false) {
        const part = text.slice(segStart);
        const onlySegment = flow.children.length === 1;
        if (part.trim()) renderMarkdown(segment, part);
        else segment.innerHTML = streaming && onlySegment ? '<div class="typing"><span></span><span></span><span></span></div>' : "";
        flow.querySelectorAll(".caret").forEach((n) => n.classList.remove("caret"));
        const last = segment.lastElementChild;
        if (streaming && part.trim() && last && !last.classList.contains("code-block")) last.classList.add("caret");
      },
      append(delta) {
        text += delta;
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; view.render(true); scrollToBottom(); });
      },
      addPending(prompt) {
        view.render(false);
        const card = pendingImageEl(prompt);
        flow.append(card);
        scrollToBottom();
        return card;
      },
      addImage(img, pendingCard) {
        const card = imageEl(img);
        if (pendingCard) pendingCard.replaceWith(card);
        else flow.append(card);
        newSegment();
        scrollToBottom();
      },
      failPending(card) {
        card.className = "gen-image failed";
        card.innerHTML = "<div>😕 לא הצלחתי ליצור את התמונה</div>";
        if (card === flow.lastElementChild) newSegment();
      },
      setStreaming(on) {
        node.classList.toggle("streaming", on);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        view.render(on);
      },
      setActions(isLast) {
        actions.innerHTML = "";
        if (text) {
          const copy = document.createElement("button");
          copy.type = "button";
          copy.innerHTML = `${ICONS.copy}<span>העתקה</span>`;
          copy.addEventListener("click", async () => {
            await copyText(text);
            copy.innerHTML = `${ICONS.check}<span>הועתק</span>`;
            setTimeout(() => (copy.innerHTML = `${ICONS.copy}<span>העתקה</span>`), 1500);
          });
          actions.append(copy);
        }
        if (isLast) {
          const redo = document.createElement("button");
          redo.type = "button";
          redo.innerHTML = `${ICONS.redo}<span>תשובה אחרת</span>`;
          redo.addEventListener("click", regenerate);
          actions.append(redo);
        }
      },
      error(message) {
        const note = document.createElement("div");
        note.className = "error-note";
        note.textContent = `⚠️ ${message}`;
        flow.append(note);
      },
    };
    // Rebuild saved replies: text up to each image's position, the image, then the rest.
    const full = text;
    const saved = [...(msg.images || [])].sort((a, b) => (a.at ?? full.length) - (b.at ?? full.length));
    text = "";
    newSegment();
    for (const img of saved) {
      text = full.slice(0, img.at ?? full.length);
      view.render(false);
      view.addImage(img);
    }
    text = full;
    view.render(false);
    return view;
  }

  function renderThread() {
    els.messages.innerHTML = "";
    showWelcome(state.messages.length === 0);
    const lastAssistant = state.messages.map((m) => m.role).lastIndexOf("assistant");
    state.messages.forEach((msg, i) => {
      if (msg.role === "user") els.messages.append(userMessageEl(msg));
      else {
        const view = assistantView(msg);
        view.setActions(i === lastAssistant && i === state.messages.length - 1);
        els.messages.append(view.node);
      }
    });
    requestAnimationFrame(() => scrollToBottom(true));
  }

  /* ------------------------------------------------------------------ navigation */
  function goHome() {
    stopStreaming();
    state.currentId = null;
    state.messages = [];
    els.chatTitle.textContent = "";
    if (location.hash) history.pushState(null, "", location.pathname);
    renderThread();
    renderChatList();
    toggleSidebar(false);
    els.input.focus();
  }

  async function openChat(id) {
    if (state.currentId === id && state.messages.length) return;
    stopStreaming();
    try {
      const chat = await api(`/api/chats/${id}`);
      state.currentId = id;
      state.messages = chat.messages;
      els.chatTitle.textContent = chat.title;
      renderThread();
      renderChatList();
    } catch {
      toast("השיחה לא נמצאה");
      goHome();
    }
    toggleSidebar(false);
  }

  function route() {
    const id = location.hash.slice(1);
    if (id) openChat(id);
    else goHome();
  }
  window.addEventListener("hashchange", route);
  els.newChat.addEventListener("click", goHome);
  els.newChatTop.addEventListener("click", goHome);
  els.logoHome.addEventListener("click", (e) => { e.preventDefault(); goHome(); });

  /* ------------------------------------------------------------------ streaming */
  async function readEvents(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (line) onEvent(JSON.parse(line.slice(6)));
      }
    }
  }

  function setBusy(busy) {
    els.send.classList.toggle("stop", busy);
    els.send.setAttribute("aria-label", busy ? "עצירה" : "שליחה");
    updateSendState();
  }

  function stopStreaming() {
    if (state.streaming) {
      state.streaming.abort();
      state.streaming = null;
      setBusy(false);
    }
  }

  async function streamInto(url, body) {
    const controller = new AbortController();
    state.streaming = controller;
    setBusy(true);
    document.querySelectorAll(".msg.assistant .actions").forEach((a) => (a.innerHTML = ""));

    const view = assistantView();
    view.setStreaming(true);
    els.messages.append(view.node);
    scrollToBottom(true);
    let pendingCard = null;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      await readEvents(res, (ev) => {
        switch (ev.type) {
          case "user_saved": state.messages.push(ev.message); break;
          case "title":
            els.chatTitle.textContent = ev.title;
            upsertChat({ id: state.currentId, title: ev.title });
            break;
          case "delta": view.append(ev.text); break;
          case "image_pending": pendingCard = view.addPending(ev.prompt); break;
          case "image": view.addImage(ev, pendingCard); pendingCard = null; break;
          case "image_failed": if (pendingCard) view.failPending(pendingCard); pendingCard = null; break;
          case "error": view.error(ev.message); break;
        }
      });
    } catch (err) {
      if (err.name !== "AbortError") view.error(err.message === "Failed to fetch" ? "אין חיבור לשרת" : err.message);
    } finally {
      if (pendingCard) view.failPending(pendingCard);
      view.setStreaming(false);
      if (state.streaming === controller) state.streaming = null;
      setBusy(false);
      // Reload the saved messages so the thread mirrors what the server stored (also after "stop").
      if (state.currentId) {
        const chatId = state.currentId;
        const chat = await api(`/api/chats/${chatId}`).catch(() => null);
        if (chat && state.currentId === chatId) {
          state.messages = chat.messages;
          upsertChat({ id: chat.id, title: chat.title, pinned: chat.pinned, updated: chat.updated });
          view.setActions(true);
        }
      }
    }
  }

  async function sendMessage(text) {
    text = text.trim();
    if ((!text && !state.pending.length) || state.streaming) return;
    const attachments = state.pending.map(({ data, media_type, preview }) => ({ data, media_type, preview }));
    state.pending = [];
    renderAttachments();
    els.input.value = "";
    autosize();

    if (!state.currentId) {
      try {
        const chat = await api("/api/chats", { method: "POST", body: {} });
        state.currentId = chat.id;
        state.messages = [];
        upsertChat(chat);
        history.pushState(null, "", `#${chat.id}`);
      } catch {
        toast("לא הצלחתי לפתוח שיחה חדשה");
        return;
      }
    }
    showWelcome(false);
    els.messages.append(userMessageEl({ text, attachments }));
    await streamInto(`/api/chats/${state.currentId}/messages`, {
      text,
      attachments: attachments.map(({ data, media_type }) => ({ data, media_type })),
    });
  }

  async function regenerate() {
    if (state.streaming || !state.currentId) return;
    // The server replaces the last reply (also a stopped one it saved a moment ago).
    if (state.messages.at(-1)?.role === "assistant") state.messages.pop();
    if (els.messages.lastElementChild?.classList.contains("assistant")) els.messages.lastElementChild.remove();
    await streamInto(`/api/chats/${state.currentId}/regenerate`);
  }

  /* ------------------------------------------------------------------ composer */
  function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
    updateSendState();
  }
  function updateSendState() {
    els.send.disabled = !state.streaming && !els.input.value.trim() && !state.pending.length;
  }
  els.input.addEventListener("input", autosize);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      sendMessage(els.input.value);
    }
  });
  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.streaming) stopStreaming();
    else sendMessage(els.input.value);
  });
  els.suggestions.addEventListener("click", (e) => {
    const btn = e.target.closest(".suggestion");
    if (btn) sendMessage(btn.dataset.prompt);
  });

  /* attachments: resize in the browser so uploads stay small */
  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith("image/")) return reject(new Error("not an image"));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1568;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        const keepPng = file.type === "image/png";
        const dataUrl = canvas.toDataURL(keepPng ? "image/png" : "image/jpeg", 0.9);
        URL.revokeObjectURL(url);
        resolve({ data: dataUrl.split(",")[1], media_type: keepPng ? "image/png" : "image/jpeg", preview: dataUrl });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }

  async function addFiles(files) {
    for (const file of files) {
      if (state.pending.length >= 4) { toast("אפשר לצרף עד 4 תמונות"); break; }
      try { state.pending.push(await readImage(file)); }
      catch { toast("אפשר לצרף רק תמונות"); }
    }
    renderAttachments();
  }

  function renderAttachments() {
    els.attachments.innerHTML = "";
    state.pending.forEach((att, i) => {
      const node = document.createElement("div");
      node.className = "att";
      node.innerHTML = `<img alt=""><button type="button" aria-label="הסרה">✕</button>`;
      node.querySelector("img").src = att.preview;
      node.querySelector("button").addEventListener("click", () => { state.pending.splice(i, 1); renderAttachments(); });
      els.attachments.append(node);
    });
    updateSendState();
  }

  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => { addFiles([...els.fileInput.files]); els.fileInput.value = ""; });
  els.input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; els.dropzone.classList.add("show"); } });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els.dropzone.classList.remove("show"); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove("show");
    addFiles([...(e.dataTransfer?.files || [])]);
  });

  /* ------------------------------------------------------------------ lightbox */
  function openLightbox(src) {
    els.lightbox.querySelector("img").src = src;
    els.lightboxDownload.href = src;
    els.lightboxDownload.download = `echo-${Date.now()}.${src.split(".").pop().split(";")[0].slice(0, 4)}`;
    els.lightbox.hidden = false;
  }
  function closeLightbox() { els.lightbox.hidden = true; }
  els.lightboxClose.addEventListener("click", closeLightbox);
  els.lightbox.addEventListener("click", (e) => { if (e.target === els.lightbox) closeLightbox(); });

  /* ------------------------------------------------------------------ boot */
  async function loadStatus() {
    try {
      const s = await api("/api/status");
      els.status.classList.add(s.claude ? "live" : "demo");
      els.status.querySelector(".label").textContent = s.claude ? "מחובר" : "מצב דמו";
      els.status.title = s.claude
        ? `מודל: ${s.model}${s.images ? " · יצירת תמונות פעילה" : " · תמונות במצב דמו"}`
        : "הוסיפו ANTHROPIC_API_KEY לקובץ .env כדי לקבל תשובות אמיתיות";
    } catch {
      els.status.querySelector(".label").textContent = "אין חיבור";
    }
  }

  loadStatus();
  loadChats().catch(() => toast("לא הצלחתי לטעון את השיחות"));
  route();
  autosize();
})();
