'use strict';
/* Visitor page, free-plan edition: talks ONLY to Anonymous Auth + Realtime Database. All protection lives in
   database.rules.json (state transitions, expiry by server time, cooldown). The page never sees the owner's uid or phone. */
const REASONS = ['blocked_me', 'move_car', 'lights_on', 'issue', 'other'];
const T = {
  ar: { title: 'التواصل مع صاحب السيارة', sub: 'بدون تسجيل وبدون تنزيل تطبيق',
    privacy: 'رقم هاتفك لا يظهر لصاحب السيارة، ورقمه لا يظهر لك. الرسائل تنتهي مع انتهاء الطلب.',
    whyLegend: 'سبب التواصل', noteLabel: 'رسالة (اختيارية)', send: 'إرسال الطلب', sending: 'جارٍ الإرسال…', sendMsg: 'إرسال', msgPh: 'اكتب رسالة…',
    pick: 'اختر سبب التواصل أولًا.', cancel: 'إلغاء الطلب',
    reasons: ['أنت قافل عليّ ومحتاج أحرك العربية', 'محتاج تحرك عربيتك لو سمحت', 'أنوار العربية مفتوحة', 'في مشكلة أو ملاحظة بخصوص عربيتك', 'سبب آخر'],
    steps: ['تم الإرسال', 'شاهده المالك', 'تم الرد', 'انتهى'],
    b_wait: 'بانتظار صاحب السيارة. ينتهي الطلب تلقائيًا بعد', b_reached: 'شاهد صاحب السيارة طلبك. بانتظار رده. ينتهي الطلب بعد', b_replied: 'ردّ صاحب السيارة. يمكنك متابعة المحادثة هنا. ينتهي الطلب بعد',
    b_way: 'صاحب السيارة في الطريق للعربية. تم إنهاء الطلب.', b_moved: 'تم تحريك العربية بالفعل. تم إنهاء الطلب.',
    b_cancel: 'تم إلغاء الطلب.', b_expired: 'انتهت مدة الطلب دون رد.',
    closedHelp: 'إذا كنت لا تزال بحاجة للمساعدة، امسح رمز QR مرة أخرى.',
    ownerName: 'صاحب السيارة', you: 'أنت', empty: 'لا توجد رسائل بعد.',
    e_badlink: 'الرابط غير صالح. امسح رمز QR الموجود على السيارة مرة أخرى.',
    e_noconfig: 'إعدادات الخدمة غير مكتملة (firebase-config.js).',
    e_denied: 'تعذّر إرسال الطلب. قد يكون الرمز غير صالح أو متوقفًا، أو أرسلت طلبًا قبل أقل من دقيقة. انتظر قليلًا وحاول مرة أخرى.',
    e_msg_denied: 'تعذّر إرسال الرسالة. ربما انتهى الطلب.',
    e_generic: 'تعذّر الاتصال. تحقق من الإنترنت وحاول مرة أخرى.',
    foot: 'QR Car Contact' },
  en: { title: 'Contact the car owner', sub: 'No sign-up, no app to install',
    privacy: 'Your phone number is never shown to the owner, and theirs is never shown to you. Messages end with the request.',
    whyLegend: 'Reason for contact', noteLabel: 'Message (optional)', send: 'Send request', sending: 'Sending…', sendMsg: 'Send', msgPh: 'Write a message…',
    pick: 'Choose a reason first.', cancel: 'Cancel request',
    reasons: ["You're blocking me and I need to leave", 'Please move your car', "Your car's lights are on", "There's a problem with your car", 'Other'],
    steps: ['Sent', 'Owner saw it', 'Replied', 'Ended'],
    b_wait: 'Waiting for the owner. The request ends automatically in', b_reached: 'The owner saw your request. Waiting for a reply. Ends in', b_replied: 'The owner replied. You can continue the conversation here. Ends in',
    b_way: 'The owner is on the way to the car. This request has ended.', b_moved: 'The car has already been moved. This request has ended.',
    b_cancel: 'Request cancelled.', b_expired: 'The request expired with no reply.',
    closedHelp: 'If you still need help, scan the QR code again.',
    ownerName: 'Car owner', you: 'You', empty: 'No messages yet.',
    e_badlink: 'Invalid link. Scan the QR code on the car again.',
    e_noconfig: 'Service configuration is incomplete (firebase-config.js).',
    e_denied: 'Could not send the request. The code may be invalid or paused, or you sent one less than a minute ago. Wait a moment and try again.',
    e_msg_denied: 'Could not send the message. The request may have ended.',
    e_generic: 'Could not connect. Check your internet and try again.',
    foot: 'QR Car Contact' },
};
const CLOSED = ['way', 'moved', 'cancel', 'expired'];
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

let lang = (navigator.language || 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar';
let req = null, msgs = [], rid = null, hash = null, refs = [], tick = null, db = null, auth = null, busy = false, skew = 0;
const token = (location.hash.slice(1).match(/^[A-Za-z0-9_-]{32}$/) || [])[0];
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* session just won't resume */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const serverNow = () => Date.now() + skew;
const TTL_MS = 15 * 60 * 1000; // must match the 900000 in database.rules.json
const expiresAt = () => ((req && req.createdAt) || 0) + TTL_MS;
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g; // control + bidi-override chars

function applyLang() {
  const t = T[lang];
  document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-t]').forEach((e) => { e.textContent = t[e.dataset.t]; });
  $('langBtn').textContent = lang === 'ar' ? 'English' : 'العربية';
  $('msgInput').placeholder = t.msgPh;
  const keep = document.querySelector('input[name=reason]:checked');
  const keepVal = keep ? keep.value : null;
  $('reasons').innerHTML = '';
  t.reasons.forEach((r, i) => {
    const w = el('div', 'opt'); const inp = el('input'); inp.type = 'radio'; inp.name = 'reason'; inp.id = 'r' + i; inp.value = String(i);
    if (keepVal === String(i)) inp.checked = true;
    const lb = el('label', '', r); lb.htmlFor = 'r' + i; w.append(inp, lb); $('reasons').append(w);
  });
  if (req) render();
}
function showOnly(id) { for (const v of ['fatalView', 'formView', 'sessionView']) $(v).hidden = v !== id; }
function fatal(key) { $('fatalMsg').textContent = T[lang][key]; showOnly('fatalView'); }

// Expiry is derived from server time (createdAt + 15 min): the rules refuse any write after that moment.
function phase() {
  const st = req && req.status;
  if (st === 'closed_on_the_way') return 'way';
  if (st === 'closed_resolved') return 'moved';
  if (st === 'cancelled') return 'cancel';
  if (serverNow() >= expiresAt()) return 'expired';
  if (msgs.some((m) => m.from === 'owner')) return 'replied';
  if (st === 'viewed') return 'reached';
  return 'sent';
}

function render() {
  if (!req) return;
  const t = T[lang], ph = phase(), closed = CLOSED.includes(ph);
  const stage = { sent: 1, reached: 2, replied: 3 }[ph] || 4;
  const steps = $('steps'); steps.innerHTML = '';
  t.steps.forEach((s, i) => {
    const li = el('li', i < stage ? 'done' : '', s);
    if (i === 3 && closed) li.classList.add(ph === 'way' || ph === 'moved' ? 'end-ok' : 'end-bad');
    steps.append(li);
  });
  const left = Math.max(0, Math.floor((expiresAt() - serverNow()) / 1000));
  const b = $('banner'); let cls = 'wait', txt = '';
  if (ph === 'sent') txt = t.b_wait + ' '; else if (ph === 'reached') txt = t.b_reached + ' '; else if (ph === 'replied') txt = t.b_replied + ' ';
  else { cls = ph === 'way' || ph === 'moved' ? 'ok' : 'bad'; txt = { way: t.b_way, moved: t.b_moved, cancel: t.b_cancel, expired: t.b_expired }[ph] + ' ' + t.closedHelp; }
  b.className = 'banner ' + cls; b.textContent = txt;
  if (!closed) b.append(el('span', 'timer', fmt(left)));

  const chat = $('chat'); chat.innerHTML = '';
  const list = [];
  const ri = REASONS.indexOf(req.reason);
  if (ri >= 0) list.push({ me: true, text: t.reasons[ri], time: req.createdAt });
  if (req.note) list.push({ me: true, text: req.note, time: req.createdAt });
  msgs.forEach((m) => list.push({ me: m.from === 'visitor', text: m.text, time: m.createdAt }));
  if (!list.length) chat.append(el('p', 'empty', t.empty));
  list.forEach((m) => {
    const d = el('div', 'msg ' + (m.me ? 'me' : 'them'), m.text);
    const time = m.time ? new Date(m.time).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    d.append(el('small', '', (m.me ? t.you : t.ownerName) + (time ? ' · ' + time : ''))); chat.append(d);
  });
  chat.scrollTop = chat.scrollHeight;
  $('msgInput').disabled = closed; $('msgBtn').disabled = closed || busy; $('cancelBtn').hidden = closed; $('composer').hidden = closed;
  if (closed) { clearInterval(tick); tick = null; }
}

function detach() { refs.forEach((r) => r.off()); refs = []; clearInterval(tick); tick = null; }
function resetToForm() { store.del('rid:' + hash); detach(); req = null; msgs = []; rid = null; showOnly('formView'); }
function attach(id) {
  detach(); rid = id; store.set('rid:' + hash, id);
  const rr = db.ref('requests/' + hash + '/' + id);
  const mr = db.ref('messages/' + hash + '/' + id).orderByChild('createdAt');
  refs.push(rr, mr);
  rr.on('value', (s) => {
    if (!s.exists()) return resetToForm();
    req = s.val(); showOnly('sessionView'); render();
    if (!tick && !CLOSED.includes(phase())) tick = setInterval(render, 1000);
  }, resetToForm);
  mr.on('value', (s) => { const a = []; s.forEach((c) => { a.push(c.val()); }); msgs = a; render(); }, () => { /* request listener handles access loss */ });
}

async function init() {
  applyLang();
  const cfg = window.FIREBASE_CONFIG || {};
  if (!token) return fatal('e_badlink');
  if (!cfg.apiKey || String(cfg.apiKey).startsWith('YOUR_')) return fatal('e_noconfig');
  try {
    hash = await sha256Hex(token);
    firebase.initializeApp(cfg);
    auth = firebase.auth(); db = firebase.database();
    await auth.signInAnonymously();
    db.ref('.info/serverTimeOffset').on('value', (s) => { skew = s.val() || 0; });
  } catch { return fatal('e_generic'); }
  const saved = store.get('rid:' + hash);
  if (saved) attach(saved); else showOnly('formView');
}

const TS = () => firebase.database.ServerValue.TIMESTAMP;
$('note').addEventListener('input', (e) => { $('cnt').textContent = [...e.target.value].length; });
$('formView').addEventListener('submit', async (e) => {
  e.preventDefault(); if (busy) return;
  const r = document.querySelector('input[name=reason]:checked');
  if (!r) { $('err').textContent = T[lang].pick; return; }
  const note = $('note').value.replace(CTRL_RE, '').trim();
  if ([...note].length > 500) return;
  $('err').textContent = ''; busy = true; $('submitBtn').disabled = true; $('submitBtn').textContent = T[lang].sending;
  const id = db.ref('requests/' + hash).push().key;
  const body = { visitorUid: auth.currentUser.uid, reason: REASONS[+r.value], status: 'sent', createdAt: TS() };
  if (note) body.note = note;
  try {
    await db.ref().update({ ['requests/' + hash + '/' + id]: body, ['visitorState/' + auth.currentUser.uid + '/lastAt']: TS() });
    attach(id);
  } catch (err) { $('err').textContent = T[lang].e_denied; }
  finally { busy = false; $('submitBtn').disabled = false; $('submitBtn').textContent = T[lang].send; }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault(); const v = $('msgInput').value.replace(CTRL_RE, '').trim();
  if (!v || !rid || busy) return;
  busy = true; $('msgBtn').disabled = true; $('sErr').textContent = '';
  try { await db.ref('messages/' + hash + '/' + rid).push({ from: 'visitor', text: v, createdAt: TS() }); $('msgInput').value = ''; }
  catch { $('sErr').textContent = T[lang].e_msg_denied; }
  finally { busy = false; render(); }
});
$('cancelBtn').addEventListener('click', async () => {
  if (!rid || busy) return; busy = true; $('sErr').textContent = '';
  try { await db.ref('requests/' + hash + '/' + rid + '/status').set('cancelled'); } catch { $('sErr').textContent = T[lang].e_msg_denied; }
  finally { busy = false; render(); }
});
$('langBtn').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; applyLang(); });
init();
