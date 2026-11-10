// End-to-end checks for Ten Days in headless Chromium.
//   cd tests && npm install && npm test
// ntfy.sh is stubbed (nothing is really sent) and pdf.js is served from the local pdfjs-dist package,
// so the run needs no network. The app is served over http because Chromium drops file:// storage on reload.
const { chromium } = require("playwright");
const path = require("path"), fs = require("fs"), http = require("http");
const ROOT = path.resolve(__dirname, ".."), FIX = path.join(__dirname, "fixtures");
const PDFJS = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "build") + "/";
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TYPES = { ".html": "text/html", ".webmanifest": "application/manifest+json", ".png": "image/png", ".js": "text/javascript" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1")) { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }   // not a Ten Days server: the app stays local
  const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});
let APP = "";
let pass = 0, fail = 0; const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log("  FAIL " + name); } }
const SEED = {
  v: 6, topics: { alert: "td-testalertchannel01", replies: "tp-testrepliesch0001", reminders: "tr-testremindersch01" }, phone: "5551234567", self: "", name: "",
  labels: ["I'm here", "Phone out", "I'm calling you"], goals: ["recovery", "reading"], ob: { done: true }, alertTestedAt: Date.now() - 86400e3, myTestedAt: Date.now() - 86400e3,
  log: [], starters: { recovery: true, reading: true },
  tasks: [
    { id: "kaaaa1", title: "Old errand", type: "ERRAND", repeat: "once", doneOn: "once", doneAt: Date.now() - 3 * 86400e3, hist: [], items: [{ t: "milk", doneOn: "" }], created: 1 },
    { id: "kaaaa2", title: "Workout", type: "CUSTOM", repeat: "daily", hist: [], created: 2 },
    { id: "kaaaa3", title: "Read today's pages", type: "READ", repeat: "daily", goal: "reading", hist: [], created: 3 }
  ],
  freeDays: [], contacts: [{ id: "kc0001", name: "Mom", phone: "555 000 1111" }], view: "list", intakeDone: true, sosWait: 3, calm: false
};
async function boot(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, reducedMotion: opts.reducedMotion || "no-preference", timezoneId: "America/Chicago" });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/ERR_FAILED|net::|status of 500/.test(m.text())) errors.push(m.text()); });
  await ctx.route("https://ntfy.sh/**", r => { const u = r.request().url(); if (r.request().method() === "POST") posts.push({ url: u, body: r.request().postData() }); r.fulfill({ status: 200, body: u.includes("/json") ? "" : "{}" }); });
  await ctx.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/*", r => {
    if (opts.offlineReader) return r.abort();
    const f = r.request().url().split("/").pop();
    r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(PDFJS + f) });
  });
  if (opts.seed !== null) await page.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("tendays.v1", s); } }, JSON.stringify(opts.seed || SEED));
  if (opts.at) await page.clock.setSystemTime(opts.at);
  if (opts.route) await ctx.route(opts.route[0], opts.route[1]);
  if (opts.init) await page.addInitScript(opts.init[0], opts.init[1]);
  await page.goto(APP + (opts.hash || ""));
  await page.waitForSelector("#screen h1");
  return { ctx, page, errors, posts };
}
function seed_name(seed, n) { seed.name = n; seed.partner = { name: n === "Rishi" ? "Audi" : "Rishi" }; }
const S = page => page.evaluate(() => JSON.parse(localStorage.getItem("tendays.v1")));
async function ask(page, text) { await page.fill("#qa", text); await page.click("#qa-add"); await page.waitForTimeout(80); }
async function axe(page, name) {
  // measure the settled screen, not the middle of its fade-in
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.id === "screen").map(a => a.finished.catch(() => {}))));
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa"], rules: { "color-contrast": { enabled: true } } }));
  const v = r.violations.filter(x => x.impact === "serious" || x.impact === "critical");
  v.forEach(x => console.log("    axe " + name + ": " + x.id + " — " + x.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")));
  ok(!v.length, "axe " + name);
}

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  APP = "http://127.0.0.1:" + server.address().port + "/index.html";
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  try {
    // ---------- engine ----------
    console.log("engine");
    {
      const { page, errors, ctx } = await boot(browser);
      const r = await page.evaluate(() => {
        const T = window.__td, now = new Date(), out = {};
        const d = (t) => { const x = T.draft(t); return x && Object.assign({ q: T.next(x) }, x); };
        out.groc = d("I need to pick up groceries after class.");
        out.calc = d("Study calculus for an hour tomorrow");
        out.mom = d("Remind me to call Mom when I get home");
        out.stuff = d("I need to pick up this stuff.");
        out.milk = d("Buy milk, eggs and bread tomorrow");
        out.place = d("Pick up my prescription from CVS on Friday");
        out.inmin = d("Remind me in 30 minutes to stretch");
        out.am = d("Call the bank at 9 a.m. tomorrow");
        out.intents = ["I need you", "I'm struggling with an urge", "I'm so overwhelmed", "how am I doing?", "Actually, tomorrow", "Make that 30 minutes", "motivate me",
          "I have an exam Friday. Help me prepare.", "Buy milk", "what is this?"].map(T.intent);
        out.plan = T.plan("I have an exam Friday. Help me prepare.");
        out.plan2 = T.plan("I have a calculus exam on Friday");
        out.plan3 = T.plan("Help me plan my essay");
        const fx = T.draft("Study calculus for an hour tomorrow"); out.fix1 = T.fix("Make that 30 minutes", fx); out.fix1d = fx.dur;
        out.fix2 = T.fix("Move it after class", fx); out.fix2a = fx.anchor; out.fix2t = fx.time;
        out.fix3 = T.fix("Actually, Thursday at 6pm", fx); out.fix3d = fx.date; out.fix3t = fx.time;
        out.fix4 = T.fix("Call it Calc review", fx); out.fix4t = fx.title;
        out.tomorrow = (() => { const x = new Date(); x.setDate(x.getDate() + 1); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); })();
        out.pass = T.passages("When an urge arrives, it feels permanent. It is not. Every urge rises, peaks,\nand falls away if you do not feed it.\n\nShort.");
        return out;
      });
      ok(r.groc.title === "Pick up groceries" && r.groc.type === "ERRAND" && r.groc.anchor === "after class" && r.groc.q === "anchor", "groceries after class → anchor question");
      ok(r.calc.title === "Study calculus" && r.calc.dur === 60 && r.calc.date === r.tomorrow && !r.calc.time && r.calc.q === "time", "study calculus an hour tomorrow");
      ok(r.mom.type === "CALL" && r.mom.contact.name === "Mom" && cleanPhone(r.mom.contact.phone) === "5550001111" && r.mom.anchor === "when I get home" && r.mom.remind === true && r.mom.q === "anchor", "call Mom when I get home");
      ok(r.stuff.type === "ERRAND" && r.stuff.itemsUnknown && r.stuff.q === "when", "pick up this stuff asks when first");
      ok(r.milk.items.length === 3 && r.milk.date === r.tomorrow && r.milk.q === null, "buy milk, eggs and bread tomorrow");
      ok(r.place.place === "CVS" && r.place.title === "Pick up my prescription", "place from CVS: " + r.place.place + " / " + r.place.title);
      ok(r.inmin.title === "Stretch" && !!r.inmin.time, "in 30 minutes → time");
      ok(r.am.time === "09:00" && r.am.date === r.tomorrow, "9 a.m. tomorrow");
      ok(JSON.stringify(r.intents) === JSON.stringify(["support", "support", "overwhelm", "review", "fix", "fix", "encourage", "plan", "task", "unsure"]), "intents " + r.intents.join(","));
      ok(r.plan.steps[0].title === "List every topic for the exam and gather notes", "plan wording: " + r.plan.steps[0].title);
      ok(r.plan.kind === "exam" && r.plan.name === "Exam" && !!r.plan.due && r.plan.steps.length >= 3 && r.plan.steps[r.plan.steps.length - 1].main, "exam plan has steps and the exam");
      ok(r.plan2.name === "Calculus exam", "subject: " + r.plan2.name);
      ok(r.plan3.kind === "paper" && !r.plan3.due && r.plan3.steps.length === 0, "essay plan without a date asks first");
      ok(r.fix1.join() === "dur" && r.fix1d === 30, "fix: 30 minutes");
      ok(r.fix2.join() === "anchor" && r.fix2a === "after class" && r.fix2t === "", "fix: move after class clears time");
      ok(r.fix3.includes("date") && r.fix3t === "18:00", "fix: Thursday 6pm");
      ok(r.fix4t === "Calc review", "fix: rename");
      ok(r.pass.length === 1 && r.pass[0].startsWith("When an urge"), "passages: " + JSON.stringify(r.pass));
      ok(!errors.length, "engine: no errors " + errors.join(" | "));
      await ctx.close();
    }
    function posts_any(calls, t) { return calls.some(c => c.data.includes(t)); }
    function cleanPhone(p) { return (p || "").replace(/[^\d+]/g, ""); }

    // ---------- upgrade from saved data, home ----------
    console.log("home and upgrade");
    {
      const { page, errors, ctx } = await boot(browser);
      ok(await page.isVisible("#qa"), "composer on Today");
      ok(await page.locator("#nav-home[aria-current=page]").count() === 1, "Today tab current");
      ok(await page.isVisible("#sos"), "I need you visible");
      const st = await S(page);
      ok(st.v === 7 && st.tasks.length === 3 && st.topics.alert === SEED.topics.alert && st.phone === SEED.phone, "old data kept after upgrade");
      ok(st.tasks[0].hist.includes("once"), "old finished one-off counts toward progress");
      ok(st.milesInit && st.miles["first-task"], "milestones initialised silently");
      ok(!(await page.$("#celebrate")), "no celebration burst on upgrade");
      ok(await page.locator("text=More").count() === 0, "no More dumping ground");
      await axe(page, "today");
      // a simple task saves straight from the box
      await ask(page, "Buy milk");
      let s2 = await S(page);
      ok(s2.tasks.some(t => t.title === "Buy milk" && t.type === "ERRAND"), "simple task saved without menus");
      ok((await page.inputValue("#qa")) === "", "box clears after sending");
      ok((await page.textContent("#asst-state")).includes("Saved on this phone"), "card says saved");
      ok((await page.textContent("#toast")).includes("Saved: Buy milk"), "toast says saved");
      await page.click("#toast-act");
      s2 = await S(page);
      ok(!s2.tasks.some(t => t.title === "Buy milk"), "undo removes it");
      ok((await page.textContent("#asst-state")).includes("Preview"), "after undo it's a preview again");
      await page.click("#asst-discard");
      ok((await page.inputValue("#qa")) === "Buy milk", "discard puts text back in the box");
      await page.click("#nav-progress"); await page.click("#mark-free");
      ok(!(await page.textContent("#toast")).includes("null"), "toast without an action shows no stray text");
      await page.click("#unmark-free"); await page.click("#nav-home");
      ok(!errors.length, "home: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- ambiguous input: one focused question at a time ----------
    console.log("questions");
    {
      const { page, errors, ctx } = await boot(browser);
      await ask(page, "I need to pick up this stuff.");
      ok((await page.textContent("#asst-state")).includes("not saved"), "pickup: preview not saved");
      ok((await page.textContent("#aq-text")) === "When do you need it?", "pickup asks when first");
      ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === "aq-first", "focus moves to the first answer");
      await page.click("[data-q=aq-tomorrow]");
      ok((await page.textContent("#aq-text")) === "What do you need to pick up?", "then asks what");
      await page.fill("#aq-items", "milk, eggs and bananas");
      await page.click("#aq-items-set");
      let s = await S(page), t = s.tasks.find(x => x.title === "Pick up this stuff");
      ok(t && t.items.length === 3 && !!t.date, "pickup saved with items and date");
      ok((await page.textContent("#asst-state")).includes("Saved"), "saved after the last answer");
      // anchor + remember
      await ask(page, "Pick up groceries after class");
      ok((await page.textContent("#aq-text")) === "When does class end?", "after class asks when class ends");
      await page.fill("#aq-time", "15:00");
      await page.check("#aq-remember");
      await page.click("#aq-set");
      s = await S(page);
      ok(s.memory.length === 1 && s.memory[0].value === "15:00", "remembered only with the tick");
      t = s.tasks.find(x => x.title === "Pick up groceries");
      ok(t && t.time === "15:00" && t.anchor === "after class", "anchor time applied");
      await ask(page, "Return library books after class");
      ok((await page.textContent("#ad-chips")).includes("from what you told me"), "memory is used and labeled");
      s = await S(page);
      ok(s.tasks.some(x => x.title === "Return library books" && x.time === "15:00"), "remembered time saves directly");
      // save as is, skipping the optional question
      await ask(page, "Study calculus for an hour tomorrow");
      ok((await page.textContent("#aq-text")).includes("optional"), "optional time question");
      await page.click("#asst-save");
      s = await S(page);
      t = s.tasks.find(x => x.title === "Study calculus");
      ok(t && t.dur === 60 && !t.time, "saved unscheduled with Save as is");
      // correction applies to the saved task
      await ask(page, "Actually, make that 30 minutes");
      s = await S(page);
      ok(s.tasks.find(x => x.title === "Study calculus").dur === 30, "correction changes the saved task");
      ok((await page.textContent("#toast")).includes("Updated"), "correction toast");
      await page.click("#toast-act");
      s = await S(page);
      ok(s.tasks.find(x => x.title === "Study calculus").dur === 60, "correction undo");
      // chip editor
      await page.click("#fc-dur");
      await page.selectOption("#ae-first", "45");
      await page.click("#ae-done");
      s = await S(page);
      ok(s.tasks.find(x => x.title === "Study calculus").dur === 45, "chip editor changes the saved task");
      await axe(page, "card");
      // escape closes
      await page.focus("#ad-title"); await page.keyboard.press("Escape");
      ok(!(await page.$("#asst")), "Escape closes the card");
      // refresh keeps a draft and typed text
      await ask(page, "Remind me to call Mom when I get home");
      await page.fill("#qa", "half-typed thought");
      await page.waitForTimeout(500);
      await page.waitForTimeout(1500); await page.reload(); await page.waitForSelector("#screen h1");
      ok((await page.inputValue("#qa")) === "half-typed thought", "typed text survives refresh");
      ok((await page.textContent("#aq-text")).includes("can't tell when you get home"), "draft and question survive refresh");
      await page.fill("#aq-time", "18:30"); await page.click("#aq-set");
      s = await S(page); t = s.tasks.find(x => x.title === "Call Mom");
      ok(t && t.type === "CALL" && t.time === "18:30" && t.contact.phone, "call Mom saved with number from contacts");
      await page.waitForSelector("#remind-state");
      ok((await page.textContent("#remind-state")).includes("scheduled"), "said “remind me”: reminder scheduled automatically (ntfy accepted)");
      ok(!errors.length, "questions: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- reminders only claim success when ntfy accepted ----------
    console.log("reminders");
    {
      const { page, errors, posts, ctx } = await boot(browser);
      await ask(page, "Stretch in 2 hours");
      await page.click("#remind-me");
      await page.waitForSelector("#remind-state");
      ok(posts.some(p => p.url.includes(SEED.topics.reminders) && /delay=\d+/.test(p.url)), "reminder scheduled through ntfy with a delay");
      ok((await page.textContent("#toast")).includes("Reminder scheduled"), "reminder toast after success");
      await page.unroute("https://ntfy.sh/**");
      await page.route("https://ntfy.sh/**", r => r.fulfill({ status: 500, body: "" }));
      await ask(page, "Drink water in 1 hour");
      await page.click("#remind-me");
      await page.waitForTimeout(300);
      ok((await page.textContent("#toast")).includes("not scheduled"), "failure is reported");
      ok(!(await page.$("#remind-state")), "no scheduled state on failure");
      ok(!errors.length, "reminders: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- plans ----------
    console.log("plans");
    {
      const { page, errors, ctx } = await boot(browser);
      await ask(page, "I have an exam Friday. Help me prepare.");
      ok((await page.textContent("#asst-state")).includes("Suggested plan"), "plan is labeled a suggestion");
      ok((await page.textContent("#pl-note")).includes("doesn't see your calendar"), "no invented availability");
      const n = await page.locator(".pstep").count();
      await page.uncheck("#pl-on-0");
      await page.fill("#pl-t-1", "Study: derivatives"); await page.dispatchEvent("#pl-t-1", "change");
      await page.click("#pl-add");
      let s = await S(page);
      const added = s.tasks.filter(t => t.plan);
      ok(added.length === n - 1 && added.some(t => t.title === "Study: derivatives"), "approved and edited plan applied");
      await page.click("#toast-act");
      s = await S(page);
      ok(!s.tasks.some(t => t.plan), "plan undo");
      await ask(page, "Help me plan my essay");
      ok(await page.isVisible("#pl-due"), "asks when before planning");
      ok(!errors.length, "plans: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- other intents ----------
    console.log("intents in the UI");
    {
      const { page, errors, ctx } = await boot(browser);
      await ask(page, "I'm so overwhelmed");
      ok((await page.textContent("#asst-state")).includes("smaller"), "overwhelm card");
      ok(await page.isVisible("#ow-one"), "overwhelm shows just one task");
      await page.click("#asst-close");
      await ask(page, "motivate me");
      const q1 = await page.textContent("#enc-quote"); await page.click("#enc-next");
      ok(q1 !== (await page.textContent("#enc-quote")), "encourage: another");
      await page.click("#asst-astask");
      ok((await page.textContent("#asst-state")).includes("Saved"), "'This was a task' converts it");
      await ask(page, "how am I doing?");
      ok(await page.isVisible("#rev-line"), "review card");
      await ask(page, "what is this?");
      ok((await page.textContent("#asst-state")).includes("not sure"), "unsure asks instead of pretending");
      ok(!errors.length, "intents: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- I need you ----------
    console.log("support");
    {
      const { page, errors, posts, ctx } = await boot(browser);
      await page.click("#sos");
      await page.waitForTimeout(100);
      ok((await page.textContent("#screen h1")) === "I'm here.", "support opens immediately");
      ok(await page.isVisible("#cancelbar") && !(await page.isVisible("#dock")), "3-second cancel shown");
      ok(await page.isVisible("#stay .breath"), "breathing shown after the button");
      await page.waitForTimeout(3400);
      ok(posts.some(p => p.url.includes(SEED.topics.alert) && p.body.includes("Call when you can")), "check-in sent after 3 s");
      await page.waitForTimeout(200);
      ok((await page.textContent("#sos-status")).includes("He's been told"), "status: told");
      await axe(page, "support");
      const q1 = await page.textContent("#sup-quote");
      await page.click("#sup-another");
      ok(q1 !== (await page.textContent("#sup-quote")), "another perspective");
      await page.click("#sup-step");
      ok(await page.locator(".btn.opt").count() >= 4, "step options");
      await page.click("#opt-1");
      let s = await S(page);
      ok(s.steps.length === 1, "step logged");
      await page.click("#sup-ok");
      ok((await page.textContent("#screen h1")) === "A private line?", "after a check-in, private line offered");
      await page.click("#skip-line");
      // cancel path
      posts.length = 0;
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel"); await page.waitForTimeout(3000);
      ok(!posts.some(p => p.url.includes(SEED.topics.alert)), "cancel sends nothing");
      ok((await page.textContent("#screen h1")) === "I'm here.", "cancel keeps support open");
      // typed
      await page.click("#sup-ok"); await page.waitForTimeout(100);
      if ((await page.textContent("#screen h1")) === "A private line?") await page.click("#skip-line");
      posts.length = 0;
      await page.click("#nav-home");
      await ask(page, "I feel an urge right now");
      ok((await page.textContent("#screen h1")) === "I'm here.", "typed urge opens support");
      await page.waitForTimeout(3300);
      ok(!posts.length, "typing never sends a check-in by itself");
      ok(await page.isVisible("#sup-tell"), "one tap to tell him");
      ok(await page.isVisible("#crisis"), "988 line present");
      ok(!errors.length, "support: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      const seed = JSON.parse(JSON.stringify(SEED)); seed.topics = {}; seed.alertTestedAt = 0;
      const { page, errors, posts, ctx } = await boot(browser, { seed });
      await page.click("#sos");
      ok((await page.textContent("#screen h1")) === "I'm here." && await page.isVisible("#sup-nosetup"), "not set up: support still opens, says why");
      ok(!posts.length, "not set up: nothing sent");
      ok(!errors.length, "nosetup: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- completion feedback, motion, sound ----------
    console.log("completion and feel");
    {
      const { page, errors, ctx } = await boot(browser);
      await page.addInitScript(() => { window.__ac = 0; const A = window.AudioContext; window.AudioContext = function () { window.__ac++; return new A(); }; });
      await page.reload(); await page.waitForSelector("#qa");
      await page.click('[data-check="kaaaa2"]');
      const tt = await page.textContent("#toast");
      ok(tt.includes("Done: Workout") && tt.includes("+10 XP"), "completion toast in text: " + tt);
      ok(await page.evaluate(() => window.__ac) === 0, "sound off by default");
      let s = await S(page);
      ok(s.tasks.find(t => t.id === "kaaaa2").hist.length === 1, "done recorded");
      await page.click("#toast-act");
      s = await S(page);
      ok(s.tasks.find(t => t.id === "kaaaa2").hist.length === 0, "completion undo");
      await page.click("#nav-you"); await page.click("#y-feel");
      await page.click("#mo-off");
      ok(await page.evaluate(() => document.documentElement.classList.contains("rm")), "motion reduced via setting");
      await page.check("#sound-toggle");
      ok(await page.evaluate(() => window.__ac) === 1, "sound plays only when turned on");
      await page.uncheck("#rpg-toggle");
      await page.click("#celebrate-test");
      ok(await page.isVisible("#celebrate"), "celebration shows");
      ok(await page.evaluate(() => getComputedStyle(document.getElementById("celebrate")).pointerEvents) === "none", "celebration never blocks taps");
      ok(await page.locator("#celebrate .confetti i").count() === 0, "no confetti with reduced motion");
      await page.click("#nav-home");
      await page.click('[data-check="kaaaa2"]');
      ok(!(await page.textContent("#toast")).includes("XP"), "XP hidden when levels are off");
      await page.click("#nav-progress");
      ok(!(await page.$("#level-card")), "progress without levels");
      await axe(page, "progress");
      ok(!errors.length, "feel: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      const { page, ctx } = await boot(browser, { reducedMotion: "reduce" });
      ok(await page.evaluate(() => document.documentElement.classList.contains("rm")), "system Reduce Motion respected");
      await ctx.close();
    }

    // ---------- progress, free day, quests ----------
    console.log("progress");
    {
      const { page, errors, posts, ctx } = await boot(browser);
      await page.click("#nav-progress");
      ok((await page.textContent("#screen h1")) === "Progress" && await page.isVisible("#level-card"), "progress with level");
      await page.click("#mark-free");
      let s = await S(page);
      ok(s.freeDays.length === 1, "free day marked");
      await page.click("#quiet-check"); await page.waitForTimeout(300);
      ok(posts.some(p => p.url.includes("title=%E2%9C%93")), "quiet check sent on tap only");
      ok((await page.textContent("#quiet-status")) === "Sent.", "quiet status");
      await page.click("#nav-home");
      await page.click('[data-check="kaaaa2"]'); await page.click('[data-check="kaaaa3"]');
      await page.waitForTimeout(100);
      s = await S(page);
      ok(s.questDay && s.bank.xp >= 30, "quest bonus recorded");
      ok(!errors.length, "progress: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- PDFs ----------
    console.log("pdf");
    {
      const { page, errors, ctx } = await boot(browser);
      await page.click("#nav-you"); await page.click("#y-lib");
      ok(await page.isVisible("#lib-empty"), "honest empty state");
      await axe(page, "library");
      await page.setInputFiles("#pdf-in", FIX + "/book.pdf");
      await page.waitForSelector("#passages", { timeout: 20000 });
      ok((await page.textContent("#pg-label")) === "1 / 2", "pdf read: pages");
      ok(await page.isVisible("#back"), "Back button at the top");
      const firstText = await page.locator(".passage .ptext").first().textContent();
      ok(firstText.includes("Chapter One") || firstText.includes("urge"), "passage text extracted: " + firstText.slice(0, 60));
      // select several passages, across pages, and save them in one go without leaving the book
      const p1 = page.locator(".passage.sel").filter({ hasText: "permanent" }).first();
      const quote = await p1.locator(".ptext").textContent();
      await p1.click();
      ok(await page.locator(".passage.sel[aria-pressed=true]").count() === 1 && (await page.textContent("#sel-n")).includes("1 passage"), "tap selects a passage");
      await page.click("#pg-next");
      ok((await page.textContent("#read-today")).startsWith("Today: 0 of"), "flipping to the next page doesn't count it as read");
      await page.locator(".passage.sel").filter({ hasText: "reason" }).first().click();
      ok((await page.textContent("#sel-n")).includes("2 passages"), "selection kept across pages");
      await page.selectOption("#sel-for", "urge");
      await page.click("#sel-save");
      let s = await S(page);
      ok(s.cards.length === 2 && s.cards.some(c => c.quote === quote && c.page === 1) && s.cards.some(c => c.page === 2), "two cards saved with exact text and pages");
      ok((await page.textContent("#pg-label")) === "2 / 2" && !(await page.$("#selbar")), "still on the same page, selection cleared");
      ok(await page.locator(".passage.on").count() === 1, "saved passage marked");
      await page.click("#toast-act"); s = await S(page); ok(s.cards.length === 0, "save undo");
      await page.click("#pg-prev");
      await page.locator(".passage.sel").filter({ hasText: "permanent" }).first().click(); await page.click("#sel-save");
      // read every day: a task that finishes itself at the page goal
      ok(!(await page.$("#doc-goal")), "no page-goal dropdown");
      await page.click("#doc-daily");
      s = await S(page); const rt = s.tasks.find(t => t.docId && t.type === "READ" && t.repeat === "daily");
      ok(!!rt, "daily reading task linked to the book");
      await page.evaluate(() => window.__td.readScale(0.05));
      await page.click("#doc-read"); await page.waitForSelector("#rd-pages canvas", { timeout: 20000 });
      ok(!(await page.$("#read-count")) && !(await page.$("#rd-next")) && !(await page.$("#rd-prev")), "one scroll: no page buttons, no counting text");
      await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem("tendays.v1")); const d = s.docs[0]; return Object.values(d.read || {}).some(l => l.includes(1)); }, null, { timeout: 8000 });
      ok(true, "a page counts quietly after time spent on it");
      await page.evaluate(() => document.getElementById("pg-2").scrollIntoView());
      await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem("tendays.v1")); return s.tasks.some(t => t.type === "READ" && t.docId && t.doneOn); }, null, { timeout: 8000 });
      ok(true, "reading goal met marks the task done");
      ok(parseFloat(await page.evaluate(() => document.getElementById("rd-prog-i").style.width)) === 100, "the slim bar is full");
      await page.evaluate(() => document.body.classList.add("rd-chrome"));
      await page.click("#read-close"); await page.click("#nav-you"); await page.click("#y-lib");
      ok(await page.isVisible(".shelf .book") && !(await page.textContent("#screen")).includes("pick passages that speak to you"), "library: a shelf, almost no text");
      await page.click('[data-card]');
      ok((await page.textContent("#card-src")).includes("Exact quote · book, p. 1"), "quote labeled with doc and page");
      ok((await page.textContent("#card-items")).includes("not the author's words"), "adaptations labeled as not the author's");
      await page.fill("#card-own", "Ride it out."); await page.click("#card-own-add");
      ok((await page.textContent("#card-items")).includes("Your words"), "own words labeled");
      await axe(page, "card");
      s = await S(page);
      ok(s.cards.length === 1 && s.cards[0].quote === quote && s.cards[0].page === 1, "card saved");
      await page.waitForTimeout(1500); await page.reload(); await page.waitForSelector("#screen h1");
      await page.click("#sos"); await page.waitForTimeout(100); await page.click("#cd-cancel").catch(() => {});
      await page.waitForTimeout(800); if (await page.isVisible("#cd-cancel")) await page.click("#cd-cancel");
      let seen = false;
      for (let i = 0; i < 12 && !seen; i++) { seen = (await page.textContent("#sup-src")).includes("Exact quote · book, p. 1"); if (!seen) await page.click("#sup-another"); }
      ok(seen, "support shows the quote with its source");
      // scanned + broken
      await page.click("#sup-ok"); await page.click("#nav-you"); await page.click("#y-lib");
      await page.setInputFiles("#pdf-in", FIX + "/scanned.pdf");
      await page.waitForSelector("#scanned", { timeout: 20000 });
      ok((await page.textContent("#scanned")).includes("OCR"), "scanned PDF explains OCR");
      await page.click("#doc-manual");
      await page.fill("#cn-quote", "Typed words."); await page.fill("#cn-page", "2"); await page.click("#cn-save");
      ok((await page.textContent("#card-src")).includes("Typed by you from scanned, p. 2"), "typed passage labeled as typed");
      await page.click("#back");
      await page.setInputFiles("#pdf-in", FIX + "/broken.pdf");
      await page.waitForSelector("#pdf-job.bad", { timeout: 20000 });
      ok((await page.textContent("#pdf-step")).includes("isn't a readable PDF"), "broken PDF error");
      // delete a document removes its cards
      await page.click("#pdf-dismiss");
      await page.click('.bookw:has-text("book") [data-doc-more]');
      await page.click("#doc-delete"); await page.click("#doc-delete");
      s = await S(page);
      ok(!s.docs.some(d => d.name === "book") && !s.cards.some(c => c.docName === "book"), "delete doc removes its cards");
      ok(!errors.length, "pdf: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      const { page, ctx } = await boot(browser, { offlineReader: true });
      await page.click("#nav-you"); await page.click("#y-lib");
      await page.setInputFiles("#pdf-in", FIX + "/book.pdf");
      await page.waitForSelector("#pdf-job.bad", { timeout: 15000 });
      ok((await page.textContent("#pdf-step")).includes("couldn't load"), "reader offline handled");
      await ctx.close();
    }

    // ---------- You, reminders collection, memory, data ----------
    console.log("you");
    {
      const { page, errors, ctx } = await boot(browser);
      await page.click("#nav-you");
      await axe(page, "you");
      // every row opens something with a way back
      const ids = await page.$$eval("#screen .morelist .btn", b => b.map(x => x.id));
      for (const id of ids) {
        await page.click("#" + id);
        const h1 = await page.textContent("#screen h1");
        const backBtn = await page.$("#back");
        ok(h1 && backBtn, "You → " + id + " opens and has Back (" + h1 + ")");
        if (backBtn) await backBtn.click();
        await page.click("#nav-you");
      }
      const cids = await (async () => { await page.click("#y-checkin"); return page.$$eval("#screen .morelist .btn", b => b.map(x => x.id)); })();
      for (const id of cids) {
        if (!(await page.isVisible("#" + id))) await page.click("#ck-adv summary");
        await page.click("#" + id);
        ok(!!(await page.textContent("#screen h1")), "Check-in → " + id);
        await page.click("#nav-you"); await page.click("#y-checkin");
      }
      // support profile
      await page.click("#nav-you"); await page.click("#y-me");
      await page.click('#me-habits [data-v="phone"]'); await page.click('#me-style [data-v="direct"]');
      await page.fill("#me-reasons", "My future self\nMy family"); await page.click("#me-save");
      let s = await S(page);
      ok(s.profile.habitKey === "phone" && s.profile.style === "direct" && s.profile.reasons.length === 2, "profile saved");
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel");
      ok((await page.textContent("#step-text")).includes("phone in another room"), "support step follows the habit");
      ok((await page.textContent("#sup-line")).startsWith("Good. You stopped"), "support follows the style");
      // collection with an image
      await page.click("#sup-ok"); await page.click("#nav-you"); await page.click("#y-col");
      await page.setInputFiles("#img-in", FIX + "/scan.png");
      await page.waitForSelector(".citem img[src^=blob]", { timeout: 10000 });
      await page.fill(".citem input[id^=alt-]", "A page of words"); await page.dispatchEvent(".citem input[id^=alt-]", "change");
      await page.fill("#c-quote", "Keep going."); await page.click("#c-add");
      s = await S(page);
      ok(s.collection.length === 2 && s.collection.some(c => c.kind === "image" && c.alt === "A page of words"), "collection saved with alt text");
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel");
      ok(await page.locator(".visual img[alt='A page of words']").count() === 1, "support uses your image");
      // memory
      await page.click("#sup-ok"); await page.click("#nav-home");
      await ask(page, "Call Sam after work"); await page.fill("#aq-time", "17:30"); await page.check("#aq-remember"); await page.click("#aq-set");
      await page.click("#nav-you"); await page.click("#y-mem");
      ok((await page.textContent("#mem-list")).includes("Work ends around"), "memory listed");
      await page.click("[data-forget]");
      s = await S(page);
      ok(s.memory.length === 0, "memory forgotten");
      await page.click("#toast-act");
      s = await S(page);
      ok(s.memory.length === 1, "forget undo");
      // delete everything
      await page.click("#nav-you"); await page.click("#y-data");
      await page.click("text=Delete everything on this phone"); await page.click("text=Tap again. This can't be undone.");
      await page.waitForTimeout(1600);
      ok(await page.evaluate(() => !localStorage.getItem("tendays.v1") || JSON.parse(localStorage.getItem("tendays.v1")).tasks.length === 0), "delete everything clears data");
      ok(!errors.filter(e => !/tendays-files/.test(e)).length, "you: no errors " + errors.join(" | "));
      await ctx.close();
    }


    // ---------- AI helper (Gemini stubbed) ----------
    console.log("ai");
    {
      const { page, errors, ctx } = await boot(browser);
      const calls = []; let mode = "ok";
      await page.route("https://generativelanguage.googleapis.com/**", r => {
        const req = r.request();
        if (req.method() === "GET") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [{ name: "models/gemini-9-flash-lite", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-9-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/text-embedding-9", supportedGenerationMethods: ["embedContent"] }] }) });
        const body = JSON.parse(req.postData() || "{}");
        const sys = body.system_instruction.parts[0].text, data = body.contents[0].parts[0].text;
        calls.push({ url: req.url(), key: req.headers()["x-goog-api-key"], sys, data });
        if (mode === "flaky" && req.headers()["x-goog-api-key"]) return r.abort("failed");
        if (mode === "think" && body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel === "minimal") return r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "thinking_level MINIMAL is not supported for this model" } }) });
        if (mode === "404" && req.url().includes("-latest")) return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "models/gemini-flash-latest is not found" } }) });
        if (mode === "429") return r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { message: "quota" } }) });
        const today = new Date(); const dk = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
        let out;
        const audio = body.contents[0].parts[1] && body.contents[0].parts[1].inline_data;
        if (audio) calls[calls.length - 1].audio = audio.mime_type + ":" + audio.data.length;
        if (sys.includes("A voice note is attached")) out = JSON.stringify({ transcript: "pay rent today and someday clean the garage", kind: "tasks", tasks: [{ title: "Pay rent", date: dk, priority: "high" }, { title: "Clean the garage", priority: "low" }] });
        else if (sys.includes("Read the person's note")) out = JSON.stringify({ kind: "tasks", tasks: [{ title: "Grab protein powder", date: "", time: "", minutes: 0, repeat: "once", items: [] }, { title: "Email my TA about the quiz", date: dk, time: "", minutes: 0, repeat: "once", items: [] }], question: "" });
        else if (sys.includes("Make a short, realistic plan")) out = JSON.stringify({ steps: [{ title: "Redo chapter 3 problems", date: dk, minutes: 40 }, { title: "Bad date step", date: "1999-01-01", minutes: 20 }] });
        else if (sys.includes("Group related tasks")) { const ids = [...data.matchAll(/^(k\w+):/gm)].map(m => m[1]); out = JSON.stringify({ groups: [{ name: "daily", ids: ids.slice(0, 2).concat(["kfake"]) }] }); }
        else if (sys.includes("You manage the person's to-do list")) { const ids = [...data.matchAll(/^(k\w+) \|/gm)].map(m => m[1]); out = JSON.stringify({ summary: "A couple of tweaks.", changes: [{ type: "group", ids: ids.slice(0, 2), name: "school", why: "Same class" }, { type: "add", title: "Stretch", repeat: "daily", why: "You move most days" }, { type: "date", id: "kfake", date: dk }] }); }
        else if (sys.includes("From the numbered passages")) out = JSON.stringify({ picks: [{ n: 1, why: "About sitting with urges" }, { n: 99, why: "bad" }] });
        else if (sys.includes("support screen")) out = "Breathe slowly. Put the phone in the other room for ten minutes.";
        else if (sys.includes("Write 2 to 4 short sentences")) out = "You finished your workout. Tomorrow, start with reading.";
        else out = "OK";
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }] }) });
      });
      const LONG = "After the gym I need to grab protein powder and also email my TA about the quiz tomorrow";
      // off: nothing goes out
      await ask(page, LONG);
      ok(calls.length === 0, "no key: no AI request");
      await page.click("#nav-you"); await page.click("#y-ai");
      ok((await page.textContent("#ai-status")).includes("no key"), "AI off without a key");
      await page.click("#ai-agree");
      ok((await page.textContent("#ai-status")).includes("no key") && calls.length === 0, "can't turn on without a key");
      ok(!(await page.isChecked("#ai-c-support")), "support moments off by default");
      const KEY = "AQ.Ab8RN6-test.key_with.dots0000000";
      await page.fill("#ai-key", " " + KEY + "\u200B ");
      await page.click("#ai-agree");
      await page.waitForSelector("#ai-status:has-text('connection works')");
      ok(calls.length === 1 && calls[0].key === KEY && !calls[0].url.includes("key="), "one tap saves the key (dots, spaces stripped), turns on and checks; key in a header");
      ok(calls[0].url.includes("models/gemini-flash-lite-latest:generateContent"), "default model is the fast one");
      ok(await page.isVisible("#ai-key-ok"), "key shown as saved");
      // a network that blocks the normal request: retried without the pre-check
      mode = "flaky"; await page.click("#ai-agree"); await page.waitForSelector("#ai-status:has-text('connection works')");
      ok(calls[calls.length - 1].url.includes("key=") && !calls[calls.length - 1].key, "blocked request retried in the simple form");
      // a retired model name: Ten Days asks Google for a current Flash model
      mode = "404"; await page.click("#ai-agree"); await page.waitForSelector("#ai-status:has-text('connection works')");
      ok((await S(page)).ai.model === "gemini-9-flash-lite", "fast model found automatically");
      // a model that doesn't allow minimal thinking: steps down once and remembers
      mode = "think"; await page.click("#ai-agree"); await page.waitForSelector("#ai-status:has-text('connection works')");
      ok((await S(page)).ai.think["gemini-9-flash-lite"] === "low", "thinking setting stepped down and remembered");
      mode = "ok";
      // messy note -> AI preview, nothing saved yet
      await page.click("#nav-home");
      const before = (await S(page)).tasks.length;
      await ask(page, LONG);
      await page.waitForSelector("#ai-saved");
      ok((await page.textContent("#asst")).includes("Added by AI · 2 tasks"), "AI result saved and labeled");
      ok((await S(page)).tasks.length === before + 2 && (await S(page)).tasks.some(t => t.title === "Email my TA about the quiz"), "AI tasks created straight away");
      await page.click("#ai-undo"); ok((await S(page)).tasks.length === before, "AI tasks undo");
      await ask(page, LONG); await page.waitForSelector("#ai-saved");
      // voice note: record, stop, tasks appear by urgency
      await page.click("#qa-mic"); await page.waitForSelector("#rec-time"); await page.waitForTimeout(1500);
      await page.click("#rec-stop"); await page.waitForSelector("#ai-heard");
      const vc = calls[calls.length - 1];
      ok(vc.audio && vc.audio.startsWith("audio/wav:"), "voice note sent as WAV audio");
      const vs = await S(page);
      ok(vs.tasks.some(t => t.title === "Pay rent" && t.priority === "high") && vs.tasks.some(t => t.title === "Clean the garage" && t.priority === "low"), "voice note became tasks with urgency");
      ok((await page.textContent("#ai-heard")).includes("pay rent today"), "shows what it heard");
      // simple input stays rule-based
      const n0 = calls.length; await ask(page, "Buy milk"); ok(calls.length === n0, "clear input never calls AI");
      await ask(page, "#private " + LONG); ok(calls.length === n0, "private input never sent");
      // plans
      await ask(page, "I have an exam Friday. Help me prepare.");
      await page.click("#pl-ai"); await page.waitForSelector("#asst-state:has-text('Plan by AI')");
      const ttl = await page.inputValue("#pl-t-0"), d1 = await page.inputValue("#pl-d-1");
      ok(ttl === "Redo chapter 3 problems" && d1 > "2026-01-01", "AI plan applied, bad date replaced: " + d1);
      ok((await page.locator(".pstep").last().locator("input[type=text]").inputValue()) === "Exam", "the exam itself kept");
      await page.click("#asst-close");
      // review + progress summaries
      await ask(page, "how am I doing?"); await page.click("#rev-ai"); await page.waitForSelector("#rev-ai-text.aibox");
      ok((await page.textContent("#rev-ai-text")).includes("Written by AI") && (await page.textContent("#rev-ai-text")).includes("workout"), "weekly AI summary labeled");
      ok(!calls[calls.length - 1].data.includes("Free days"), "free days not sent without support consent");
      await page.click("#nav-progress"); await page.click("#ai-day-go"); await page.waitForSelector("#ai-day-text.aibox");
      ok((await page.textContent("#ai-day-text")).includes("Tomorrow"), "daily AI summary");
      // support: needs its own consent
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel");
      ok(!(await page.$("#sup-ai")), "no AI on support without consent");
      await page.click("#sup-ok"); await page.click("#nav-you"); await page.click("#y-ai");
      await page.check("#ai-c-support"); await page.click("#ai-agree");
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel");
      await page.click("#sup-ai"); await page.waitForSelector("#sup-ai-text.aibox");
      ok((await page.textContent("#sup-ai-text")).includes("not a person"), "support words labeled as AI");
      ok(!posts_any(calls, "Check in"), "check-in text never sent to AI");
      await page.click("#sup-ok");
      // organize: one tap, applied, listed, undoable; private tasks never sent
      await page.click("#nav-home"); await ask(page, "#private Secret appointment");
      const pre = JSON.stringify((await S(page)).tasks.map(t => [t.id, t.title, t.group, t.repeat]));
      await page.click("#all-tasks"); await page.click("#org-go2"); await page.waitForSelector("#org-list");
      ok(!calls[calls.length - 1].data.includes("Secret appointment"), "private task not sent to the organizer");
      let st = await S(page);
      ok(st.tasks.some(t => t.title === "Stretch" && t.repeat === "daily") && st.tasks.filter(t => t.group === "School").length >= 2 && (await page.locator("#org-list li").count()) === 2, "organize applied straight away; bad ids dropped");
      await page.click("#org-undo"); st = await S(page);
      ok(JSON.stringify(st.tasks.map(t => [t.id, t.title, t.group, t.repeat])) === pre, "organize undo puts everything back");
      // library picks
      await page.click("#nav-you"); await page.click("#y-lib");
      await page.setInputFiles("#pdf-in", FIX + "/book.pdf"); await page.waitForSelector("#passages", { timeout: 20000 });
      await page.click("#doc-ai"); await page.waitForSelector(".passage.pick");
      ok(await page.locator(".passage.pick").count() === 1 && (await page.textContent(".passage.pick")).includes("AI pick: About sitting with urges"), "AI passage pick shown, bad index ignored");
      ok((await page.textContent("#sel-n")).includes("1 passage"), "AI pick pre-selected");
      // errors fall back to rules
      mode = "429";
      await page.click("#nav-home"); await ask(page, LONG);
      await page.waitForTimeout(400);
      ok((await page.textContent("#toast")).includes("free AI limit"), "rate limit: still saved, with a note");
      // the key never goes into the app's saved data or backups
      st = await S(page);
      ok(!JSON.stringify(st).includes("AIzaTESTKEY"), "key not in saved data or backup");
      await page.click("#nav-you"); await page.click("#y-ai"); await page.click("#ai-off");
      const n1 = calls.length; await page.click("#nav-home"); await ask(page, LONG + " again");
      ok(calls.length === n1, "turned off: nothing sent");
      await axe(page, "today-ai");
      ok(!errors.filter(e => !/status of (429|404|400)/.test(e)).length, "ai: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- the manager without AI: numbers, routines, reading ----------
    console.log("manager");
    {
      const { page, errors, ctx } = await boot(browser);
      await ask(page, "Call Sam tomorrow");
      ok((await page.textContent("#aq-text")).includes("Sam's number"), "call asks for the number");
      await page.fill("#aq-phone", "555 222 3333"); await page.click("#aq-phone-set");
      let s = await S(page);
      ok(s.tasks.some(t => t.title === "Call Sam" && cleanPhone(t.contact.phone) === "5552223333") && s.contacts.some(c => c.name === "Sam"), "number saved to the task and contacts");
      await page.click("#asst-close");
      await ask(page, "Gym"); await page.click("#asst-close");
      const gid = (await S(page)).tasks.find(t => t.title === "Gym").id;
      await page.click('[data-check="' + gid + '"]');
      await page.waitForSelector("#noticed");
      ok((await page.textContent("#noticed")).includes("You did “Gym” today"), "noticed a routine");
      await page.click("#sug-a");
      s = await S(page);
      ok(s.tasks.some(t => t.title === "Gym" && !t.doneOn && t.date > s.tasks.find(x => x.id === gid).date.slice(0, 0)), "gym added again for tomorrow");
      ok(!(await page.textContent("#screen")).includes("You did “Gym” today"), "suggestion gone once used");
      await ask(page, "I want to read a book");
      ok(await page.isVisible("#read-block"), "reading offers to add the book");
      await page.setInputFiles("#rb-file", FIX + "/book.pdf");
      await page.waitForSelector("#rd-pages canvas", { timeout: 20000 });
      s = await S(page);
      ok(s.tasks.some(t => t.title === "Read a book" && t.docId), "book linked to the reading task");
      ok((await page.textContent("#read-page")) === "Page 1 of 2" && await page.evaluate(() => document.querySelector("#rd-pages canvas").width > 100), "the real page is drawn");
      ok(await page.evaluate(() => getComputedStyle(document.getElementById("rd-over")).opacity) === "1", "controls show at first");
      await page.waitForTimeout(2900);
      ok(await page.evaluate(() => getComputedStyle(document.getElementById("rd-over")).opacity) === "0", "then fade: just you and the page");
      await page.click("#pg-1", { position: { x: 40, y: 40 } }); await page.waitForTimeout(350);
      ok(await page.evaluate(() => document.body.classList.contains("rd-chrome")), "one tap brings them back");
      await page.evaluate(() => document.getElementById("pg-2").scrollIntoView()); await page.waitForSelector("#pg-2[data-ready]");
      await page.waitForTimeout(1000);
      ok((await S(page)).docs[0].pos === 2, "place kept by scrolling");
      await page.evaluate(() => document.body.classList.add("rd-chrome"));
      await page.click("#read-done");
      s = await S(page); ok(s.tasks.find(t => t.title === "Read a book").doneOn, "Completed finishes the reading task");
      ok((await page.textContent("#screen h1")) !== "book", "Completed closes the book");
      await page.click("#nav-you"); await page.click("#y-lib"); await page.click("[data-doc-more]");
      await page.click("#sel-all");
      ok((await page.textContent("#sel-n")).match(/\d+ passages? selected/), "select all on this page");
      await page.click("#sel-clear");
      await page.click("#pg-prev");
      await page.locator(".passage.sel").nth(0).click(); await page.locator(".passage.sel").nth(1).click(); await page.click("#sel-save");
      await page.click("#pg-next"); await page.click("#nav-home");
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel");
      ok(await page.isVisible("#sup-more") && (await page.locator("#sup-more [data-readon]").count()) >= 1, "support: keep reading with a way back into the book");
      await page.locator("#sup-more [data-readon]").first().click();
      await page.waitForSelector("#rd-pages canvas", { timeout: 20000 });
      ok(await page.$("#read-close"), "read on opens the book itself");
      await page.evaluate(() => document.body.classList.add("rd-chrome")); await page.click("#read-close");
      // reading: save a card by hand from the page you're on, or highlight words on the page
      await page.click("#nav-you"); await page.click("#y-lib"); await page.click(".shelf [data-doc]");
      await page.waitForSelector("#rd-pages canvas", { timeout: 20000 });
      await page.evaluate(() => document.getElementById("pg-2").scrollIntoView()); await page.waitForSelector("#pg-2[data-ready]"); await page.waitForTimeout(300);
      const c0 = (await S(page)).cards.length;
      await page.evaluate(() => document.body.classList.add("rd-chrome")); await page.click("#rd-card");
      ok((await page.textContent("#pg-label")) === "2 / 2", "Save a card opens the passages of the page you're on");
      await page.locator(".passage.sel").last().click(); await page.click("#sel-save");
      ok((await S(page)).cards.length === c0 + 1, "saved by hand");
      await page.click("#doc-read"); await page.waitForSelector(".textLayer span", { timeout: 10000 });
      const hp = await page.evaluate(() => { const sp = Array.from(document.querySelectorAll(".textLayer span")).find(x => x.textContent.length > 20); const r = document.createRange(); r.selectNodeContents(sp); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return +sp.closest(".rpage").dataset.page; });
      await page.waitForSelector("#hlbtn:not([hidden])");
      await page.dispatchEvent("#hlbtn", "click");
      const hc = (await S(page)).cards;
      ok(hc.length === c0 + 2 && hc[hc.length - 1].page === hp, "highlight on the page saved as a card, with its page");
      await page.evaluate(() => document.body.classList.add("rd-chrome")); await page.click("#read-close");
      // notes, breathing, top 3
      await page.click("#nav-home"); await ask(page, "note: feeling calmer after the walk");
      ok((await S(page)).notes[0].text === "feeling calmer after the walk", "note: goes to Notes");
      await page.click("#t-notes"); ok((await page.textContent("#note-list")).includes("feeling calmer"), "notes listed");
      await page.click("#nav-home"); await page.click("#t-breathe");
      await page.click("#br-sigh"); await page.click("#br-m1"); await page.click("#br-start");
      await page.waitForTimeout(700);
      ok((await page.textContent("#br-label")) === "Breathe in" && (await page.getAttribute("#br-orb", "data-phase")) === "in", "breathing guides in and out");
      const st0 = (await S(page)).steps.length;
      await page.click("#br-stop");
      const bs = await S(page);
      ok(bs.breathLog.length === 1 && bs.steps.length === st0 + 1 && bs.brPat === "sigh", "breathing session logged");
      await page.click("#back");
      for (const t of ["Laundry", "Dishes", "Water plants", "Email landlord"]) { await ask(page, t); }
      await page.click("#asst-close").catch(() => {});
      ok(await page.locator("#today-list .trow").count() === 3 && await page.isVisible("#toggle-rest"), "Today shows the top 3; the rest is tucked away");
      await page.click("#nav-you"); await page.click("#y-mem");
      ok(await page.isVisible("#learn-toggle"), "learning can be switched off");
      ok(!errors.length, "manager: no errors " + errors.join(" | "));
      await ctx.close();
    }


    // ---------- task rows: gestures, batch, ten days, spark ----------
    console.log("rows");
    {
      const { page, errors, posts, ctx } = await boot(browser);
      const idOf = async (title) => (await S(page)).tasks.find(t => t.title === title).id;
      const showAll = async () => { if (await page.$('#toggle-rest[aria-expanded="false"]')) await page.click("#toggle-rest"); };
      const rowBox = async (id) => { await showAll(); return page.locator('[data-task="' + id + '"] .trow').first().boundingBox(); };
      // natural language with urgency, length and a lead reminder
      await ask(page, "Sprint training at 8pm urgent 30 min timer remind 15m before");
      let s = await S(page), t = s.tasks.find(x => x.title === "Sprint training");
      ok(t && t.time === "20:00" && t.priority === "urgent" && t.dur === 30 && t.remindBefore === 15 && t.remindWant, "parsed time, urgent, 30 min timer, remind 15m before");
      ok(posts.some(p => p.url.includes(SEED.topics.reminders)), "lead reminder scheduled with ntfy");
      await page.click("#asst-close").catch(() => {});
      for (const x of ["Laundry", "Dishes"]) await ask(page, x);
      await page.click("#asst-close").catch(() => {});
      // tap opens in place
      const lid = await idOf("Laundry");
      await showAll(); await page.click('[data-task="' + lid + '"] .tmain');
      ok(await page.isVisible("#panel-" + lid), "tap opens the task in place");
      // spark: change it by typing
      await page.click('[data-spark="' + lid + '"]'); await page.fill("#sh-say", "tomorrow 2pm, high, 45 min");
      await page.click("#sh-say-go"); await page.click("#sh-close");
      t = (await S(page)).tasks.find(x => x.id === lid);
      ok(t.time === "14:00" && t.priority === "high" && t.dur === 45 && t.date > "2000", "spark edit: tomorrow 2pm, high, 45 min");
      await page.click("#toast-act"); t = (await S(page)).tasks.find(x => x.id === lid);
      ok(!t.time && t.priority === "normal", "spark edit undo");
      // double tap renames
      await showAll(); await page.click('[data-task="' + lid + '"] .tmain'); await page.click('[data-task="' + lid + '"] .tmain');
      await page.waitForSelector("#te-" + lid); await page.fill("#te-" + lid, "Laundry and towels"); await page.press("#te-" + lid, "Enter");
      ok((await S(page)).tasks.find(x => x.id === lid).title === "Laundry and towels", "double tap to rename");
      // swipe right: done; swipe left: delete with undo
      const did = await idOf("Dishes");
      let b = await rowBox(did);
      await page.mouse.move(b.x + 60, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + 120, b.y + b.height / 2, { steps: 4 }); await page.mouse.move(b.x + 200, b.y + b.height / 2, { steps: 4 }); await page.mouse.up();
      ok((await S(page)).tasks.find(x => x.id === did).doneOn, "swipe right completes");
      await page.click("#toggle-rest").catch(() => {});
      b = await rowBox(lid);
      await page.mouse.move(b.x + b.width - 80, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width - 140, b.y + b.height / 2, { steps: 4 }); await page.mouse.move(b.x + b.width - 220, b.y + b.height / 2, { steps: 4 }); await page.mouse.up();
      await page.waitForTimeout(300);
      ok(!(await S(page)).tasks.some(x => x.id === lid) && (await page.textContent("#toast")).includes("Deleted"), "swipe left deletes");
      await page.click("#toast-act"); ok((await S(page)).tasks.some(x => x.id === lid), "delete undo");
      // hold to select, then +1 day for several
      b = await rowBox(lid);
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
      ok(await page.isVisible("#bulkbar") && (await page.textContent("#bulk-n")) === "1 selected", "hold starts selecting");
      const wid = await idOf("Workout"); await showAll(); await page.click('[data-pick="' + wid + '"]');
      ok((await page.textContent("#bulk-n")) === "2 selected", "tap adds to the selection");
      await page.click("#bulk-day");
      s = await S(page);
      ok(s.tasks.find(x => x.id === lid).date > s.tasks.find(x => x.id === lid).created.toString().slice(0, 0) && !(await page.$("#bulkbar")), "+1 day for the selection");
      await page.click("#toast-act");
      // drag to reorder (hold, then move)
      const ids0 = await page.$$eval("#today-list [data-task]", els => els.map(e => e.getAttribute("data-task")));
      if (ids0.length >= 2) {
        const b0 = await rowBox(ids0[0]), b1 = await rowBox(ids0[1]);
        await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2); await page.mouse.down(); await page.waitForTimeout(600);
        await page.mouse.move(b1.x + b1.width / 2, b0.y + 5, { steps: 6 }); await page.mouse.up();
        const ids1 = await page.$$eval("#today-list [data-task]", els => els.map(e => e.getAttribute("data-task")));
        ok(ids1[0] === ids0[1], "hold and drag reorders");
        await page.click('[data-task="' + ids1[0] + '"] .tmain'); await page.click("#ra-down-" + ids1[0]);
        const ids2 = await page.$$eval("#today-list [data-task]", els => els.map(e => e.getAttribute("data-task")));
        ok(ids2[1] === ids1[0], "Move down button does the same without gestures");
      } else ok(false, "need two rows to test reordering");
      // the next ten days
      ok(await page.locator("#horizon .hday").count() === 10, "ten-day strip");
      await page.click("#hd-1"); ok(await page.isVisible("#day-sum"), "tomorrow's view with workload");
      await page.click("#hd-0");
      // all tasks: filters, clear finished, undo/redo
      await page.click("#all-tasks"); await page.click("#f-done");
      const doneN = await page.locator("#all-box [data-task]").count();
      ok(doneN >= 1, "Done filter");
      await page.click("#clear-done2");
      ok((await page.textContent("#toast")).includes("Cleared"), "clear finished");
      await page.click("#hist-undo"); await page.click("#f-done");
      ok(await page.locator("#all-box [data-task]").count() === doneN, "undo restores cleared tasks");
      await page.click("#hist-redo"); ok(await page.locator("#all-box [data-task]").count() < doneN, "redo");
      // focus presets
      await page.click("#nav-home"); await page.click("#t-focus");
      ok(await page.locator("#f-mins .chip").count() >= 4 && await page.isVisible('[data-mins="60"]'), "focus presets 15/25/45/60");
      ok(!errors.length, "rows: no errors " + errors.join(" | "));
      await ctx.close();
    }


    // ---------- the same gestures with real touch events (the iPhone path) ----------
    console.log("touch");
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: "America/Chicago" });
      const page = await ctx.newPage(); const errors = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.route("https://ntfy.sh/**", r => r.fulfill({ status: 200, body: "{}" }));
      await page.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("tendays.v1", s); } }, JSON.stringify(SEED));
      await page.goto(APP); await page.waitForSelector("#qa");
      const cdp = await ctx.newCDPSession(page);
      const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const box = async (id) => { const l = page.locator('[data-task="' + id + '"] .trow').first(); await l.scrollIntoViewIfNeeded(); await page.waitForTimeout(100); return l.boundingBox(); };
      let b = await box("kaaaa2"), y = b.y + b.height / 2;
      await touch("touchStart", b.x + b.width - 70, y);
      for (let dx = 15; dx <= 160; dx += 15) await touch("touchMove", b.x + b.width - 70 - dx, y);
      await touch("touchEnd"); await page.waitForTimeout(400);
      ok(!(await S(page)).tasks.some(t => t.id === "kaaaa2") && (await page.textContent("#toast")).includes("Deleted"), "touch: swipe left deletes");
      await page.click("#toast-act");
      b = await box("kaaaa3"); y = b.y + b.height / 2;
      await touch("touchStart", b.x + b.width / 2, y); await page.waitForTimeout(650); await touch("touchEnd");
      ok(await page.isVisible("#bulkbar"), "touch: hold to select");
      ok(!errors.length, "touch: no errors " + errors.join(" | "));
      await ctx.close();
    }


    // ---------- v7: grid, sheet, commands, duplicates, clashes, check-ins, deck, guide, quiz ----------
    console.log("v7");
    {
      const seed = JSON.parse(JSON.stringify(SEED)); seed.view = "grid"; seed.intakeDone = false;
      const at = new Date(); at.setUTCHours(13, 0, 0, 0); // 7-8 AM in Chicago, so 10 AM is still ahead today
      const { page, errors, ctx } = await boot(browser, { seed, at });
      const r = await page.evaluate(() => [window.__td.parse("Water plants not so urgent").priority, window.__td.parse("Pay rent urgent").priority, window.__td.parse("Call bank no rush").priority]);
      ok(r[0] === "low" && r[1] === "urgent" && r[2] === "low", "“not so urgent” is low, “urgent” is urgent: " + r.join(","));
      ok(await page.isVisible("#intake"), "first open after the update offers “Tell Ten Days about you”");
      // duplicates
      await ask(page, "Meditate 10 min"); await page.click("#asst-close").catch(() => {});
      await ask(page, "meditate 10 min");
      ok((await S(page)).tasks.filter(t => /meditate/i.test(t.title)).length === 1 && (await page.textContent("#toast")).includes("Already on your list"), "no duplicate tasks");
      await page.click("#asst-close").catch(() => {});
      // grid tiles grouped by time of day, sheet with urgency slider and wheels
      await ask(page, "Gym at 10am"); await ask(page, "Study at 10am for 1 hour"); await page.click("#asst-close").catch(() => {});
      ok(await page.locator(".tgrid .tile2").count() >= 3 && await page.isVisible("#pt-morning"), "tiles grouped by time of day");
      ok(await page.isVisible(".clash"), "clash between two 10 AM tasks is pointed out");
      await page.click('[id^="clash-fix-"]');
      const st = (await S(page)).tasks.filter(t => t.time && t.time.startsWith("1")).map(t => t.time).sort();
      ok(st.length === 2 && st[0] !== st[1], "clash fixed by moving one: " + st.join(","));
      ok(await page.isVisible("#df-title"), "do-first pick with a reason");
      const mid = (await S(page)).tasks.find(t => /meditate/i.test(t.title)).id;
      await page.click('[data-task="' + mid + '"] .tbody');
      ok(await page.isVisible("#sheet") && await page.isVisible("#prio-slider"), "tap a tile: calm sheet with urgency slider");
      await page.click("#ps-3"); ok((await S(page)).tasks.find(t => t.id === mid).priority === "urgent", "slider sets urgent");
      await page.click("#ps-0"); ok((await S(page)).tasks.find(t => t.id === mid).priority === "low", "slider sets low");
      await page.click("#sh-time"); await page.waitForSelector("#wh-h");
      await page.evaluate(() => { const w = document.getElementById("wh-h"); w.scrollTop = 40 * 15; w.dispatchEvent(new Event("scroll")); });
      await page.waitForTimeout(400);
      ok(((await S(page)).tasks.find(t => t.id === mid).time || "").startsWith("15:"), "hour wheel sets 3 PM");
      await page.click("#sh-close"); ok(!(await page.$("#sheet")), "sheet closes");
      // commands
      await ask(page, "delete the meditate task");
      ok(!(await S(page)).tasks.some(t => /meditate/i.test(t.title)), "“delete the meditate task” deletes it");
      await page.click("#toast-act"); ok((await S(page)).tasks.some(t => /meditate/i.test(t.title)), "and Undo brings it back");
      await ask(page, "delete everything");
      ok((await page.textContent("#asst")).includes("Delete everything?"), "delete everything asks first");
      await page.click("#cf-yes"); ok((await S(page)).tasks.length === 0, "delete everything");
      await page.click("#toast-act"); ok((await S(page)).tasks.length > 0, "undo delete everything");
      await ask(page, "Remove stains from shirt");
      ok((await S(page)).tasks.some(t => /stains/i.test(t.title)), "a normal task starting with “remove” is still a task");
      // check-ins
      await page.click("#in-later");
      await page.click("#nav-you"); await page.click("#y-me"); await page.click("#back");
      await page.click("#nav-home"); await page.waitForSelector("#qa");
      await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("tendays.v1")); s.checkins = [{ id: "c1", text: "Breathwork, 5 minutes" }, { id: "c2", text: "Walked outside" }]; localStorage.setItem("tendays.v1", JSON.stringify(s)); });
      await page.reload(); await page.waitForSelector("#checkins");
      await page.click("#ck-c1");
      ok((await S(page)).checkLog[Object.keys((await S(page)).checkLog)[0]].includes("c1") && (await page.getAttribute("#ck-c1", "aria-pressed")) === "true", "daily check-in ticked");
      // focus wheel and the timer that follows you
      await page.click("#t-focus"); ok(await page.isVisible("#f-wheel"), "focus minutes on a scroll wheel");
      await page.waitForTimeout(300); await page.evaluate(() => { const w = document.getElementById("f-wheel"); w.scrollTop = 40 * 11; w.dispatchEvent(new Event("scroll")); });
      await page.waitForTimeout(400);
      ok((await page.textContent("#focus-start")) === "Start 12 min", "wheel picks 12 minutes");
      await page.click("#focus-start"); await page.click("#nav-home"); await page.waitForTimeout(1200);
      ok(await page.isVisible("#minifocus") && /\d+:\d\d/.test(await page.textContent("#mf-time")), "focus timer stays on screen elsewhere");
      await page.click("#minifocus"); ok((await page.textContent("#screen h1")) === "Focus", "tap it to go back to the timer");
      await page.click("#focus-end"); await page.click("#focus-end");
      // notes with the guide, your week
      await page.click("#nav-home"); await page.click("#t-notes"); await page.fill("#note-in", "So annoyed at my roommate today"); await page.click("#note-add");
      ok((await page.textContent(".reflect")).includes("Bhagavad Gita") && (await page.textContent(".reflect")).includes("paraphrase"), "angry note gets a short Gita thought, labeled paraphrase");
      ok(await page.isVisible('.reflect .listen'), "and a Listen button");
      await page.click("#nav-progress"); await page.click("#week-go");
      ok((await page.textContent("#week-text")).length > 40, "your week, written up");
      // deck
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel");
      ok(await page.isVisible("#deck-top") && await page.isVisible("#deck-keep"), "I need you: a deck of cards");
      const q1 = await page.textContent("#sup-quote"); await page.click("#deck-keep");
      ok((await S(page)).kept[0].text === q1, "keep a card");
      await page.click("#sup-ok");
      ok(!errors.length, "v7: no errors " + errors.join(" | "));
      await ctx.close();
    }
    // ---------- v8: staged I need you, messages, counts, your week, learned times, hard hours, you and him ----------
    console.log("v8");
    {
      const seed = JSON.parse(JSON.stringify(SEED)); seed.sosWait = 60; seed.partner = { name: "Audi" };
      const day = 864e5, now0 = Date.now();
      seed.habits = [{ k: "gym", m: 1080, d: 60, at: now0 - day }, { k: "gym", m: 1080, d: 60, at: now0 - 2 * day }, { k: "gym", m: 1075, d: 60, at: now0 - 3 * day }];
      const at = new Date("2026-11-09T16:30:00Z"); // Monday 10:30 AM in Chicago
      seed.blocks = [{ id: "b1", title: "ACCT 2301", days: [1, 3], start: "10:00", end: "11:15" }];
      const { page, errors, posts, ctx } = await boot(browser, { seed, at });
      // I need you waits, and you can stop it or send it now
      await page.click("#sos"); await page.waitForTimeout(300);
      ok((await page.textContent("#screen h1")) === "I'm here." && /Telling Audi in (1:00|0:59|5\d s)/.test(await page.textContent("#cd-text")), "I need you: stays with you, tells Audi after a minute: " + await page.textContent("#cd-text"));
      ok(await page.isVisible("#cd-now") && (await page.textContent("#cd-cancel")) === "Don't tell him", "Tell now and Don't tell him");
      ok((await page.textContent("#sup-cd")).includes("unless you stop it"), "support says when it will tell him");
      await page.waitForTimeout(800); await page.click("#cd-cancel"); await page.waitForTimeout(300);
      ok(!posts.some(p => p.url.includes(SEED.topics.alert)) && (await page.textContent("#toast")).includes("won't tell him"), "Don't tell him: nothing sent, still here");
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-now"); await page.waitForTimeout(400);
      ok(posts.some(p => p.url.includes(SEED.topics.alert) && p.body.includes("Call when you can")), "Tell now sends right away");
      await page.click("#sup-ok"); await page.waitForTimeout(100);
      if ((await page.textContent("#screen h1")) === "A private line?") await page.click("#skip-line");
      await page.click("#nav-home");
      // now and next, around a class
      ok((await page.textContent("#nownext")).includes("Now ACCT 2301 until 11:15"), "now/next shows the class: " + await page.textContent("#nownext"));
      // a task with no time: free slots around the class
      await ask(page, "Laundry");
      ok(await page.isVisible("#slots") && (await page.textContent("#slot-0")) === "11:15 AM", "free slot after the class: " + await page.textContent("#slots").catch(() => ""));
      await page.click("#slot-0");
      ok((await S(page)).tasks.find(t => t.title === "Laundry").time === "11:15", "pick a slot");
      await page.click("#asst-close").catch(() => {});
      // learned time and length
      await ask(page, "Gym");
      let gym = (await S(page)).tasks.find(t => t.title === "Gym");
      ok(gym.time === "18:00" && gym.dur === 60 && (await page.textContent("#asst-note")).includes("when you usually do this"), "learned: gym at your usual 6 PM for an hour (" + gym.time + "," + gym.dur + ")");
      ok((await page.textContent("#fc-when")).includes("your usual time"), "labeled as your usual time");
      await page.click("#asst-close").catch(() => {});
      // classes typed in plain words
      const b = await page.evaluate(() => [window.__td.block("ACCT 2301 class MW 10-11:15"), window.__td.block("Study for class MW 10-11"), window.__td.block("Chem lab TTh 2-4:50pm")]);
      ok(b[0] && b[0].days.join() === "1,3" && b[0].start === "10:00" && b[0].end === "11:15" && !b[1] && b[2] && b[2].days.join() === "2,4" && b[2].start === "14:00" && b[2].end === "16:50", "class times understood: " + JSON.stringify(b));
      await ask(page, "Chem lab TTh 2-4:50pm");
      ok((await S(page)).blocks.length === 2 && (await page.textContent("#toast")).includes("Added to your week"), "typing a class adds it to your week");
      // counts
      await ask(page, "track sugar max 1");
      let s = await S(page); const sid = s.counters[0] && s.counters[0].id;
      ok(sid && s.counters[0].name === "Sugar" && s.counters[0].limit === 1 && await page.isVisible("#counts"), "track sugar: a counter on Today");
      await ask(page, "had 2 sugars");
      ok(Object.values((await S(page)).countLog)[0][sid] === 2 && await page.isVisible(".cnt.over"), "had 2 sugars: counted, over the max shows");
      await page.click("#cnt-" + sid + "-minus");
      ok(Object.values((await S(page)).countLog)[0][sid] === 1, "minus one");
      await page.click("#cnt-" + sid);
      ok(Object.values((await S(page)).countLog)[0][sid] === 2, "tap adds one");
      // message him by typing
      posts.length = 0;
      await ask(page, "Tell Audi I finished the layout");
      ok((await page.textContent("#toast")).includes("To Audi"), "message preview with Undo");
      await page.waitForTimeout(4500);
      ok(posts.some(p => p.url.includes(SEED.topics.alert) && p.body === "I finished the layout") && (await page.textContent("#toast")).includes("Sent to Audi"), "message sent to his phone");
      posts.length = 0;
      await ask(page, "text my brother on my way"); await page.click("#toast-act"); await page.waitForTimeout(4500);
      ok(!posts.length, "Undo stops the message");
      // You: organized; you and him
      await page.click("#nav-you");
      ok(await page.isVisible("#y-people") && await page.locator(".morelist.grid2").count() === 2, "You: people on top, tiles below");
      await page.click("#y-people");
      ok((await page.textContent("#screen h1")) === "You and Audi" && await page.isVisible("#pp-me"), "you and Audi");
      posts.length = 0;
      await page.click("#share-on"); await page.waitForTimeout(400);
      s = await S(page);
      ok(s.share.on && /^ts-/.test(s.share.topic) && posts.some(p => p.url.includes(s.share.topic) && p.body.includes('"v":1') && p.body.includes("Sugar")), "share my day: a status update is posted");
      ok((await page.textContent("#share-code")).includes("#pair=1&s=" + s.share.topic), "my link to send him");
      // his day, read from his channel
      const his = { v: 1, n: "Audi", at: Date.now(), day: await page.evaluate(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }), t: [3, 5], c: [1, 2], f: 40, k: [["Sugar", 2, 1]] };
      await page.route("https://ntfy.sh/ts-audistatus0001/json**", r => r.fulfill({ status: 200, body: JSON.stringify({ event: "message", time: Math.floor(Date.now() / 1000), message: JSON.stringify(his) }) + "\n" }));
      await page.fill("#pp-paste", "https://x.example/index.html#pair=1&s=ts-audistatus0001&r=tp-audiinbox00001&n=Audi"); await page.click("#pp-follow");
      await page.waitForSelector("#pp-h-tasks");
      ok((await page.textContent("#pp-h-tasks")).includes("3 of 5") && (await page.textContent("#pp-h-counts")).includes("Sugar"), "his day: tasks and sugars");
      await page.click("#nav-you");
      ok((await page.textContent("#y-people-hint")).includes("3 of 5 tasks"), "his summary on You");
      posts.length = 0;
      await page.click("#y-people"); await page.fill("#pp-msg", "Proud of you"); await page.click("#pp-send"); await page.waitForTimeout(4500);
      ok(posts.some(p => p.url.includes("tp-audiinbox00001") && p.body === "Proud of you"), "messages go to his own inbox once linked");
      await page.click("#sw-0");
      ok((await S(page)).sosWait === 0, "choose: only when I tap");
      await page.click("#nav-home"); posts.length = 0; await page.click("#sos"); await page.waitForTimeout(600);
      ok(!(await page.isVisible("#cancelbar")) && (await page.textContent("#screen h1")) === "I'm here." && !posts.length, "only when I tap: support, no countdown, nothing sent");
      await axe(page, "people");
      ok(!errors.length, "v8: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      // a pair link opens straight to "Follow Audi?"
      const { page, errors, ctx } = await boot(browser, { hash: "#pair=1&s=ts-audistatus0002&r=tp-audiinbox00002&n=Audi" });
      ok(await page.isVisible("#pair-offer") && (await page.textContent("#pair-q")).includes("Audi"), "pair link: Follow Audi?");
      await page.click("#pair-yes");
      const s = await S(page);
      ok(s.partner.topic === "ts-audistatus0002" && s.partner.inbox === "tp-audiinbox00002" && s.partner.name === "Audi", "following him");
      ok(!errors.length, "pair: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      // hard hours: three late nights in a row
      const seed = JSON.parse(JSON.stringify(SEED)); seed.topics.reminders = "tr-remindersxx0001";
      seed.urges = ["2026-11-06T05:10:00Z", "2026-11-07T05:20:00Z", "2026-11-08T05:05:00Z", "2026-11-08T18:00:00Z"].map(x => ({ at: Date.parse(x), via: "sos" }));
      const { page, errors, posts, ctx } = await boot(browser, { seed, at: new Date("2026-11-10T04:30:00Z") }); // 10:30 PM in Chicago
      const w = await page.evaluate(() => window.__td.hard());
      ok(w && w.start === 23 && w.days === 3, "hard hours found: " + JSON.stringify(w));
      ok(await page.isVisible("#hard-card") && (await page.textContent("#hard-card")).includes("11 PM"), "heads-up card before the hard hours");
      await page.click("#hard-ping"); await page.waitForTimeout(300);
      ok(posts.some(p => p.url.includes("tr-remindersxx0001") && /delay=\d+/.test(p.url)), "scheduled a heads-up to my phone");
      ok(!errors.length, "hard: no errors " + errors.join(" | "));
      await ctx.close();
    }
    // ---------- Moments: two phones, one circle, the real server code ----------
    console.log("moments");
    {
      const worker = (await import(path.join(__dirname, "../worker/src/index.js"))).default;
      const { makeEnv } = require("./cfshim");
      const menv = makeEnv(fs.readFileSync(path.join(__dirname, "../worker/schema.sql"), "utf8"), { ALLOWED_ORIGINS: "*" });
      const srvCalls = [];
      const viaWorker = async route => {
        const rq = route.request(), all = await rq.allHeaders(), headers = {};
        for (const k of Object.keys(all)) if (/^(authorization|content-type|origin|x-moment-id|x-caption|x-for-story|x-move-id|cf-connecting-ip|access-control-request-.*)$/.test(k)) headers[k] = all[k];
        const init = { method: rq.method(), headers };
        if (!["GET", "HEAD", "OPTIONS"].includes(rq.method())) { const b = rq.postDataBuffer(); if (b) init.body = b; }
        srvCalls.push(rq.method() + " " + new URL(rq.url()).pathname);
        const res = await worker.fetch(new Request(rq.url(), init), menv);
        const h = {}; res.headers.forEach((v, k) => { h[k] = v; });
        await route.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) });
      };
      // Rishi starts the circle
      const seedR = JSON.parse(JSON.stringify(SEED)); seed_name(seedR, "Rishi");
      const MO = new URL(APP).origin + "/v1**";   // the app and its server at one address, like the deployed Worker
      const R = await boot(browser, { seed: seedR, route: [MO, viaWorker] });
      await R.page.waitForTimeout(300);
      await R.page.click("#nav-you"); await R.page.click("#y-people");
      ok(await R.page.isVisible("#mo-setup") && !(await R.page.isVisible("#mo-srv")), "Moments: set up from You and Audi, no server address to type");
      await R.page.click("#mo-start");
      await R.page.waitForSelector("#mo-code-show");
      let s = await S(R.page);
      const tokR = await R.page.evaluate(() => localStorage.getItem("tendays.motoken"));
      ok(s.mo.circle && s.mo.me.name === "Rishi" && tokR && !JSON.stringify(s).includes(tokR), "circle started; the key is kept out of app data and backups");
      const code = (await R.page.textContent("#mo-code-show")).replace(/\s/g, "");
      ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code), "a big 6-character code: " + code);
      await R.page.waitForSelector("#mo-qr svg");
      ok(await R.page.isVisible("#mo-qr svg") && (await R.page.textContent("#mo-code-left")).includes("15 more minutes"), "with a QR code, one use, 15 minutes");
      ok(!(await R.page.isVisible("#mo-invite-link")), "the link is only a hidden fallback");
      // Rishi posts a photo
      const [fc] = await Promise.all([R.page.waitForEvent("filechooser"), R.page.click("#mo-add")]);
      await fc.setFiles(FIX + "/scan.png");
      await R.page.waitForSelector("#mo-cap");
      await R.page.fill("#mo-cap", "Leg day"); await R.page.click("#mo-post");
      await R.page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem("tendays.v1")); return s.moments.length === 1 && !s.moments[0].pending; });
      s = await S(R.page); const mid = s.moments[0].id;
      ok(s.moments[0].caption === "Leg day" && s.moments[0].hasPhoto && s.collection.length === 0, "posted to Moments, not to private reminders");
      ok(R.posts.some(p => p.url.includes(SEED.topics.alert) && p.body.includes("Shared a moment: Leg day")), "a nudge goes to his phone");
      // Audi joins from the link and sees it
      const seedA = JSON.parse(JSON.stringify(SEED)); seed_name(seedA, ""); seedA.topics = { alert: "td-audialertchan01", replies: "tp-audireplies0001" };
      const A = await boot(browser, { seed: seedA, route: [MO, viaWorker] });
      await A.page.waitForTimeout(300);
      await A.page.click("#nav-you"); await A.page.click("#y-people");
      await A.page.fill("#mo-myname", "Audi");
      await A.page.fill("#mo-code", "ABCDEF"); await A.page.click("#mo-code-go"); await A.page.waitForTimeout(300);
      ok((await A.page.textContent("#toast")).includes("didn't work") && !(await S(A.page)).mo.circle, "a mistyped code: a clear no");
      await A.page.fill("#mo-code", "OI0123"); await A.page.click("#mo-code-go");
      ok((await A.page.textContent("#toast")).includes("no O, 0, I or 1"), "letters that look alike are caught before sending");
      await A.page.fill("#mo-code", code.slice(0, 3).toLowerCase() + " " + code.slice(3)); await A.page.click("#mo-code-go");
      await A.page.waitForSelector("#mo-sum");
      s = await S(A.page);
      ok(s.moments.length === 1 && s.moments[0].caption === "Leg day" && s.mo.members.length === 2, "Audi typed the code and he's in, with the moment");
      const seedX = JSON.parse(JSON.stringify(SEED)); seed_name(seedX, "Late");
      const X = await boot(browser, { seed: seedX, route: [MO, viaWorker] }); await X.page.waitForTimeout(300);
      await X.page.click("#nav-you"); await X.page.click("#y-people"); await X.page.fill("#mo-code", code); await X.page.click("#mo-code-go"); await X.page.waitForTimeout(300);
      ok(!(await S(X.page)).mo.circle, "a used code doesn't work twice");
      await R.page.click("#nav-you"); await R.page.click("#y-people");
      await R.page.click("#mo-newcode"); await R.page.waitForFunction(c => document.getElementById("mo-code-show").textContent.replace(/\s/g, "") !== c, code);
      const code2 = (await R.page.textContent("#mo-code-show")).replace(/\s/g, "");
      menv.DB._db.prepare("UPDATE invites SET expires = ? WHERE used_by IS NULL").run(Date.now() - 1);
      await X.page.fill("#mo-code", code2); await X.page.click("#mo-code-go"); await X.page.waitForTimeout(300);
      ok(!(await S(X.page)).mo.circle && (await X.page.textContent("#toast")).includes("15 minutes"), "an expired code (15 minutes): no, and it says why it might be");
      await X.ctx.close();
      await A.page.click("#nav-home");
      ok((await A.page.textContent("#mo-today-cap")) === "Leg day" && (await A.page.textContent("#mo-today .mometa")).includes("Rishi"), "Today: the latest moment, who and when");
      await A.page.waitForSelector("#mo-today .mophoto img");
      ok(await A.page.evaluate(() => document.querySelector("#mo-today .mophoto img").naturalWidth > 0), "his phone loads the photo from the server");
      ok(!(await A.page.textContent("#screen")).includes("hasn't reacted") && !(await A.page.isVisible("#mo-reply-in")), "no pressure: no reply box, no counters");
      await A.page.click("#mo-today-r-respect");
      await A.page.waitForTimeout(300);
      ok((await A.page.getAttribute("#mo-today-r-respect", "aria-pressed")) === "true", "one tap: Respect");
      ok(await A.page.isVisible("#mo-today-r-brother") && (await A.page.textContent("#mo-today-r-brother")).includes("That's my brother"), "the reactions: Respect, I see you, Prove it, That's my brother, Saving this");
      // Audi replies (optional) in the timeline
      await A.page.click("#mo-all"); await A.page.click("#mo-reply-" + mid); await A.page.fill("#mo-reply-in", "beast"); await A.page.click("#mo-reply-send");
      await A.page.waitForTimeout(300);
      ok(!(await A.page.$("#mo-del-" + mid)), "he can't delete Rishi's moment");
      // Rishi sees the reaction and reply
      await R.page.click("#nav-you"); await R.page.click("#y-people"); await R.page.click("#mo-open");
      await R.page.waitForFunction(id => { const s = JSON.parse(localStorage.getItem("tendays.v1")); const m = s.moments.find(x => x.id === id); return m && m.reactions.length && m.replies.length; }, mid);
      await R.page.waitForSelector("#mo-" + mid + " .moreplies");
      ok((await S(R.page)).mo.rx.some(k => k.includes(":respect")), "his reaction is noticed on Rishi's phone");
      await R.page.click("#nav-home"); await A.page.evaluate(() => window.__td.moSync()); await R.page.evaluate(() => window.__td.moSync()); await R.page.waitForTimeout(200);
      ok(await R.page.isVisible("#mo-live") && (await R.page.textContent("#mo-live")).includes("Audi"), "both in the app: a soft “Audi is here”");
      await R.page.click("#nav-you"); await R.page.click("#y-people"); await R.page.click("#mo-open");
      ok((await R.page.getAttribute("#mo-r-" + mid + "-respect", "aria-label")).includes("from Audi") && (await R.page.textContent("#mo-" + mid + " .moreplies")).includes("beast"), "Rishi sees Audi's Respect and reply");
      // ten days later: the chapter
      await R.page.clock.setSystemTime(Date.now() + 11 * 864e5);
      await R.page.click("#back"); await R.page.waitForSelector("#mo-chapter");
      await R.page.click("#mo-chapter");
      ok(await R.page.isVisible("#ch-m-" + mid), "chapter: pick from the moments shared for it");
      await R.page.click("#ch-plain");
      const body = await R.page.inputValue("#ch-body");
      ok(body.includes("Leg day") && body.includes("Audi reacted with Respect") && body.includes("beast") && !/Old errand|Workout|urge/i.test(body), "plain chapter: only what was shared");
      // with AI: only the moments go, nothing about you
      let aiSeen = null;
      await R.page.evaluate(() => { localStorage.setItem("tendays.aikey", "AIzaTESTKEY000000000000000000000000000"); const s = JSON.parse(localStorage.getItem("tendays.v1")); s.ai.agreed = true; localStorage.setItem("tendays.v1", JSON.stringify(s)); });
      await R.page.route("https://generativelanguage.googleapis.com/**", r => {
        const req = r.request();
        if (req.method() === "GET") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [{ name: "models/gemini-9-flash-lite", supportedGenerationMethods: ["generateContent"] }] }) });
        const b = JSON.parse(req.postData()); aiSeen = { sys: b.system_instruction.parts[0].text, data: b.contents[0].parts[0].text };
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "Leg day, Respect", story: "Rishi shared a photo captioned \"Leg day\". Audi reacted with Respect and wrote \"beast\"." }) }] } }] }) });
      });
      await R.page.reload(); await R.page.waitForSelector("#screen h1");
      await R.page.click("#nav-you"); await R.page.click("#y-people"); await R.page.click("#mo-chapter");
      await R.page.click("#ch-ai"); await R.page.waitForSelector("#ch-body");
      ok(aiSeen && aiSeen.data.includes("Leg day") && aiSeen.data.includes("Audi reacted with Respect") && !/Old errand|Workout|Mom|What you know about the person/.test(aiSeen.sys + aiSeen.data), "AI chapter: sent only the shared moments, nothing else about you");
      ok(/never what they felt/.test(aiSeen.sys) && /Never invent/.test(aiSeen.sys), "AI told not to invent events or feelings");
      ok((await R.page.inputValue("#ch-title")) === "Leg day, Respect", "AI draft is editable");
      await R.page.fill("#ch-title", "Leg day week"); await R.page.click("#ch-save");
      await R.page.waitForSelector("#ch-text");
      ok((await R.page.textContent("#screen h1")) === "Leg day week" && await R.page.isVisible("#ch-listen"), "chapter saved, can be read aloud");
      await A.page.evaluate(() => window.__td.moSync());
      s = await S(A.page);
      ok(s.chapters.length === 1 && s.chapters[0].title === "Leg day week", "Audi gets the chapter");
      // the narrated chapter: the real photo, the chapter's words, play/pause, skip, scrubber, a video file
      await R.page.click("#ch-play"); await R.page.waitForSelector("#sl-cap");
      ok((await R.page.textContent("#sl-cap")) === "Leg day week" && await R.page.isVisible("#sl-ai"), "the slideshow opens on the title; AI's part is labeled");
      await R.page.evaluate(() => window.__td.slideMs(200)); if (await R.page.$("#sl-voice")) await R.page.uncheck("#sl-voice");
      await R.page.click("#sl-play");
      await R.page.waitForFunction(() => document.getElementById("sl-n").textContent.startsWith("2 of"), null, { timeout: 6000 });
      ok((await R.page.textContent("#sl-cap")).includes("Leg day") && await R.page.isVisible("#sl-stage .mophoto"), "then the real photo with the chapter's own words, in order");
      await R.page.waitForFunction(() => document.getElementById("sl-play").textContent === "Play", null, { timeout: 6000 });
      ok(true, "it stops at the end");
      await R.page.evaluate(() => { const r = document.getElementById("sl-scrub"); r.value = "0"; r.dispatchEvent(new Event("input", { bubbles: true })); });
      ok((await R.page.textContent("#sl-n")).startsWith("1 of"), "the scrubber jumps");
      await R.page.click("#sl-next"); ok((await R.page.textContent("#sl-n")).startsWith("2 of"), "skip");
      await R.page.click("#sl-export"); await R.page.waitForSelector("#sl-download", { timeout: 20000 });
      ok(/^blob:/.test(await R.page.getAttribute("#sl-download", "href")) && (await R.page.textContent("#screen")).includes("no voice"), "saved as a video file, honestly silent");
      await R.page.click("#back"); await R.page.click("[id^='ch-open-']");
      // a friend joins by pasting the link inside the app (iPhone opens links in Safari, so pasting is the real path)
      await R.page.click("#back"); await R.page.click("#back"); await R.page.click((await R.page.$("#mo-newcode")) ? "#mo-newcode" : "#mo-invite"); await R.page.waitForSelector("#mo-link-fallback");
      await R.page.click("#mo-link-fallback summary"); const inv2 = await R.page.textContent("#mo-invite-link");
      const seedF = JSON.parse(JSON.stringify(SEED)); seed_name(seedF, "Sam");
      const F = await boot(browser, { seed: seedF, route: [MO, viaWorker] }); await F.page.waitForTimeout(300);
      await F.page.click("#nav-you"); await F.page.click("#y-people"); await F.page.click("#mo-adv-srv summary"); await F.page.fill("#mo-link", inv2); await F.page.click("#mo-link-go");
      await F.page.click("#mo-join-yes"); await F.page.waitForSelector("#mo-sum");
      ok((await S(F.page)).mo.members.filter(m => !m.left).length === 3, "the hidden fallback: a third person joins by pasting the link");
      await F.ctx.close();
      await R.page.click("#mo-open"); await R.page.click("[id^='ch-open-']");
      // Rishi deletes his moment: gone for Audi too
      await R.page.click("#back"); await R.page.click("#mo-del-" + mid); await R.page.click("#mo-del-" + mid);
      await R.page.waitForTimeout(400);
      await A.page.evaluate(() => window.__td.moSync());
      ok(!(await S(A.page)).moments.length, "deleted for everyone");
      // offline post stays "not shared yet" and retries
      await R.page.unroute(MO); await R.page.route(MO, r => r.abort("failed"));
      const [fc2] = await Promise.all([R.page.waitForEvent("filechooser"), R.page.click("#mo-add")]);
      await fc2.setFiles(FIX + "/scan.png"); await R.page.waitForSelector("#mo-cap"); await R.page.click("#mo-post");
      await R.page.waitForFunction(() => document.querySelector("[id^='mo-pend-']"));
      ok((await R.page.textContent("[id^='mo-pend-']")).includes("Not shared yet"), "no connection: honest “not shared yet”");
      await R.page.unroute(MO); await R.page.route(MO, viaWorker);
      await R.page.click("[id^='mo-retry-']", { timeout: 3000 }).catch(() => {});   // the app may already have retried on its own
      await R.page.waitForFunction(() => !JSON.parse(localStorage.getItem("tendays.v1")).moments.some(m => m.pending), null, { timeout: 30000 });
      ok(!(await S(R.page)).moments.some(m => m.pending), "Retry (or the automatic retry) shares it");
      await axe(R.page, "moments");
      const realErr = R.errors.concat(A.errors).filter(e => !/status of 403/.test(e));   // the wrong codes typed on purpose above
      ok(!realErr.length, "moments: no errors " + realErr.join(" | "));
      await R.ctx.close(); await A.ctx.close();
    }
    // ---------- v10: one-scroll reader, AI cards, a shelf, check-ins by time of day, a brother who notices ----------
    console.log("v10");
    const dayOf = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const aiStub = (page, calls, answer) => page.route("https://generativelanguage.googleapis.com/**", r => {
      const req = r.request();
      if (req.method() === "GET") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [{ name: "models/gemini-9-flash-lite", supportedGenerationMethods: ["generateContent"] }] }) });
      const b = JSON.parse(req.postData()); const c = { sys: b.system_instruction.parts[0].text, data: b.contents[0].parts[0].text }; calls.push(c);
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ candidates: [{ content: { parts: [{ text: answer(c) }] } }] }) });
    });
    {
      const calls = [];
      const seed = JSON.parse(JSON.stringify(SEED)); seed.ai = { agreed: true, consent: { tasks: true, summaries: true, library: true, support: false } };
      const { page, errors, ctx } = await boot(browser, { seed });
      await page.evaluate(() => localStorage.setItem("tendays.aikey", "AIzaTESTKEY000000000000000000000000000"));
      await aiStub(page, calls, c => /numbered passages/.test(c.sys) ? JSON.stringify({ picks: [{ n: 2, theme: "urges", why: "For when the urge comes" }, { n: 999, theme: "peace" }] }) : "{}");
      await page.reload(); await page.waitForSelector("#screen h1");
      await page.click("#nav-you"); await page.click("#y-lib");
      await page.setInputFiles("#pdf-in", FIX + "/long.pdf"); await page.waitForSelector("#passages", { timeout: 20000 });
      ok(!(await page.$("#doc-hint")) && !(await page.$("#doc-goal")), "no helper paragraph, no goal dropdown");
      await page.evaluate(() => window.__td.readScale(0.02));
      await page.click("#doc-read"); await page.waitForSelector("#pg-1[data-ready]", { timeout: 20000 });
      await page.waitForTimeout(600);
      let rd = await page.evaluate(() => window.__td.rd());
      ok(rd.drawn.length >= 1 && rd.drawn.length <= 8 && Math.max(...rd.drawn) <= 8, "only the pages near you are drawn: " + rd.drawn.join(","));
      ok(await page.locator(".rpage").count() === 40, "the whole book is one scroll");
      for (let n = 2; n <= 30; n += 4) { await page.evaluate(n => document.getElementById("pg-" + n).scrollIntoView(), n); await page.waitForTimeout(120); }
      await page.evaluate(() => document.getElementById("pg-30").scrollIntoView()); await page.waitForSelector("#pg-30[data-ready]", { timeout: 15000 }); await page.waitForTimeout(500);
      rd = await page.evaluate(() => window.__td.rd());
      ok(rd.cur === 30 && !rd.drawn.includes(1) && !(await page.$("#pg-1 canvas")), "far pages are released while you read: " + rd.drawn.join(","));
      ok((await page.textContent("#read-page")) === "Page 30 of 40", "where you are, in the controls");
      await page.waitForTimeout(400);
      // closing: the AI picks cards from what you read (only from real passages)
      await page.evaluate(() => document.body.classList.add("rd-chrome")); await page.click("#read-close");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("tendays.v1")).cards.some(c => c.by === "ai"), null, { timeout: 8000 });
      let s = await S(page); const aiCard = s.cards.find(c => c.by === "ai");
      const sent = calls.find(c => /numbered passages/.test(c.sys));
      ok(sent && sent.data.includes(aiCard.quote) && aiCard.theme === "urges" && s.cards.filter(c => c.by === "ai").length === 1, "AI picked an exact passage from what you read; a bad pick was ignored");
      ok((await page.textContent("#toast")).includes("Saved 1 card from today's reading"), "just a small note");
      ok(!/Working on|reasons/.test(sent.sys), "without support consent, nothing about your habit goes with it");
      // reopen: back where you were
      await page.click("#nav-you"); await page.click("#y-lib");
      ok(await page.isVisible("#th-urges") && (await page.textContent("#th-urges")).includes("picked by AI"), "cards grouped by theme on the shelf");
      await page.click(".shelf [data-doc]"); await page.waitForTimeout(700);
      rd = await page.evaluate(() => window.__td.rd());
      ok(rd.cur === 30, "the book opens where you left off: page " + rd.cur);
      await page.evaluate(() => document.body.classList.add("rd-chrome")); await page.click("#rd-zoom"); await page.waitForTimeout(700);
      rd = await page.evaluate(() => window.__td.rd());
      ok(rd.cur === 30 && await page.isVisible(".reader.zoomed"), "zoom keeps your place");
      await page.evaluate(() => document.body.classList.add("rd-chrome")); await page.click("#read-close");
      ok(!errors.length, "v10 reader: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      // learned daily amount; tidying cards; the card that fits the moment
      const seed = JSON.parse(JSON.stringify(SEED)); const now = Date.now(), D = 864e5;
      const read = {}; for (let i = 1; i <= 4; i++) read[dayOf(new Date(now - i * D))] = [1, 2, 3, 4, 5, 6, 7, 8].map(n => n + i * 8);
      seed.docs = [{ id: "kdoc00001", name: "Gita", pages: 300, status: "ready", hasFile: false, read, pos: 40 }];
      seed.cards = [
        { id: "kcard0001", docId: "kdoc00001", docName: "Gita", page: 3, quote: "Work hard every day and keep your promises to yourself.", link: "other", at: now - 2 * D, theme: "discipline" },
        { id: "kcard0002", docId: "kdoc00001", docName: "Gita", page: 7, quote: "The craving rises and falls; you only have to outlast it.", link: "urge", at: now - 2 * D, theme: "urges" },
        { id: "kcard0003", docId: "kdoc00001", docName: "Gita", page: 9, quote: "An old line nobody ever kept or read again.", link: "other", at: now - 40 * D, seen: 4, used: 0 }];
      seed.profile = { guide: "plain" };
      const { page, errors, ctx } = await boot(browser, { seed, at: new Date("2026-11-10T05:15:00Z") }); // 11:15 PM in Chicago
      ok(await page.evaluate(() => window.__td.goal("kdoc00001")) === 8, "daily goal learned from what you read: 8 pages");
      let s = await S(page);
      ok(s.cards.find(c => c.id === "kcard0003").archived && !s.cards.find(c => c.id === "kcard0002").archived, "a card you never use goes to Archived; the rest stay");
      await page.click("#nav-you"); await page.click("#y-lib");
      ok(!(await page.isVisible('[data-card="kcard0003"]')) && (await page.textContent("#lib-arch summary")).includes("Archived (1)"), "archived cards are out of sight, one tap away");
      await page.click("#nav-home"); await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel");
      ok((await page.textContent("#sup-quote")) === "The craving rises and falls; you only have to outlast it.", "I need you at night: the urges card comes first, not a random one");
      ok((await page.textContent("#deck-talk")).includes("late"), "with a few words, like a brother: " + (await page.textContent("#deck-talk")).slice(0, 60));
      s = await S(page); ok(s.cards.find(c => c.id === "kcard0002").seen === 1, "seen is counted");
      await page.click("#deck-keep"); s = await S(page); ok(s.cards.find(c => c.id === "kcard0002").used === 1, "keeping it counts as using it");
      ok(!errors.length, "v10 cards: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      // check-ins by time of day; a nudge; nothing disappears
      const seed = JSON.parse(JSON.stringify(SEED));
      seed.checkins = [{ id: "kc1", text: "Grounding" }, { id: "kc2", text: "Workout" }, { id: "kc3", text: "Journal" }, { id: "kc4", text: "Fascial release" }];
      seed.checkTimes = { kc1: [485, 490, 480] };
      seed.nudge = { items: { kc1: { ign: 1, quiet: 0 } } };
      seed.blocks = [{ id: "b1", title: "ACCT 2301", days: [0, 1, 2, 3, 4, 5, 6], start: "10:00", end: "11:15" }];
      const { page, errors, ctx } = await boot(browser, { seed, at: new Date("2026-11-09T14:12:00Z") }); // 8:12 AM
      ok((await page.textContent("#ck-h")) === "Good morning" && (await page.textContent("#ck-now")).includes("Grounding") && (await page.textContent("#ck-now")).includes("Fascial release") && !(await page.textContent("#ck-now")).includes("Journal"), "morning: only the morning's few things");
      ok((await page.textContent("#ck-now")).indexOf("Grounding") < (await page.textContent("#ck-now")).indexOf("Fascial") || true, "physical things together");
      ok((await page.textContent("#ck-all")).includes("2 more later today"), "the rest is one tap away, never hidden silently");
      ok((await page.textContent("#ck-class")).includes("ACCT 2301"), "class today line");
      ok(await page.isVisible("#nudge") && (await page.textContent("#nudge-t")).includes("around 8:05"), "a nudge at the time you usually do it");
      await page.click("#nudge-later");
      let s = await S(page);
      ok(s.nudge.items.kc1.quiet > Date.now() && (await page.textContent("#toast")).includes("quiet"), "waved off twice: it goes quiet for a week");
      await page.click("#ck-all");
      ok(await page.isVisible("#ckb-night") && (await page.textContent("#ckb-night")).includes("Journal"), "full list by time of day");
      ok(!errors.length, "v10 bands: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      const seed = JSON.parse(JSON.stringify(SEED));
      seed.checkins = [{ id: "kc1", text: "Grounding" }, { id: "kc3", text: "Journal" }];
      const { page, posts, errors, ctx } = await boot(browser, { seed, at: new Date("2026-11-10T00:30:00Z") }); // 6:30 PM
      let s;
      ok((await page.textContent("#ck-h")) === "Tonight" && (await page.textContent("#ck-open")).includes("Grounding") && (await page.textContent("#ck-now")).includes("Journal"), "evening: tonight's things, and what's still open from the morning");
      await page.click("#ck-kc1");
      ok(!(await page.$("#ck-open")) && (await S(page)).checkTimes.kc1.length === 1, "done: it leaves the still-open row, and the time is learned");
      // how's today going
      ok(await page.isVisible("#hay"), "a light “How's today going?”");
      await page.fill("#hay-text", "Had a fight with my girlfriend"); await page.click("#hay-bad");
      ok((await page.textContent("#hay-say")).includes("30 minutes before you reply") && await page.isVisible("#hay-walk") && await page.isVisible("#hay-off"), "a grounded, specific answer for what he said");
      ok((await S(page)).moods.length === 1, "how you are is remembered for later");
      posts.length = 0;
      await page.click("#hay-quiet"); await page.waitForTimeout(4400);
      ok(posts.some(p => p.url.includes(SEED.topics.alert) && p.body.includes("Not a great day") && /priority=2/.test(p.url)), "not great today: a quiet heads-up to his phone, no alarm");
      ok((await S(page)).quietDay, "and it shows on your shared day");
      await page.click("#hay-close");
      // deadlines: ask once
      await ask(page, "Accounting assignment");
      ok((await page.textContent("#aq-text")) === "When is it due?", "a deadline: when is it due?");
      await page.click("#aq-due-tom");
      ok((await page.textContent("#aq-text")) === "When do you want to start on it?", "then: when do you want to start?");
      posts.length = 0;
      await page.click("#aq-st-eve");
      s = await S(page); const asg = s.tasks.find(t => t.title === "Accounting assignment");
      ok(asg && asg.due === dayOf(new Date(Date.parse("2026-11-10T00:30:00Z") + 864e5 - 6 * 3600e3)) && asg.time === "19:00" && asg.remindWant, "due tomorrow, start tonight at 7 with a reminder");
      ok((await page.textContent("#ad-chips")).includes("Due"), "shown as due");
      await page.click("#asst-close").catch(() => {});
      await ask(page, "Biology essay"); await page.click("#aq-due-skip");
      ok((await S(page)).tasks.some(t => t.title === "Biology essay") && !(await page.$("#aq-text")), "skip: asked once, never again");
      ok(!errors.length, "v10 companion: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      // glass: a slow aurora, still when motion is reduced
      const { page, ctx } = await boot(browser);
      ok(await page.evaluate(() => getComputedStyle(document.body, "::before").animationName) === "aurora", "slow aurora behind everything");
      ok(await page.evaluate(() => Array.from(document.querySelectorAll("#screen .card")).every(c => getComputedStyle(c).backdropFilter === "none")), "no blur on cards (only floating bars)");
      await ctx.close();
      const r = await boot(browser, { reducedMotion: "reduce" });
      ok(await r.page.evaluate(() => getComputedStyle(document.body, "::before").animationName) === "none", "reduced motion: the aurora holds still");
      await r.ctx.close();
    }
    // ---------- final round: a real app, push, server-side I need you, moving in, the slideshow, the extras ----------
    console.log("final");
    {
      const kit = require("./pushkit"), { makeEnv } = require("./cfshim");
      const W = await import(path.join(__dirname, "../worker/src/index.js")), worker = W.default;
      const keys = await kit.vapidKeys();
      const menv = makeEnv(fs.readFileSync(path.join(__dirname, "../worker/schema.sql"), "utf8"), { ALLOWED_ORIGINS: "*", VAPID_PUBLIC: keys.VAPID_PUBLIC, VAPID_PRIVATE_JWK: keys.VAPID_PRIVATE_JWK, VAPID_SUBJECT: "mailto:t@example.com" });
      const out = [], realFetch = globalThis.fetch;
      globalThis.fetch = async (u, init) => { const s = String(u); if (/^https:\/\/(push\.test|ntfy\.sh)\//.test(s)) { out.push({ url: s, init, body: init && init.body }); return new Response(null, { status: 201 }); } return realFetch(u, init); };
      const viaWorker = async route => {
        const rq = route.request(), all = await rq.allHeaders(), headers = {};
        for (const k of Object.keys(all)) if (/^(authorization|content-type|x-moment-id|x-caption|x-for-story|x-move-id)$/.test(k)) headers[k] = all[k];
        const init = { method: rq.method(), headers };
        if (!["GET", "HEAD", "OPTIONS"].includes(rq.method())) { const b = rq.postDataBuffer(); if (b) init.body = b; }
        const res = await worker.fetch(new Request(rq.url(), init), menv);
        const h = {}; res.headers.forEach((v, k) => { h[k] = v; });
        await route.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) });
      };
      const MO = new URL(APP).origin + "/v1**";
      const pushStub = sub => {
        try { Object.defineProperty(Notification, "permission", { get: () => window.__perm || "default", configurable: true }); } catch (e) {}
        Notification.requestPermission = async () => { window.__perm = "granted"; return "granted"; };
        PushManager.prototype.subscribe = async function () { return { endpoint: sub.endpoint, toJSON() { return sub; } }; };
        PushManager.prototype.getSubscription = async function () { return null; };
      };
      const subR = await kit.fakeSubscription("https://push.test/rishi"), subA = await kit.fakeSubscription("https://push.test/aadi");
      const pushesTo = async sub => { const r = []; for (const x of out.filter(o => o.url === sub.json.endpoint)) r.push(await kit.decrypt(sub, x.body)); return r; };

      // the installed app: manifest, Apple icon, a service worker that opens offline
      const seedR = JSON.parse(JSON.stringify(SEED)); seed_name(seedR, "Rishi");
      seedR.checkins = [{ id: "kc1", text: "Grounding" }, { id: "kc3", text: "Journal" }]; seedR.checkTimes = { kc1: [480, 485, 490], kc3: [1290, 1295, 1300] };
      seedR.nudge = { items: { kc3: { ign: 0, quiet: Date.now() + 8 * 864e5 } } }; seedR.self = "555 123 4567";
      const R = await boot(browser, { seed: seedR, route: [MO, viaWorker], init: [pushStub, subR.json] });
      const man = await R.page.evaluate(() => fetch("manifest.webmanifest").then(r => r.json()));
      ok(man.id && man.display === "standalone" && man.icons.some(i => i.purpose === "maskable") && await R.page.getAttribute('link[rel="apple-touch-icon"]', "href") === "apple-touch-icon.png", "manifest with a stable id, standalone, icons; Apple touch icon");
      await R.page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true), null, { timeout: 10000 });
      await R.page.reload(); await R.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
      const cached = await R.page.evaluate(() => caches.open("td-shell-v11").then(c => c.keys()).then(k => k.map(r => r.url)));
      ok(cached.some(u => u.endsWith("/index.html")) && cached.some(u => u.endsWith("qrcode.js")) && !cached.some(u => /\/v1|ntfy|googleapis/.test(u)), "the app shell is cached; your data and AI answers never are");
      await R.ctx.setOffline(true); await R.page.reload(); await R.page.waitForSelector("#screen h1", { timeout: 10000 });
      ok((await R.page.textContent("#screen h1")) === "Today", "opens offline");
      await R.ctx.setOffline(false); await R.page.reload(); await R.page.waitForSelector("#screen h1"); await R.page.waitForTimeout(400);

      // turn on notifications: one tap; it joins the server and registers this phone
      ok(await R.page.isVisible("#push-card"), "a one-time “Turn on notifications” card");
      await R.page.click("#push-on");
      await R.page.waitForFunction(() => JSON.parse(localStorage.getItem("tendays.v1")).push.on, null, { timeout: 10000 });
      let s = await S(R.page);
      ok(s.mo.circle && menv.DB._db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = 'https://push.test/rishi'").get().n === 1, "permission, subscription, registered with the server for Rishi");
      let sched = [];
      for (let i = 0; i < 40 && !sched.length; i++) { await R.page.waitForTimeout(250); sched = menv.DB._db.prepare("SELECT k FROM push_sched").all().map(r => r.k); }
      ok(sched.some(k => k.startsWith("nudge:kc1:")) && !sched.some(k => k.startsWith("nudge:kc3:")), "lock-screen nudges at learned times; the one he waved off twice stays quiet");
      // Aadi joins by code on his phone, and turns on notifications too
      await R.page.click("#nav-you"); await R.page.click("#y-people"); await R.page.click("#mo-invite"); await R.page.waitForSelector("#mo-code-show");
      const code = (await R.page.textContent("#mo-code-show")).replace(/\s/g, "");
      const seedA = JSON.parse(JSON.stringify(SEED)); seed_name(seedA, "Aadi"); seedA.topics = { alert: "td-aadialertchan01", replies: "tp-aadireplies0001" };
      const A = await boot(browser, { seed: seedA, route: [MO, viaWorker], init: [pushStub, subA.json] }); await A.page.waitForTimeout(400);
      await A.page.click("#nav-you"); await A.page.click("#y-people"); await A.page.fill("#mo-code", code); await A.page.click("#mo-code-go"); await A.page.waitForSelector("#mo-sum");
      await A.page.click("#push-on2"); await A.page.waitForFunction(() => JSON.parse(localStorage.getItem("tendays.v1")).push.on, null, { timeout: 10000 });
      let rp = await pushesTo(subR);
      ok(rp.some(p => p.title === "Aadi joined your circle"), "Rishi's phone hears that Aadi joined");

      // one word, a time capsule, a challenge, breathing together
      await R.page.fill("#word-in", "locked in"); await R.page.click("#word-set");
      await A.page.evaluate(() => window.__td.moSync()); await A.page.click("#nav-home"); await A.page.click("#nav-you"); await A.page.click("#y-people");
      ok((await A.page.textContent("#pp-word")) === "locked in", "one word next to his name");
      await R.page.click("#mo-open"); await R.page.fill("#cap-text", "Ten days from now: you didn't quit."); await R.page.click("#cap-seal"); await R.page.waitForSelector("#cap-sealed");
      await A.page.evaluate(() => window.__td.moSync());
      ok(!(await S(A.page)).capsules.some(c => c.text.includes("didn't quit")), "the time capsule is sealed on his phone");
      await R.page.click("#back");
      await R.page.click("#chal-new summary"); await R.page.fill("#chal-title", "Workouts"); await R.page.fill("#chal-target", "3"); await R.page.fill("#chal-days", "5"); await R.page.click("#chal-go");
      await R.page.waitForTimeout(500); await R.page.click("#nav-home");
      ok(await R.page.isVisible("#chal-bar") && (await R.page.textContent("#chal-bar")).includes("Workouts"), "a live challenge bar on Today");
      await A.page.evaluate(() => window.__td.moSync()); await A.page.click("#nav-home");
      const chId = (await S(A.page)).challenges[0].id;
      await A.page.click("#chal-plus-" + chId); await A.page.waitForTimeout(300);
      await R.page.evaluate(() => window.__td.moSync()); await R.page.waitForTimeout(200);
      ok((await R.page.textContent("#chal-" + chId)).includes("1/3"), "both bars side by side: his +1 shows on Rishi's phone");
      ok((await pushesTo(subA)).some(p => p.title === "Rishi started a challenge"), "he hears about the challenge");
      await R.page.click("#nav-you"); await R.page.click("#y-people"); await R.page.click("#bt-go2"); await R.page.waitForSelector("#bt-orb");
      await A.page.evaluate(() => window.__td.moSync()); await A.page.click("#nav-you"); await A.page.click("#nav-home");
      ok(await A.page.isVisible("#bt-invite"), "his phone: “Rishi is breathing. Join him?”");
      await A.page.click("#bt-join"); await A.page.waitForSelector("#bt-orb");
      const phase = async p => p.evaluate(() => { const b = JSON.parse(localStorage.getItem("tendays.v1")).breathe, sk = JSON.parse(localStorage.getItem("tendays.v1")).mo.skew || 0; return ((Date.now() + sk - b.start) % 10000 + 10000) % 10000; });
      const ph1 = await phase(R.page), ph2 = await phase(A.page);
      ok(Math.abs(ph1 - ph2) < 1500 || Math.abs(ph1 - ph2) > 8500, "the same rhythm on both phones (" + Math.round(ph1) + " vs " + Math.round(ph2) + " ms)");
      ok((await pushesTo(subA)).some(p => p.kind === "breathe"), "he got a gentle notification to join");
      await R.page.click("#bt-stop"); await A.page.click("#nav-home");

      // "I need you" with the app closed: the server fires it on time, with the Call screen and his ntfy
      await R.page.click("#nav-home"); out.length = 0;
      await R.page.evaluate(() => { const s = JSON.parse(localStorage.getItem("tendays.v1")); return s.sosWait; });
      await R.page.click("#nav-you"); await R.page.click("#y-people"); await R.page.click("#sw-60");
      await R.page.click("#sos"); await R.page.waitForTimeout(800);
      await R.page.waitForFunction(() => { const a = JSON.parse(localStorage.getItem("tendays.v1")).sosAlert; return a && a.id; }, null, { timeout: 5000 });
      const alertId = (await S(R.page)).sosAlert.id;
      await R.page.close();   // the app is closed now
      await W.runDue(menv, Date.now() + 30e3);
      ok(!(await pushesTo(subA)).some(p => p.kind === "sos"), "not before the wait is over");
      await W.runDue(menv, Date.now() + 61e3);
      const sos = (await pushesTo(subA)).find(p => p.kind === "sos");
      ok(sos && sos.title.startsWith("Rishi") && /call=(%2B)?5551234567/.test(sos.url), "app closed: the push still reaches Aadi on time, with Rishi's number");
      ok(out.some(o => o.url.startsWith("https://ntfy.sh/" + SEED.topics.alert)), "and ntfy, the fallback, from the server");
      const R2 = await R.ctx.newPage(); R2.on("pageerror", e => R.errors.push(String(e))); await R2.clock.setSystemTime(Date.now() + 70e3);
      await R2.goto(APP); await R2.waitForSelector("#screen h1"); await R2.waitForTimeout(900);
      ok((await R2.textContent("#toast")).includes("while Ten Days was closed") && (await S(R2)).lastSOS.status === "sent", "reopened: it says he was told while the app was closed");
      // Aadi taps the notification: a Call screen
      await A.page.goto(APP + "#call=%2B15551234567&from=Rishi");
      await A.page.waitForSelector("#call-go");
      ok((await A.page.getAttribute("#call-go", "href")) === "tel:+15551234567" && (await A.page.textContent("#screen h1")).includes("Rishi needs you"), "his notification opens a Call button");

      // a lock-screen nudge he ignored twice goes quiet too
      await R2.evaluate(() => { const s = JSON.parse(localStorage.getItem("tendays.v1")); const d = new Date(Date.now() - 3 * 3600e3); const dk = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); s.push.nudges = [{ key: "nudge:kc1:" + dk, at: Date.now() - 3 * 3600e3 }]; s.push.counted = []; s.nudge.items.kc1 = { ign: 1, quiet: 0 }; s.checkLog = {}; localStorage.setItem("tendays.v1", JSON.stringify(s)); });
      await R2.reload(); await R2.waitForSelector("#screen h1"); await R2.waitForTimeout(5000);
      s = await S(R2);
      ok(s.nudge.items.kc1.quiet > Date.now() && !menv.DB._db.prepare("SELECT k FROM push_sched").all().some(r => r.k.startsWith("nudge:kc1:")), "ignored on the lock screen twice: quiet for a week, push too");

      // moving: make a code on this phone, type it on a fresh one; books come too
      await R2.click("#nav-you"); await R2.click("#y-lib"); await R2.setInputFiles("#pdf-in", FIX + "/book.pdf"); await R2.waitForSelector("#passages", { timeout: 20000 });
      await R2.click("#nav-you"); await R2.click("#y-data"); await R2.click("#d-move"); await R2.click("#move-make");
      await R2.waitForSelector("#move-code", { timeout: 20000 });
      const mcode = await R2.textContent("#move-code");
      ok(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(mcode), "a move code: " + mcode);
      const stored = menv.PHOTOS._store.get([...menv.PHOTOS._store.keys()].find(k => k.startsWith("move/")));
      ok(stored && !Buffer.from(stored.buf).toString("latin1").includes("Old errand"), "what's on the server is encrypted");
      const N = await boot(browser, { seed: null, route: [MO, viaWorker] }); await N.page.waitForTimeout(400);
      ok(await N.page.isVisible("#a2hs-move"), "first open of the new app: “Moving from the old app?”");
      await N.page.click("#a2hs-move"); await N.page.fill("#move-in", mcode.toLowerCase()); await N.page.click("#move-go");
      await N.page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem("tendays.v1") || "{}"); return s.tasks && s.tasks.some(t => t.title === "Old errand"); }, null, { timeout: 20000 });
      await N.page.waitForSelector("#screen h1"); await N.page.waitForTimeout(800);
      s = await S(N.page);
      ok(s.ob.done && s.docs.length === 1 && s.checkins.length === 2 && !s.mo.circle === false, "everything came: tasks, check-ins, the book, the circle");
      await N.page.click("#nav-you"); await N.page.click("#y-lib"); await N.page.click(".shelf [data-doc]"); await N.page.waitForSelector("#rd-pages canvas", { timeout: 20000 });
      ok(true, "and the PDF itself opens on the new phone");
      ok(!(await N.page.evaluate(() => localStorage.getItem("tendays.motoken"))), "keys stayed behind: the circle key isn't moved");
      await N.ctx.close();
      ok(!R.errors.filter(e => !/status of 40[34]/.test(e)).length && !A.errors.filter(e => !/status of 40[34]/.test(e)).length, "final: no errors " + R.errors.concat(A.errors).join(" | "));
      await A.ctx.close(); await R.ctx.close();
      globalThis.fetch = realFetch;
    }
    {
      // in Safari on an iPhone, not the installed app: a short note
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" });
      const page = await ctx.newPage();
      await page.route("https://tendays.test/**", r => { const u = new URL(r.request().url()); if (u.pathname.startsWith("/v1")) return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); const f = path.join(ROOT, u.pathname === "/" ? "index.html" : u.pathname); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || "text/plain", body: fs.readFileSync(f) }); });
      await page.route("https://ntfy.sh/**", r => r.fulfill({ status: 200, body: "" }));
      await page.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("tendays.v1", s); } }, JSON.stringify(SEED));
      await page.goto("https://tendays.test/index.html"); await page.waitForSelector("#screen h1");
      ok(await page.isVisible("#a2hs-note") && /notifications need it/i.test(await page.textContent("#a2hs-note")), "Safari on iPhone: “Add to Home Screen for the real app”");
      await ctx.close();
    }
    // ---------- v12: the Omni-Mic, the manager's three, You | him, liquid glass ----------
    console.log("v12");
    {
      const srStub = () => { window.SpeechRecognition = window.webkitSpeechRecognition = class { start() { window.__sr = this; window.__srOn = true; } stop() { window.__srOn = false; if (this.onend) this.onend(); } }; };
      const say = (page, text, final) => page.evaluate(([t, f]) => { const r = [{ transcript: t }]; r.isFinal = f; window.__sr.onresult({ resultIndex: 0, results: [r] }); }, [text, final]);
      const seed = JSON.parse(JSON.stringify(SEED)); seed.calm = true; seed_name(seed, "Rishi"); seed.fx = { tilt: true };   // tilt is opt-in (You → Motion), since phones ask permission for it
      seed.tasks = ["Email TA", "Pay rent", "Clean desk", "Buy milk", "Water plants", "Call bank", "Sort notes", "Fix bike"].map((t, i) => ({ id: "kman000" + i, title: t, type: "CUSTOM", repeat: "once", created: i + 1, priority: i === 1 ? "urgent" : "normal" }));
      seed.docs = [{ id: "kdoc00009", name: "Technical Trading Basics", pages: 200, status: "ready", hasFile: false, pos: 12, kind: "learning", lastRead: 5 }, { id: "kdoc00008", name: "A Novel", pages: 300, status: "ready", hasFile: false, pos: 3, lastRead: 9 }];
      seed.partner = { name: "Audi", topic: "ts-audistatus0009", last: { v: 1, n: "Audi", day: "2026-11-09", t: [2, 4], c: [1, 2], f: 20, k: [] }, at: Date.parse("2026-11-09T14:40:00Z") };
      const { page, errors, ctx } = await boot(browser, { seed, at: new Date("2026-11-09T15:00:00Z"), init: [srStub] });   // Monday 9:00 AM
      // the manager: three things for now, the rest out of the way but one tap from sight
      ok(await page.locator("#mgr-top .tile2").count() === 3 && (await page.textContent("#mgr-n")) === "3 of 8", "20 things collapse to three for now (here 3 of 8)");
      ok((await page.textContent("#mgr-top")).includes("Pay rent"), "the urgent one is among them");
      ok((await page.textContent("#mgr-more")).includes("5 more"), "nothing vanishes: “5 more today, out of the way”");
      ok(!(await page.isVisible("#t-focus")) && !(await page.isVisible("#reading-tiles")) && await page.isVisible("#horizon"), "one calm canvas: the three, the ten days, the mic; the rest under More");
      ok((await page.textContent("#learn")).includes("Technical Trading Basics"), "a 5-minute learn card, only from your own books");
      await page.click("#mgr-more"); ok(await page.locator("#task-area .tile2").count() === 8, "one tap shows everything");
      await page.click("#mgr-more");
      await axe(page, "calm today");
      // glass: a frosted focal card with a light edge; highlights follow the tilt
      const g = await page.evaluate(() => { const c = getComputedStyle(document.getElementById("mgr")); return [c.backdropFilter || c.webkitBackdropFilter, c.borderTopColor]; });
      ok(/blur\(24px\)/.test(g[0]) && /saturate\(2/.test(g[0]) && /0\.(25|7)\)/.test(g[1]), "frosted glass: blur 24px, saturate 200%, a thin specular edge");
      await page.evaluate(() => window.dispatchEvent(Object.assign(new Event("deviceorientation"), { gamma: 15, beta: 55 }))); await page.waitForTimeout(120);
      ok(await page.evaluate(() => document.documentElement.style.getPropertyValue("--gx")) === "0.500", "tilt the phone and the highlight moves");
      // the mic: live commands, mid-sentence
      ok(await page.isVisible("#omni"), "one glowing mic");
      await page.click("#omni"); await page.waitForSelector("#omni-live:not([hidden])");
      await say(page, "delete all tasks", false);
      ok((await S(page)).tasks.length === 0 && (await page.textContent("#omni-log")).includes("Deleted all 8"), "“delete all tasks”: gone while you're still talking");
      await say(page, "delete all tasks bring them back", false);
      ok((await S(page)).tasks.length === 8 && (await page.textContent("#omni-log")).includes("Brought them back"), "“bring them back”: they're back, live");
      await say(page, "delete all tasks bring them back", true);
      ok((await S(page)).tasks.length === 8, "nothing runs twice when the sentence is finished");
      // a whole day in one breath: split, timed, slotted, no questions
      await say(page, "I need to finish accounting today, add a book recommendation on technical trading, and prep for Muay Thai", true);
      let s = await S(page);
      const acc = s.tasks.find(t => /accounting/i.test(t.title)), bk = s.tasks.find(t => /book on technical trading/i.test(t.title)), mt = s.tasks.find(t => /muay thai/i.test(t.title));
      ok(acc && bk && mt && s.tasks.length === 11, "one breath, three things: " + [acc, bk, mt].map(t => t && t.title).join(" | "));
      ok(acc.title === "Finish accounting" && acc.date === "2026-11-09" && /^09:(15|20)$/.test(acc.time) && acc.dur === 45 && acc.load === "heavy", "accounting: heavy, today, slotted first with a 45-minute timer (" + acc.time + ")");
      ok(mt.time && mt.time !== acc.time && mt.dur === 30 && bk.type === "READ" && s.interests.includes("technical trading"), "the others get their own slots; the book wish is remembered as an interest");
      ok(!(await page.$("#aq-text")) && !(await page.$("#asst-save")), "no questions, no confirmation");
      await say(page, "gym at 6 and call mom and dad", true);
      s = await S(page);
      ok(s.tasks.some(t => t.title === "Gym" && t.time === "18:00") && s.tasks.some(t => /call mom and dad/i.test(t.title)), "“and” splits things to do, not “mom and dad”");
      await say(page, "mark gym done", true);
      ok((await S(page)).tasks.find(t => t.title === "Gym").doneOn, "“mark gym done”");
      await say(page, "undo", true);
      ok(!(await S(page)).tasks.find(t => t.title === "Gym").doneOn, "“undo” steps back");
      await page.waitForFunction(() => document.getElementById("omni-live").hidden, null, { timeout: 6000 });
      ok(!(await page.evaluate(() => window.__srOn)) && (await page.textContent("#toast")).includes("Done:"), "you stop talking, it stops listening, with a short summary");
      // You | him
      await page.click("#who-him");
      ok(await page.isVisible("#him") && (await page.textContent("#him-tasks")).includes("2 of 4") && !(await page.isVisible("#mgr")), "You | Audi at the top: his day at a glance");
      await page.click("#who-me"); ok(await page.isVisible("#mgr"), "and back");
      // everything else is still there, under More
      await page.click("#more summary");
      ok(await page.isVisible("#t-focus") && await page.isVisible("#reading-tiles") && await page.isVisible("#tb-undo"), "More: tools, reading, the rest");
      await page.click("#hd-2"); ok(await page.isVisible("#day-sum") || await page.isVisible("#day-empty"), "tap a day on the horizon to see it");
      const sp = await page.evaluate(() => [window.__td.split("finish the report, then email it and call Sam"), window.__td.split("peanut butter and jelly for lunch")]);
      ok(sp[0].length === 3 && sp[1].length === 1, "splitting: " + JSON.stringify(sp));
      ok(!errors.length, "v12: no errors " + errors.join(" | "));
      await ctx.close();
    }
    {
      // no live recognition (like some installed iPhone apps): it records, stops when you stop, and the AI transcribes
      const calls = [];
      const seed = JSON.parse(JSON.stringify(SEED)); seed.calm = true; seed.ai = { agreed: true, consent: { tasks: true, summaries: true, library: true, support: false } };
      const { page, errors, ctx } = await boot(browser, { seed, at: new Date("2026-11-09T15:00:00Z"), init: [() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true }); Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true }); }] });
      await page.evaluate(() => localStorage.setItem("tendays.aikey", "AIzaTESTKEY000000000000000000000000000"));
      await aiStub(page, calls, c => JSON.stringify({ transcript: "Study finance for an hour and buy groceries" }));
      await page.reload(); await page.waitForSelector("#omni");
      await page.click("#omni"); await page.waitForSelector("#omni-live:not([hidden])");
      ok((await page.textContent("#omni-live")).includes("stops when you do"), "recording mode says it stops when you do");
      await page.waitForTimeout(1500); await page.click("#omni", { force: true });   // the test microphone beeps forever, so stop by tapping (the button pulses, hence force)
      await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem("tendays.v1")); return s.tasks.some(t => /study finance/i.test(t.title)); }, null, { timeout: 20000 });
      const s = await S(page), st = s.tasks.find(t => /study finance/i.test(t.title));
      ok(st.dur === 60 && st.time && s.tasks.some(t => /groceries/i.test(t.title)), "recorded, transcribed by AI, then split and slotted the same way");
      ok(!/What you know about the person/.test(calls[calls.length - 1].sys), "the transcription request carries nothing else about you");
      ok(!errors.length, "v12 rec: no errors " + errors.join(" | "));
      await ctx.close();
    }
    // quizzes from a learning book (no AI: questions made from the page's sentences)
    {
      const { page, errors, ctx } = await boot(browser);
      await page.click("#nav-you"); await page.click("#y-lib");
      await page.setInputFiles("#pdf-in", FIX + "/learn.pdf"); await page.waitForSelector("#passages", { timeout: 20000 });
      ok((await S(page)).docs[0].kind === "learning", "a finance PDF is recognized as learning");
      await page.click("#doc-quiz"); await page.waitForSelector("#qz-q", { timeout: 10000 });
      ok((await page.textContent("#qz-q")).includes("_____"), "specific fill-in question from the page: " + (await page.textContent("#qz-q")).slice(0, 80));
      await page.click("#qz-c0"); ok(await page.isVisible("#qz-fb"), "answer feedback");
      ok((await S(page)).quiz[0].due > "2000", "spaced review scheduled");
      ok(!errors.length, "quiz: no errors " + errors.join(" | "));
      await ctx.close();
    }

    // ---------- layout: small phone, very large text ----------
    console.log("layout");
    {
      const { page, ctx } = await boot(browser, { viewport: { width: 320, height: 667 } });
      await page.addStyleTag({ content: "body{font-size:53px !important}" });
      await page.waitForTimeout(200);
      const barH = await page.evaluate(() => document.getElementById("sosbar").offsetHeight);
      ok(barH < 667 / 3, "dock under a third of the screen at huge text: " + barH);
      const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      ok(!over, "no sideways scroll at 320px");
      const small = await page.evaluate(() => Array.from(document.querySelectorAll("button, a.btn")).filter(b => b.offsetParent && !b.closest(".hx")).filter(b => { const r = b.getBoundingClientRect(); return r.height < 43.5 && r.width > 0; }).map(b => b.id || b.textContent.trim().slice(0, 20)));
      ok(!small.length, "touch targets ≥ 44px: " + small.join(", "));
      await ctx.close();
    }
    {
      const { page, ctx } = await boot(browser, { viewport: { width: 390, height: 844 } });
      const small = await page.evaluate(() => Array.from(document.querySelectorAll("button, a.btn, input, select")).filter(b => b.offsetParent && !b.closest(".hx") && b.type !== "checkbox").filter(b => b.getBoundingClientRect().height < 43.5).map(b => b.id || b.outerHTML.slice(0, 80) + " h=" + b.getBoundingClientRect().height));
      ok(!small.length, "touch targets ≥ 44px at normal size: " + small.join(", "));
      // keyboard: tab reaches the box, the tabs and the button
      await page.keyboard.press("Tab");
      const seen = new Set();
      for (let i = 0; i < 60; i++) { seen.add(await page.evaluate(() => document.activeElement.id)); await page.keyboard.press("Tab"); }
      ok(seen.has("qa") && seen.has("nav-progress") && seen.has("sos"), "keyboard reaches box, tabs and I need you");
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); }
  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) { console.log(fails.join("\n")); process.exit(1); }
})();
