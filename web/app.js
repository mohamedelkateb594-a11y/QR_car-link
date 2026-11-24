'use strict';
/* Visitor page. Talks ONLY to: Anonymous Auth, callable functions (createRequest/sendMessage/cancelRequest),
   and read-only listeners on sessions/{id} (+ /messages). No phone numbers, no owner/car ids ever reach this page. */
const REASONS = ['blocked_me', 'move_car', 'lights_on', 'issue', 'other'];
const T = {
  ar: { title: 'التواصل مع صاحب السيارة', sub: 'بدون تسجيل وبدون تنزيل تطبيق',
    privacy: 'رقم هاتفك لا يظهر لصاحب السيارة، ورقمه لا يظهر لك. الرسائل تنتهي مع انتهاء الطلب.',
    whyLegend: 'سبب التواصل', noteLabel: 'رسالة (اختيارية)', send: 'إرسال الطلب', sending: 'جارٍ الإرسال…', sendMsg: 'إرسال', msgPh: 'اكتب رسالة…',
    pick: 'اختر سبب التواصل أولًا.', cancel: 'إلغاء الطلب',
    reasons: ['أنت قافل عليّ ومحتاج أحرك العربية', 'محتاج تحرك عربيتك لو سمحت', 'أنوار العربية مفتوحة', 'في مشكلة أو ملاحظة بخصوص عربيتك', 'سبب آخر'],
    steps: ['تم الإرسال', 'وصل للمالك', 'تم الرد', 'انتهى'],
    b_wait: 'بانتظار صاحب السيارة. ينتهي الطلب تلقائيًا بعد', b_reached: 'وصل طلبك لصاحب السيارة. بانتظار رده. ينتهي الطلب بعد', b_replied: 'ردّ صاحب السيارة. يمكنك متابعة المحادثة هنا.',
    b_way: 'صاحب السيارة في الطريق للعربية. تم إنهاء الطلب.', b_moved: 'تم تحريك العربية بالفعل. تم إنهاء الطلب.',
    b_cancel: 'تم إلغاء الطلب.', b_expired: 'انتهت مدة الطلب دون رد.',
    closedHelp: 'إذا كنت لا تزال بحاجة للمساعدة، امسح رمز QR مرة أخرى.',
    ownerName: 'صاحب السيارة', you: 'أنت', empty: 'لا توجد رسائل بعد.',
    e_badlink: 'الرابط غير صالح. امسح رمز QR الموجود على السيارة مرة أخرى.',
    e_noconfig: 'إعدادات الخدمة غير مكتملة (firebase-config.js).',
    e_not_found: 'هذا الرمز غير صالح أو متوقف حاليًا. تأكد من الرمز على السيارة.',
    e_rate_limited: 'عدد الطلبات كبير. حاول بعد قليل.',
    e_session_closed: 'تم إنهاء هذا الطلب ولا يمكن إرسال رسائل جديدة.',
    e_invalid_reason: 'اختر سببًا من القائمة.', e_message_too_long: 'الرسالة أطول من 500 حرف.',
    e_generic: 'تعذّر الاتصال. تحقق من الإنترنت وحاول مرة أخرى.',
    foot: 'QR Car Contact' },
  en: { title: 'Contact the car owner', sub: 'No sign-up, no app to install',
    privacy: 'Your phone number is never shown to the owner, and theirs is never shown to you. Messages end with the request.',
    whyLegend: 'Reason for contact', noteLabel: 'Message (optional)', send: 'Send request', sending: 'Sending…', sendMsg: 'Send', msgPh: 'Write a message…',
    pick: 'Choose a reason first.', cancel: 'Cancel request',
    reasons: ["You're blocking me and I need to leave", 'Please move your car', "Your car's lights are on", "There's a problem with your car", 'Other'],
    steps: ['Sent', 'Reached owner', 'Replied', 'Ended'],
    b_wait: 'Waiting for the owner. The request ends automatically in', b_reached: 'Your request reached the owner. Waiting for a reply. Ends in', b_replied: 'The owner replied. You can continue the conversation here.',
    b_way: 'The owner is on the way to the car. This request has ended.', b_moved: 'The car has already been moved. This request has ended.',
    b_cancel: 'Request cancelled.', b_expired: 'The request expired with no reply.',
    closedHelp: 'If you still need help, scan the QR code again.',
    ownerName: 'Car owner', you: 'You', empty: 'No messages yet.',
    e_badlink: 'Invalid link. Scan the QR code on the car again.',
    e_noconfig: 'Service configuration is incomplete (firebase-config.js).',
    e_not_found: 'This code is invalid or currently paused. Check the code on the car.',
    e_rate_limited: 'Too many requests. Try again shortly.',
    e_session_closed: 'This request has ended and cannot receive new messages.',
    e_invalid_reason: 'Pick a reason from the list.', e_message_too_long: 'Message is longer than 500 characters.',
    e_generic: 'Could not connect. Check your internet and try again.',
    foot: 'QR Car Contact' },
};
const CLOSED = ['way', 'moved', 'cancel', 'expired'];
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

let lang = (navigator.language || 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar';
let sess = null, msgs = [], rid = null, unsubs = [], tick = null, fns = null, db = null, auth = null, busy = false;
const token = ((location.pathname.match(/^\/c\/([A-Za-z0-9_-]{32})\/?$/)) || [])[1];
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable: session just won't resume */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const KEY = token ? 'rid:' + token.slice(0, 10) : 'rid';

function errText(e) {
  const code = (e && (e.message || e.code)) || '';
  const t = T[lang];
  return t['e_' + code] || t.e_generic;
}

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
  if (sess) render();
}

function showOnly(id) { for (const v of ['fatalView', 'formView', 'sessionView']) $(v).hidden = v !== id; }
function fatal(key) { $('fatalMsg').textContent = T[lang][key]; showOnly('fatalView'); }

function phase() {
  const st = sess && sess.status;
  if (st === 'closed_on_the_way') return 'way';
  if (st === 'closed_resolved') return 'moved';
  if (st === 'cancelled') return 'cancel';
  if (st === 'expired') return 'expired';
  if (msgs.some((m) => m.from === 'owner')) return 'replied';
  if (st === 'delivered' || st === 'viewed' || st === 'in_progress') return 'reached';
  return 'sent';
}

function render() {
  if (!sess) return;
  const t = T[lang], ph = phase(), closed = CLOSED.includes(ph);
  const stage = { sent: 1, reached: 2, replied: 3 }[ph] || 4;
  const steps = $('steps'); steps.innerHTML = '';
  t.steps.forEach((s, i) => {
    const li = el('li', i < stage ? 'done' : '', s);
    if (i === 3 && closed) li.classList.add(ph === 'way' || ph === 'moved' ? 'end-ok' : 'end-bad');
    steps.append(li);
  });
  const left = Math.max(0, Math.floor(((sess.expiresAt || 0) - Date.now()) / 1000));
  const b = $('banner'); let cls = 'wait', txt = '';
  if (ph === 'sent') txt = t.b_wait + ' '; else if (ph === 'reached') txt = t.b_reached + ' '; else if (ph === 'replied') txt = t.b_replied;
  else { cls = ph === 'way' || ph === 'moved' ? 'ok' : 'bad'; txt = { way: t.b_way, moved: t.b_moved, cancel: t.b_cancel, expired: t.b_expired }[ph] + ' ' + t.closedHelp; }
  b.className = 'banner ' + cls; b.textContent = txt;
  if (ph === 'sent' || ph === 'reached') b.append(el('span', 'timer', fmt(left)));

  const chat = $('chat'); chat.innerHTML = '';
  const ri = REASONS.indexOf(sess.reason);
  const list = [];
  if (ri >= 0) list.push({ me: true, text: t.reasons[ri], time: sess.createdAt });
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

async function call(name, data) {
  try { return (await fns.httpsCallable(name)(data)).data; }
  catch (e) { throw new Error(e && e.message ? e.message : 'generic'); }
}

function detach() { unsubs.forEach((u) => u()); unsubs = []; clearInterval(tick); tick = null; }
function attach(id) {
  detach(); rid = id; store.set(KEY, id);
  const onErr = () => { /* lost access or doc gone: forget this session and show the form again */ store.del(KEY); detach(); sess = null; msgs = []; rid = null; showOnly('formView'); };
  unsubs.push(db.doc('sessions/' + id).onSnapshot((s) => {
    if (!s.exists) return;
    const d = s.data();
    sess = { ...d, createdAt: d.createdAt, expiresAt: d.expiresAt };
    showOnly('sessionView'); render();
    if (!tick && !CLOSED.includes(phase())) tick = setInterval(render, 1000);
  }, onErr));
  unsubs.push(db.collection('sessions/' + id + '/messages').orderBy('createdAt').onSnapshot((q) => {
    msgs = q.docs.map((x) => x.data()); render();
  }, () => { /* the session listener handles access loss */ }));
}

async function init() {
  applyLang();
  const cfg = window.FIREBASE_CONFIG || {};
  if (!token) return fatal('e_badlink');
  if (!cfg.apiKey || String(cfg.apiKey).startsWith('YOUR_')) return fatal('e_noconfig');
  firebase.initializeApp(cfg);
  auth = firebase.auth(); db = firebase.firestore();
  fns = firebase.app().functions(window.FUNCTIONS_REGION || 'us-central1');
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {   // local Firebase Emulator Suite
    auth.useEmulator('http://127.0.0.1:9099'); db.useEmulator('127.0.0.1', 8080); fns.useEmulator('127.0.0.1', 5001);
  }
  try { await auth.signInAnonymously(); } catch { return fatal('e_generic'); }
  const saved = store.get(KEY);
  if (saved) attach(saved); else showOnly('formView');
}

$('note').addEventListener('input', (e) => { $('cnt').textContent = [...e.target.value].length; });
$('formView').addEventListener('submit', async (e) => {
  e.preventDefault(); if (busy) return;
  const r = document.querySelector('input[name=reason]:checked');
  if (!r) { $('err').textContent = T[lang].pick; return; }
  $('err').textContent = ''; busy = true; $('submitBtn').disabled = true; $('submitBtn').textContent = T[lang].sending;
  try {
    const out = await call('createRequest', { token, reason: REASONS[+r.value], message: $('note').value.trim() });
    attach(out.requestId);
  } catch (err) { $('err').textContent = errText(err); }
  finally { busy = false; $('submitBtn').disabled = false; $('submitBtn').textContent = T[lang].send; }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault(); const v = $('msgInput').value.trim(); if (!v || !rid || busy) return;
  busy = true; $('msgBtn').disabled = true; $('sErr').textContent = '';
  try { await call('sendMessage', { requestId: rid, text: v }); $('msgInput').value = ''; }
  catch (err) { $('sErr').textContent = errText(err); }
  finally { busy = false; render(); }
});
$('cancelBtn').addEventListener('click', async () => {
  if (!rid || busy) return; busy = true; $('sErr').textContent = '';
  try { await call('cancelRequest', { requestId: rid }); } catch (err) { $('sErr').textContent = errText(err); }
  finally { busy = false; render(); }
});
$('langBtn').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; applyLang(); });
init();
