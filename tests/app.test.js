// End-to-end checks for Ten Days in headless Chromium.
//   cd tests && npm install && npm test
// ntfy.sh is stubbed (nothing is really sent) and pdf.js is served from the local pdfjs-dist package,
// so the run needs no network. The app is served over http because Chromium drops file:// storage on reload.
const { chromium } = require("playwright");
const path = require("path"), fs = require("fs"), http = require("http");
const ROOT = path.resolve(__dirname, ".."), FIX = path.join(__dirname, "fixtures");
const PDFJS = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "build") + "/";
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TYPES = { ".html": "text/html", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
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
  freeDays: [], contacts: [{ id: "kc0001", name: "Mom", phone: "555 000 1111" }]
};
async function boot(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, reducedMotion: opts.reducedMotion || "no-preference", timezoneId: "America/Chicago" });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/ERR_FAILED|net::|status of 500/.test(m.text())) errors.push(m.text()); });
  await page.route("https://ntfy.sh/**", r => { const u = r.request().url(); if (r.request().method() === "POST") posts.push({ url: u, body: r.request().postData() }); r.fulfill({ status: 200, body: u.includes("/json") ? "" : "{}" }); });
  await page.route("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/*", r => {
    if (opts.offlineReader) return r.abort();
    const f = r.request().url().split("/").pop();
    r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(PDFJS + f) });
  });
  if (opts.seed !== null) await page.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("tendays.v1", s); } }, JSON.stringify(opts.seed || SEED));
  await page.goto(APP);
  await page.waitForSelector("#screen h1");
  return { ctx, page, errors, posts };
}
const S = page => page.evaluate(() => JSON.parse(localStorage.getItem("tendays.v1")));
async function ask(page, text) { await page.fill("#qa", text); await page.click("#qa-add"); await page.waitForTimeout(80); }
async function axe(page, name) {
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
      ok((await page.textContent("#read-today")).startsWith("Today: 1 of"), "page counted as read");
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
      await page.selectOption("#doc-goal", "2"); await page.click("#doc-daily");
      s = await S(page); const rt = s.tasks.find(t => t.docId && t.type === "READ" && t.repeat === "daily");
      ok(!!rt, "daily reading task linked to the book");
      await page.click("#pg-next"); await page.click("#pg-done");
      s = await S(page); ok(s.tasks.find(t => t.id === rt.id).doneOn, "reading goal met marks the task done");
      await page.click("#back"); await page.click('[data-card]');
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
      await page.click('[data-doc]:has-text("book")');
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
      await page.waitForSelector("#pdf-page canvas", { timeout: 20000 });
      s = await S(page);
      ok(s.tasks.some(t => t.title === "Read a book" && t.docId), "book linked to the reading task");
      ok((await page.textContent("#read-page")) === "Page 1 of 2" && await page.evaluate(() => document.querySelector("#pdf-page canvas").width > 100), "the real page is drawn");
      await page.click("#rd-next"); await page.waitForSelector("#pdf-page[data-ready='2']");
      ok((await S(page)).docs[0].pos === 2, "place kept");
      await page.click("#read-done");
      s = await S(page); ok(s.tasks.find(t => t.title === "Read a book").doneOn, "Completed finishes the reading task");
      ok((await page.textContent("#screen h1")) !== "book", "Completed closes the book");
      await page.click("#nav-you"); await page.click("#y-lib"); await page.click("[data-doc]");
      await page.click("#sel-all");
      ok((await page.textContent("#sel-n")).match(/\d+ passages? selected/), "select all on this page");
      await page.click("#sel-clear");
      await page.click("#pg-prev");
      await page.locator(".passage.sel").nth(0).click(); await page.locator(".passage.sel").nth(1).click(); await page.click("#sel-save");
      await page.click("#pg-next"); await page.click("#nav-home");
      await page.click("#sos"); await page.waitForTimeout(800); await page.click("#cd-cancel");
      ok(await page.isVisible("#sup-more") && (await page.locator("#sup-more [data-readon]").count()) >= 1, "support: keep reading with a way back into the book");
      await page.locator("#sup-more [data-readon]").first().click();
      await page.waitForSelector("#pdf-page canvas", { timeout: 20000 });
      ok(await page.isVisible("#read-close"), "read on opens the book itself");
      await page.click("#read-close");
      // reading: tap to save passages under the page, or highlight words on the page
      await page.click("#nav-you"); await page.click("#y-lib"); await page.click("[data-doc]"); await page.click("#doc-read");
      await page.waitForSelector("#pdf-page canvas", { timeout: 20000 });
      if ((await page.textContent("#read-page")) !== "Page 2 of 2") { await page.click("#rd-next"); }
      await page.waitForSelector("#pdf-page[data-ready='2']");
      const c0 = (await S(page)).cards.length;
      await page.click("#toggle-ps"); await page.locator("#read-ps-list .passage").last().click();
      ok((await S(page)).cards.length === c0 + 1 && (await page.locator("#read-ps-list .passage").last().getAttribute("aria-pressed")) === "true", "tap a passage while reading saves it");
      ok((await page.textContent("#toast")).includes("Saved to cards"), "saved-to-cards flash");
      await page.locator("#read-ps-list .passage").last().click();
      ok((await S(page)).cards.length === c0, "tap again removes it");
      await page.waitForSelector(".textLayer span", { timeout: 10000 });
      await page.evaluate(() => { const sp = Array.from(document.querySelectorAll(".textLayer span")).find(x => x.textContent.length > 20); const r = document.createRange(); r.selectNodeContents(sp); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); });
      await page.waitForSelector("#hlbtn:not([hidden])");
      await page.dispatchEvent("#hlbtn", "click");
      const hc = (await S(page)).cards;
      ok(hc.length === c0 + 1 && hc[hc.length - 1].page === 2, "highlight on the page saved as a card");
      await page.click("#read-close");
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
      await page.click('[data-spark="' + lid + '"]'); await page.fill("#sp-" + lid, "tomorrow 2pm, high, 45 min");
      await page.click("#sp-go-" + lid);
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
