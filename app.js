/* ==========================================================
   Bookshelf — app.js
   Reads books.json, renders a swipeable 3D deck of covers,
   tints the room to the active book, opens books/<file> in a new tab.
   ========================================================== */
(() => {
  "use strict";

  const MANIFEST = "books.json";
  const BOOKS_DIR = "books/";
  const VISIBLE_RANGE = 3;
  const FALLBACK_COLORS = ["#3D4A5C", "#5B3A3A", "#2F4A43", "#6B5A3A", "#43395A", "#6E4636", "#2E3F4F"];
  const FILE_PATTERN = /^[^/\\?#]+\.html?$/i;

  // Optional embedded data, used only by the standalone preview page.
  // On a normal deployment this is undefined and books.json is fetched.
  const PREVIEW = window.BOOKSHELF_PREVIEW || null;

  const $ = (id) => document.getElementById(id);
  const els = {
    state: $("state"), stateTitle: $("state-title"), stateText: $("state-text"), stateRetry: $("state-retry"),
    shelf: $("shelf"), deck: $("deck"), controls: $("controls"),
    open: $("open"), openLabel: $("open-label"),
    prev: $("prev"), next: $("next"), position: $("position"),
    count: $("count"), refresh: $("refresh"),
    notice: $("notice"), noticeText: $("notice-text"), noticeClose: $("notice-close"),
  };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  let books = [];
  let cards = [];
  let index = 0;          // the book the deck is heading to (or resting on)
  let loading = false;

  /* ---------------- Loading ---------------- */

  class LoadError extends Error {
    constructor(title, detail) { super(title); this.title = title; this.detail = detail; }
  }

  async function load() {
    if (loading) return;
    loading = true;
    const keepFile = books[index] && books[index].file;
    els.refresh.classList.add("is-spinning");
    els.refresh.disabled = true;
    if (!books.length) showState("loading");

    try {
      const data = PREVIEW ? structuredClone(PREVIEW) : await readManifest();
      const list = Array.isArray(data) ? data : data && data.books;
      if (!Array.isArray(list)) {
        throw new LoadError("books.json has no book list", "Wrap your entries in an object like { \"books\": [ … ] }.");
      }

      const { valid, problems } = validate(list);
      books = valid;
      reportProblems(problems);
      els.count.textContent = books.length ? `${books.length} ${books.length === 1 ? "book" : "books"}` : "";

      if (!books.length) {
        showState("empty", problems.length);
        return;
      }

      const kept = keepFile ? books.findIndex((b) => b.file === keepFile) : -1;
      index = kept >= 0 ? kept : Math.min(index, books.length - 1);
      render();
      motion.pos = motion.target = index;
      motion.vel = 0;
      requestFrame();
      if (!PREVIEW) checkFiles();
    } catch (err) {
      books = [];
      els.count.textContent = "";
      showState("error", err);
      if (!(err instanceof LoadError)) console.error(err);
    } finally {
      loading = false;
      els.refresh.classList.remove("is-spinning");
      els.refresh.disabled = false;
    }
  }

  async function readManifest() {
    if (location.protocol === "file:") {
      throw new LoadError(
        "This page is opened straight from disk",
        "Browsers block reading books.json from file:// pages. Serve the folder over HTTP (for example with “npx serve”) or deploy it to Netlify."
      );
    }

    let res;
    try {
      res = await fetch(MANIFEST, { cache: "no-store" });
    } catch {
      throw new LoadError("Can’t reach books.json", "Check your connection, then try again.");
    }
    if (!res.ok) {
      throw new LoadError(
        res.status === 404 ? "books.json is missing" : "Can’t read books.json",
        res.status === 404
          ? "Add a books.json file next to index.html and redeploy."
          : `The server answered with status ${res.status}.`
      );
    }

    try {
      return JSON.parse(await res.text());
    } catch (err) {
      throw new LoadError("books.json isn’t valid JSON", `${err.message}. Check for a missing comma or quote.`);
    }
  }

  /* ---------------- Validation ---------------- */

  function validate(list) {
    const valid = [];
    const problems = [];

    list.forEach((entry, i) => {
      const where = `Entry ${i + 1}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        problems.push(`${where} isn’t an object`);
        return;
      }
      const title = str(entry.title);
      const file = str(entry.file);
      const label = title ? `${where} (“${title}”)` : where;

      if (!title) { problems.push(`${label} has no title`); return; }
      if (!file) { problems.push(`${label} has no file`); return; }
      if (!FILE_PATTERN.test(file) || file.startsWith(".")) {
        problems.push(`${label} has an invalid file name “${file}”; use a plain .html name inside books/`);
        return;
      }

      const rawColor = str(entry.coverColor);
      const colorOk = rawColor && CSS.supports("color", rawColor);
      if (rawColor && !colorOk) console.warn(`[bookshelf] ${label}: coverColor “${rawColor}” isn’t a valid color; using a fallback.`);
      const color = colorOk ? rawColor : fallbackColor(title);

      valid.push({
        title,
        file,
        color,
        ink: inkFor(color),
        status: "unknown",
      });
    });

    return { valid, problems };
  }

  function str(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function fallbackColor(seed) {
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  }

  function reportProblems(problems) {
    if (!problems.length) { hideNotice(); return; }
    problems.forEach((p) => console.warn(`[bookshelf] Skipped: ${p}.`));
    const n = problems.length;
    showNotice(`Skipped ${n} ${n === 1 ? "entry" : "entries"} in books.json: ${problems.join("; ")}.`);
  }

  /* ---------------- Missing-file check ---------------- */

  async function checkFiles() {
    const snapshot = books;
    await Promise.all(snapshot.map(async (book) => {
      try {
        const res = await fetch(bookUrl(book), { method: "HEAD", cache: "no-store" });
        book.status = res.status === 404 || res.status === 410 ? "missing" : "ok";
      } catch {
        book.status = "unknown";
      }
    }));
    if (snapshot !== books) return;

    books.forEach((b, i) => {
      const card = cards[i];
      if (!card) return;
      const missing = b.status === "missing";
      card.classList.toggle("is-missing", missing);
      if (missing) {
        console.warn(`[bookshelf] ${BOOKS_DIR}${b.file} wasn’t found for “${b.title}”.`);
        if (!card.querySelector(".cover-missing")) {
          const tag = el("span", "cover-missing", "File not found");
          card.append(tag);
        }
      }
    });
    update();
  }

  function bookUrl(book) {
    return BOOKS_DIR + encodeURIComponent(book.file);
  }

  /* ---------------- Rendering ---------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function render() {
    els.deck.replaceChildren();
    cards = books.map((book, i) => {
      const card = document.createElement("a");
      card.className = "cover";
      card.href = bookUrl(book);
      card.target = "_blank";
      card.rel = "noopener";
      card.draggable = false;
      card.dataset.index = String(i);
      card.style.setProperty("--cover-color", book.color);
      card.style.setProperty("--cover-ink", book.ink);
      card.style.setProperty("--title-size", titleSize(book.title));

      const body = el("span", "cover-body");
      body.append(el("span", "cover-title", book.title), el("span", "cover-rule"));

      const shadow = el("span", "cover-shadow");
      const shade = el("span", "cover-shade");
      const glare = el("span", "cover-glare");

      card.append(shadow, el("span", "cover-face"), el("span", "cover-frame"), body);
      card.append(glare, shade);

      // cached handles + last-written values so each frame only touches what changed
      card._parts = { shadow, shade, glare };
      card._last = { t: "", o: -1, sh: -1, sd: -1, z: -1, vis: null };

      els.deck.append(card);
      return card;
    });

    els.state.hidden = true;
    els.shelf.hidden = false;
    els.controls.hidden = false;
    measure();
    update();
  }

  /* ==========================================================
     Motion engine
     One spring-driven position (fractional book index) feeds every
     card's transform each frame. Dragging writes the position
     directly; releasing hands it to the spring with the finger's
     velocity, so nothing ever jumps or restarts.
     ========================================================== */

  const SPRING = { stiffness: 170, damping: 24 };   // softer settle for longer, smoother swipes
  const motion = {
    pos: 0, target: 0, vel: 0,
    tiltX: 0, tiltY: 0, tiltTX: 0, tiltTY: 0, glareX: 30, glareY: 20,
    raf: 0, last: 0,
  };
  let spreadPx = 1;     // px the finger travels to move one book
  let spreadPct = 34;   // how far (in % of cover width) a neighbour sits from centre

  function measure() {
    const pct = parseFloat(getComputedStyle(els.deck).getPropertyValue("--spread")) || 34;
    spreadPct = pct;
    spreadPx = Math.max(1, els.deck.offsetWidth * pct / 100);
  }

  function requestFrame() {
    if (!motion.raf) {
      motion.last = performance.now();
      motion.raf = requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    motion.raf = 0;
    const dt = Math.min(0.032, (now - motion.last) / 1000);   // clamp after tab switches
    motion.last = now;
    const reduce = reducedMotion.matches;

    // Position spring (skipped while a finger is holding the deck)
    if (!drag.active) {
      if (reduce) {
        motion.pos = motion.target;
        motion.vel = 0;
      } else {
        // semi-implicit Euler, sub-stepped for stability on 120 Hz and slow frames alike
        const steps = Math.ceil(dt / 0.008);
        const h = dt / steps;
        for (let k = 0; k < steps; k++) {
          const force = -SPRING.stiffness * (motion.pos - motion.target) - SPRING.damping * motion.vel;
          motion.vel += force * h;
          motion.pos += motion.vel * h;
        }
        if (Math.abs(motion.pos - motion.target) < 0.0005 && Math.abs(motion.vel) < 0.002) {
          motion.pos = motion.target;
          motion.vel = 0;
        }
      }
    }

    // Tilt eases towards the pointer (frame-rate independent)
    const ease = reduce ? 1 : 1 - Math.exp(-dt * 14);
    motion.tiltX += (motion.tiltTX - motion.tiltX) * ease;
    motion.tiltY += (motion.tiltTY - motion.tiltY) * ease;

    layout();

    const moving =
      drag.active ||
      motion.pos !== motion.target ||
      Math.abs(motion.tiltX - motion.tiltTX) > 0.01 ||
      Math.abs(motion.tiltY - motion.tiltTY) > 0.01;
    if (moving) requestFrame();
  }

  function layout() {
    const reduce = reducedMotion.matches;
    const pos = motion.pos;
    const nearest = Math.round(pos);

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const last = card._last;
      const d = i - pos;               // signed distance from centre, fractional
      const a = Math.abs(d);
      const s = Math.sign(d);

      const visible = a < VISIBLE_RANGE + 0.5;
      if (visible !== last.vis) {
        card.style.visibility = visible ? "" : "hidden";
        last.vis = visible;
      }
      if (!visible) continue;

      // Smooth, continuous curves — no breakpoints for the eye to catch
      const near = Math.min(a, 1);
      const far = Math.max(0, a - 1);
      const x = s * (near + far * 0.5) * spreadPct;
      const z = -Math.min(a, VISIBLE_RANGE) * 72;
      const ry = reduce ? 0 : -s * smooth(near) * 22;

      let t = `translate3d(${x.toFixed(3)}%,0,${z.toFixed(2)}px) rotateY(${ry.toFixed(3)}deg)`;
      if (i === nearest && (motion.tiltX || motion.tiltY)) {
        const k = 1 - Math.min(1, a * 2);          // tilt fades out as the card leaves centre
        t += ` rotateX(${(motion.tiltX * k).toFixed(3)}deg) rotateY(${(motion.tiltY * k).toFixed(3)}deg)`;
      }
      if (t !== last.t) { card.style.transform = t; last.t = t; }

      const o = round3(a <= VISIBLE_RANGE - 0.6 ? 1 : Math.max(0, 1 - (a - (VISIBLE_RANGE - 0.6)) / 1.1));
      if (o !== last.o) { card.style.opacity = o; last.o = o; }

      const z2 = 1000 - Math.round(a * 100);
      if (z2 !== last.z) { card.style.zIndex = z2; last.z = z2; }

      // Depth cues on cheap, opacity-only layers
      const sd = round3(Math.min(0.42, smooth(near) * 0.3 + far * 0.06));
      if (sd !== last.sd) { card._parts.shade.style.opacity = sd; last.sd = sd; }
      const sh = round3(1 - smooth(near));
      if (sh !== last.sh) {
        card._parts.shadow.style.opacity = sh;
        card._parts.glare.style.opacity = sh;
        last.sh = sh;
      }
    }

    const glareCard = cards[nearest];
    if (glareCard) {
      glareCard.style.setProperty("--glare-x", `${motion.glareX}%`);
      glareCard.style.setProperty("--glare-y", `${motion.glareY}%`);
    }

    // While dragging, the details and pager follow whichever book is closest
    if (drag.active) {
      const clamped = clampIndex(nearest);
      if (clamped !== index) { index = clamped; update(); }
    }
  }

  function smooth(t) { return t * t * (3 - 2 * t); }      // smoothstep
  function round3(n) { return Math.round(n * 1000) / 1000; }
  function clampIndex(i) { return Math.max(0, Math.min(books.length - 1, i)); }

  /* Everything that isn't per-frame: focus, labels, pager, colour */
  function update() {
    cards.forEach((card, i) => {
      const active = i === index;
      card.classList.toggle("is-active", active);
      card.tabIndex = active ? 0 : -1;
      card.setAttribute("aria-hidden", active ? "false" : "true");
      if (active) {
        const book = books[i];
        card.setAttribute("aria-label", book.status === "missing"
          ? `${book.title}. File not found.`
          : `Open ${book.title} in a new tab`);
      } else {
        card.removeAttribute("aria-label");
      }
    });

    const book = books[index];
    if (!book) return;

    setAmbient(book);

    els.position.textContent = `${index + 1} of ${books.length}`;
    els.prev.disabled = index === 0;
    els.next.disabled = index === books.length - 1;

    const missing = book.status === "missing";
    els.open.href = missing ? "#" : bookUrl(book);
    els.open.setAttribute("aria-disabled", String(missing));
    els.openLabel.textContent = missing ? "File not found" : "Open book";
  }

  /* Two glow layers cross-fade (opacity only), instead of repainting one gradient per frame */
  const ambientLayers = Array.from(document.querySelectorAll(".ambient-layer"));
  let ambientFront = 0;
  let ambientColor = "";
  function setAmbient(book) {
    document.body.style.setProperty("--ambient", book.color);
    document.body.style.setProperty("--ambient-ink", book.ink);
    if (book.color === ambientColor || ambientLayers.length < 2) return;
    ambientColor = book.color;
    const next = ambientLayers[1 - ambientFront];
    next.style.setProperty("--glow", book.color);
    next.classList.add("is-on");
    ambientLayers[ambientFront].classList.remove("is-on");
    ambientFront = 1 - ambientFront;
  }

  function goTo(i, velocity = 0) {
    const clamped = clampIndex(i);
    motion.target = clamped;
    if (velocity) motion.vel = velocity;
    requestFrame();
    if (clamped !== index) { index = clamped; update(); }
  }

  /* Light foil on dark covers, dark ink on light ones */
  function inkFor(color) {
    const probe = document.createElement("span");
    probe.style.color = color;
    probe.style.display = "none";
    document.body.append(probe);
    const rgb = (getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3);
    probe.remove();
    const [r, g, b] = rgb.map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? "#1F1B15" : "#EDE3C6";
  }

  function titleSize(title) {
    const len = title.length;
    if (len <= 12) return "13cqi";
    if (len <= 24) return "11cqi";
    if (len <= 40) return "9cqi";
    return "7.5cqi";
  }

  /* ---------------- States & notices ---------------- */

  function showState(kind, detail) {
    els.shelf.hidden = true;
    els.controls.hidden = true;
    els.state.hidden = false;
    els.state.classList.toggle("is-loading", kind === "loading");
    els.stateRetry.hidden = kind === "loading";
    els.stateRetry.textContent = kind === "empty" ? "Reload books" : "Try again";

    if (kind === "loading") {
      els.stateTitle.textContent = "Loading books…";
      els.stateText.textContent = "";
    } else if (kind === "empty") {
      els.stateTitle.textContent = "The shelf is empty";
      els.stateText.textContent = detail
        ? "Every entry in books.json was skipped. Fix the entries listed above, then reload."
        : "Add a book to books.json, put its HTML file in books/, and redeploy.";
    } else {
      els.stateTitle.textContent = detail.title || "Something went wrong loading the shelf";
      els.stateText.textContent = detail.detail || detail.message || "";
    }
  }

  function showNotice(message) {
    els.noticeText.textContent = message;
    els.notice.hidden = false;
  }
  function hideNotice() {
    els.notice.hidden = true;
  }

  /* ---------------- Tilt + glare (mouse only) ---------------- */

  function tilt(e) {
    if (reducedMotion.matches || !finePointer.matches || drag.active) return;
    const card = cards[index];
    if (!card || Math.abs(motion.pos - index) > 0.3) return;
    const r = els.deck.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    if (px < 0 || px > 1 || py < 0 || py > 1) { resetTilt(); return; }
    motion.tiltTX = (0.5 - py) * 10;
    motion.tiltTY = (px - 0.5) * 12;
    motion.glareX = Math.round(px * 100);
    motion.glareY = Math.round(py * 100);
    requestFrame();
  }
  function resetTilt() {
    motion.tiltTX = 0;
    motion.tiltTY = 0;
    requestFrame();
  }

  /* ---------------- Swipe / drag ----------------
     Works the same for touch, pen and mouse. The deck has
     touch-action: none, so the browser hands every finger
     movement straight to us with no scroll arbitration, and the
     rAF loop paints the latest position once per display frame. */

  const VELOCITY_WINDOW = 100;   // ms of movement used to measure a flick

  const drag = {
    id: null, type: "", x: 0, y: 0, startPos: 0, active: false, caught: false, suppressClick: false,
    samples: [],     // recent [time, pos] pairs for release velocity
  };

  els.deck.addEventListener("pointerdown", (e) => {
    if (!books.length || drag.id !== null) return;          // ignore a second finger
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.id = e.pointerId;
    drag.type = e.pointerType;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.active = false;
    drag.samples = [];
    // A touch on a moving deck stops it under the finger, like a real stack of cards
    drag.caught = false;
    if (e.pointerType !== "mouse" && Math.abs(motion.pos - motion.target) > 0.02) {
      drag.caught = true;
      motion.vel = 0;
      goTo(Math.round(motion.pos));
    }
  });

  els.deck.addEventListener("pointermove", (e) => {
    if (e.pointerId !== drag.id) {
      if (e.pointerType === "mouse") tilt(e);
      return;
    }

    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.active) {
      const slop = drag.type === "mouse" ? 5 : 4;
      if (Math.hypot(dx, dy) < slop) return;
      if (Math.abs(dx) < Math.abs(dy) * 0.8) {             // mostly vertical: let it go
        drag.id = null;
        return;
      }
      drag.active = true;
      drag.x = e.clientX;               // start from here so the deck doesn't hop by the slop distance
      drag.startPos = motion.pos;       // catch the deck mid-flight if it was still moving
      motion.vel = 0;
      resetTilt();
      els.deck.classList.add("is-dragging");
      try { els.deck.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    }

    // Use every intermediate point the browser coalesced into this event for accurate velocity
    const points = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const list = points.length ? points : [e];
    for (const pt of list) {
      const pos = dragPos(pt.clientX);
      drag.samples.push([pt.timeStamp || e.timeStamp, pos]);
      motion.pos = pos;
    }
    trimSamples(e.timeStamp);
    requestFrame();
  }, { passive: true });

  function dragPos(clientX) {
    let pos = drag.startPos - (clientX - drag.x) / spreadPx;
    const max = books.length - 1;
    if (pos < 0) pos = -rubber(-pos);
    if (pos > max) pos = max + rubber(pos - max);
    return pos;
  }

  function trimSamples(now) {
    const smp = drag.samples;
    while (smp.length > 2 && now - smp[0][0] > VELOCITY_WINDOW) smp.shift();
  }

  function rubber(over) { return (over * 0.55) / (1 + over * 1.6); }   // resists harder the further you pull

  els.deck.addEventListener("pointerleave", () => { if (!drag.active) resetTilt(); });

  function endDrag(e) {
    if (e.pointerId !== drag.id) return;
    drag.id = null;
    if (!drag.active) {
      // A tap that only stopped a moving deck shouldn't also open or select a book
      if (drag.caught) {
        drag.suppressClick = true;
        setTimeout(() => { drag.suppressClick = false; }, 0);
      }
      requestFrame();
      return;
    }

    // Velocity in books/second, only from movement in the last ~100 ms,
    // so a finger that paused before lifting doesn't fling the deck
    let vel = 0;
    const now = e.timeStamp || performance.now();
    const recent = drag.samples.filter(([t]) => now - t <= VELOCITY_WINDOW);
    if (recent.length >= 2 && e.type !== "pointercancel") {
      const [t0, p0] = recent[0];
      const [t1, p1] = recent[recent.length - 1];
      if (t1 - t0 >= 8) vel = ((p1 - p0) / (t1 - t0)) * 1000;
    }
    vel = Math.max(-25, Math.min(25, vel));

    // Project where a flick would coast to, then settle on the nearest book
    const projected = motion.pos + vel * 0.18;
    let target = Math.round(projected);
    target = Math.max(Math.round(motion.pos) - 3, Math.min(Math.round(motion.pos) + 3, target));

    drag.active = false;
    els.deck.classList.remove("is-dragging");
    goTo(target, vel);

    drag.suppressClick = true;
    setTimeout(() => { drag.suppressClick = false; }, 0);
  }
  els.deck.addEventListener("pointerup", endDrag);
  els.deck.addEventListener("pointercancel", endDrag);

  /* Trackpad horizontal swipe */
  let wheelLock = 0;
  els.deck.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 12) return;
    e.preventDefault();
    const now = performance.now();
    if (now < wheelLock) return;
    wheelLock = now + 380;
    goTo(index + (e.deltaX > 0 ? 1 : -1));
  }, { passive: false });

  /* Taps: active cover opens; side covers come forward */
  els.deck.addEventListener("click", (e) => {
    const card = e.target.closest(".cover");
    if (!card) return;
    if (drag.suppressClick) { e.preventDefault(); return; }

    const i = Number(card.dataset.index);
    if (i !== index || Math.abs(motion.pos - index) > 0.25) { e.preventDefault(); goTo(i); return; }
    if (books[i].status === "missing") {
      e.preventDefault();
      notifyMissing(books[i]);
    } else if (PREVIEW) {
      e.preventDefault();
      notifyPreview(books[i]);
    }
  });

  els.open.addEventListener("click", (e) => {
    const book = books[index];
    if (book && book.status === "missing") {
      e.preventDefault();
      notifyMissing(book);
    } else if (PREVIEW) {
      e.preventDefault();
      notifyPreview(book);
    }
  });

  function notifyPreview(book) {
    showNotice(`This is a preview, so “${book.title}” can’t open here. On your deployed site this opens ${BOOKS_DIR}${book.file} in a new tab.`);
  }

  function notifyMissing(book) {
    showNotice(`“${book.title}” can’t be opened: ${BOOKS_DIR}${book.file} wasn’t found on the server. Upload the file or fix its name in books.json.`);
  }

  /* ---------------- Buttons & keyboard ---------------- */

  els.prev.addEventListener("click", () => goTo(index - 1));
  els.next.addEventListener("click", () => goTo(index + 1));
  els.refresh.addEventListener("click", load);
  els.stateRetry.addEventListener("click", load);
  els.noticeClose.addEventListener("click", hideNotice);

  document.addEventListener("keydown", (e) => {
    if (!books.length || els.shelf.hidden) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;

    const map = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: books.length - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    const hadCardFocus = document.activeElement && document.activeElement.classList.contains("cover");
    goTo(map[e.key]);
    if (hadCardFocus) cards[index].focus({ preventScroll: true });
  });

  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { measure(); layout(); });
  });
  reducedMotion.addEventListener("change", () => { layout(); requestFrame(); });

  load();
})();
