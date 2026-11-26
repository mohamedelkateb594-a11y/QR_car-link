package com.mohamed.qrcar

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay

private val Danger = Color(0xFFB3261E)

@Composable
fun App() {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        MaterialTheme {
            Surface(Modifier.fillMaxSize()) {
                if (Repo.uid == null) LoginScreen() else Main()
            }
        }
    }
}

@Composable
private fun Main() {
    val s = Nav.screen
    BackHandler(enabled = s != Screen.Home) { Nav.screen = Screen.Home }
    Column(Modifier.fillMaxSize()) {
        if (!Repo.connected) {
            Text("لا يوجد اتصال — قد لا تصلك الطلبات الآن", color = Danger, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        }
        Column(Modifier.weight(1f)) {
            when (s) {
                Screen.Home -> HomeScreen()
                Screen.Settings -> SettingsScreen()
                is Screen.Qr -> QrScreen(s.carId)
                is Screen.Request -> key(s.rid) { RequestScreen(s.hash, s.rid) }
            }
        }
    }
}

// ---------- helpers ----------
@Composable
private fun rememberNow(): State<Long> = produceState(Repo.serverNow()) {
    while (true) {
        value = Repo.serverNow()
        delay(1000)
    }
}

private fun phaseText(phase: String): String = when (phase) {
    "sent" -> "جديد — بانتظار ردك"
    "viewed" -> "تم فتحه"
    "closed_on_the_way" -> "أنت في الطريق للعربية"
    "closed_resolved" -> "تم تحريك العربية"
    "cancelled" -> "ألغاه الزائر"
    "expired" -> "انتهت صلاحيته"
    else -> phase
}

private fun carName(hash: String): String = Repo.cars.firstOrNull { it.hash == hash }?.label ?: ""

private fun clock(ms: Long): String = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))

@Composable
private fun Page(title: String, onBack: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) TextButton(onClick = onBack) { Text("رجوع") }
            Text(title, style = MaterialTheme.typography.titleLarge)
        }
        Spacer(Modifier.height(8.dp))
        content()
    }
}

// ---------- login ----------
@Composable
private fun LoginScreen() {
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var notice by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
        Text("QR Car", style = MaterialTheme.typography.headlineMedium)
        Text("استقبل طلبات التواصل ممن يمسح رمز سيارتك دون مشاركة رقمك")
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(email, { email = it }, label = { Text("البريد الإلكتروني") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            password, { password = it }, label = { Text("كلمة المرور") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
        )
        Repo.authError?.let { Text(it, color = Danger, modifier = Modifier.padding(top = 8.dp)) }
        notice?.let { Text(it, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(16.dp))
        Button(onClick = { Repo.signIn(email, password) }, enabled = !Repo.busy, modifier = Modifier.fillMaxWidth()) { Text("تسجيل الدخول") }
        OutlinedButton(onClick = { Repo.signUp(email, password) }, enabled = !Repo.busy, modifier = Modifier.fillMaxWidth()) { Text("إنشاء حساب جديد") }
        TextButton(onClick = {
            Repo.authError = null
            Repo.resetPassword(email) { notice = it }
        }, modifier = Modifier.fillMaxWidth()) { Text("نسيت كلمة المرور؟") }
    }
}

// ---------- home: cars + requests tabs ----------
@Composable
private fun HomeScreen() {
    var tab by rememberSaveable { mutableStateOf(0) }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("QR Car", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = { Nav.screen = Screen.Settings }) { Text("الإعدادات") }
        }
        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("السيارات") })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("الطلبات") })
        }
        Spacer(Modifier.height(8.dp))
        if (tab == 0) CarsTab() else RequestsTab()
    }
}

@Composable
private fun CarsTab() {
    var adding by remember { mutableStateOf(false) }
    Button(onClick = { adding = true }, modifier = Modifier.fillMaxWidth()) { Text("إضافة سيارة") }
    Spacer(Modifier.height(8.dp))
    if (Repo.cars.isEmpty()) Text("لا توجد سيارات بعد. أضف سيارة لإنشاء رمز QR لها.")
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(Repo.cars.toList(), key = { it.id }) { car ->
            Card(Modifier.fillMaxWidth().clickable { Nav.screen = Screen.Qr(car.id) }) {
                Column(Modifier.padding(16.dp)) {
                    Text(car.label, style = MaterialTheme.typography.titleMedium)
                    Text(if (Repo.active[car.hash] == false) "متوقفة مؤقتًا — لا تستقبل طلبات" else "نشطة")
                }
            }
        }
    }
    if (adding) AddCarDialog { adding = false }
}

@Composable
private fun AddCarDialog(onClose: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!working) onClose() },
        title = { Text("سيارة جديدة") },
        text = {
            Column {
                OutlinedTextField(name, { name = it }, label = { Text("اسم السيارة (مثل: كورولا بيضاء)") }, singleLine = true)
                err?.let { Text(it, color = Danger) }
            }
        },
        confirmButton = {
            TextButton(enabled = !working, onClick = {
                working = true
                Repo.addCar(name) { e ->
                    working = false
                    if (e == null) {
                        onClose()
                    } else {
                        err = e
                    }
                }
            }) { Text("إنشاء") }
        },
        dismissButton = { TextButton(enabled = !working, onClick = onClose) { Text("إلغاء") } },
    )
}

@Composable
private fun RequestsTab() {
    val now by rememberNow()
    val list = Repo.requests.sortedByDescending { it.createdAt }
    if (list.isEmpty()) Text("لا توجد طلبات حتى الآن.")
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(list, key = { it.id }) { r ->
            Card(Modifier.fillMaxWidth().clickable { Nav.screen = Screen.Request(r.hash, r.id) }) {
                Column(Modifier.padding(16.dp)) {
                    Text(Strs.reasons[r.reason] ?: r.reason, style = MaterialTheme.typography.titleMedium)
                    Text(carName(r.hash))
                    Text(phaseText(r.phase(now)) + " • " + clock(r.createdAt))
                }
            }
        }
    }
}

// ---------- QR screen ----------
@Composable
private fun QrScreen(carId: String) {
    val ctx = LocalContext.current
    val car = Repo.cars.firstOrNull { it.id == carId }
    var confirm by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    Page(car?.label ?: "السيارة", onBack = { Nav.screen = Screen.Home }) {
        if (car == null) {
            Text("السيارة غير موجودة.")
            return@Page
        }
        val link = Repo.linkFor(car)
        val bmp = remember(link) { qrBitmap(link) }
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Image(bmp.asImageBitmap(), contentDescription = "QR", modifier = Modifier.size(260.dp))
            Text(link, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("استقبال الطلبات", Modifier.padding(end = 12.dp))
                Switch(checked = Repo.active[car.hash] != false, onCheckedChange = { Repo.setActive(car, it) })
            }
            Spacer(Modifier.height(8.dp))
            val name = "QR-" + car.label.replace(Regex("[^\\p{L}\\p{N}]+"), "_")
            Button(modifier = Modifier.fillMaxWidth(), onClick = {
                val saved = saveQrToGallery(ctx, printableCard(bmp), name)
                info = if (saved != null) "تم حفظ الصورة في الصور → QRCar" else "تعذر حفظ الصورة"
            }) { Text("حفظ بطاقة الـ QR للطباعة") }
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                val saved = saveQrToGallery(ctx, printableCard(bmp), name)
                if (saved == null) {
                    info = "تعذر تجهيز الصورة"
                } else {
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "image/png"
                        putExtra(Intent.EXTRA_STREAM, saved)
                        clipData = ClipData.newRawUri("QR", saved)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    ctx.startActivity(Intent.createChooser(send, null))
                }
            }) { Text("مشاركة صورة الرمز") }
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, link)
                }
                ctx.startActivity(Intent.createChooser(send, null))
            }) { Text("مشاركة الرابط") }
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = { confirm = "rotate" }) { Text("إبطال الرمز وإصدار رمز جديد") }
            TextButton(modifier = Modifier.fillMaxWidth(), onClick = { confirm = "delete" }) { Text("حذف السيارة", color = Danger) }
            info?.let { Text(it) }
        }
        confirm?.let { what ->
            val rotating = what == "rotate"
            AlertDialog(
                onDismissRequest = { confirm = null },
                title = { Text(if (rotating) "إبطال الرمز؟" else "حذف السيارة؟") },
                text = {
                    Text(if (rotating) "الرمز المطبوع الحالي سيتوقف عن العمل ولن تظهر طلباته القديمة." else "سيتوقف الرمز المطبوع عن العمل نهائيًا.")
                },
                confirmButton = {
                    TextButton(onClick = {
                        confirm = null
                        if (rotating) {
                            Repo.rotate(car) { e -> info = e ?: "تم إصدار رمز جديد. اطبعه واستبدل القديم." }
                        } else {
                            Repo.deleteCar(car) { e ->
                                if (e == null) {
                                    Nav.screen = Screen.Home
                                } else {
                                    info = e
                                }
                            }
                        }
                    }) { Text("تأكيد") }
                },
                dismissButton = { TextButton(onClick = { confirm = null }) { Text("إلغاء") } },
            )
        }
    }
}

// ---------- request details + live chat ----------
@Composable
private fun RequestScreen(hash: String, rid: String) {
    val now by rememberNow()
    val r = Repo.requests.firstOrNull { it.hash == hash && it.id == rid }
    var msgs by remember { mutableStateOf(listOf<Msg>()) }
    var text by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var closing by remember { mutableStateOf(false) }
    val chat = rememberLazyListState()
    LaunchedEffect(msgs.size) {
        if (msgs.isNotEmpty()) chat.animateScrollToItem(msgs.size - 1)
    }
    val ctx = LocalContext.current

    DisposableEffect(hash, rid) {
        val off = Repo.watchMessages(hash, rid) { msgs = it }
        onDispose { off() }
    }
    LaunchedEffect(rid, msgs.size) { Alerts.stopMessage(ctx, rid) }
    // Opening a new request tells the visitor it was seen and stops the repeating alerts.
    LaunchedEffect(rid, r != null) {
        val cur = Repo.current(rid)
        if (cur != null && cur.status == "sent" && cur.isOpen(Repo.serverNow())) Repo.markViewed(cur)
    }

    Page("طلب تواصل", onBack = { Nav.screen = Screen.Home }) {
        if (r == null) {
            Text("الطلب غير متاح أو لم يعد مرتبطًا بسيارتك.")
            return@Page
        }
        val open = r.isOpen(now)
        Text(Strs.reasons[r.reason] ?: r.reason, style = MaterialTheme.typography.titleMedium)
        Text(carName(r.hash), style = MaterialTheme.typography.labelMedium)
        if (r.note.isNotEmpty()) Text(r.note)
        val left = if (open) " • تنتهي خلال " + Strs.fmt((r.createdAt + Repo.TTL_MS - now) / 1000) else ""
        Text(phaseText(r.phase(now)) + left)
        Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = chat, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(msgs, key = { it.id }) { m ->
                val mine = m.from == "owner"
                Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.Start else Arrangement.End) {
                    Card(Modifier.fillMaxWidth(0.85f)) {
                        Column(Modifier.padding(10.dp)) {
                            Text((if (mine) "أنت" else "الزائر") + " • " + clock(m.createdAt), style = MaterialTheme.typography.labelSmall)
                            Text(m.text)
                        }
                    }
                }
            }
        }
        err?.let { Text(it, color = Danger) }
        if (open) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(text, { text = it }, Modifier.weight(1f), placeholder = { Text("اكتب ردًّا…") })
                TextButton(onClick = {
                    Repo.sendMessage(r, text) { e ->
                        if (e == null) {
                            text = ""
                            err = null
                        } else {
                            err = e
                        }
                    }
                }) { Text("إرسال") }
            }
            Button(modifier = Modifier.fillMaxWidth(), onClick = { closing = true }) { Text("أنا في الطريق للعربية") }
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                Repo.close(r, false, "") { e -> err = e }
            }) { Text("تم تحريك العربية بالفعل") }
        } else {
            Text("انتهى هذا الطلب ولا يمكن إرسال رسائل جديدة فيه.")
        }
        if (closing) {
            var note by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { closing = false },
                title = { Text("أنا في الطريق للعربية") },
                text = {
                    Column {
                        Text("سيتم إغلاق الطلب نهائيًا. يمكنك إضافة رسالة قبل التأكيد.")
                        OutlinedTextField(note, { note = it }, placeholder = { Text("مثل: أنا نازل خلال دقيقتين") })
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        closing = false
                        Repo.close(r, true, note) { e -> err = e }
                    }) { Text("تأكيد وإغلاق") }
                },
                dismissButton = { TextButton(onClick = { closing = false }) { Text("إلغاء") } },
            )
        }
    }
}

// ---------- settings ----------
private fun appDetails(ctx: Context): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))

/** Opens a system screen; if the phone has no such screen, opens the fallback (usually the app's own settings page). */
private fun openSafely(ctx: Context, intent: Intent, fallback: Intent? = null) {
    try {
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (e: Exception) {
        try {
            if (fallback != null) ctx.startActivity(fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e2: Exception) {
            // Nothing else to open.
        }
    }
}

@Composable
private fun SettingsScreen() {
    val ctx = LocalContext.current
    var soundMsg by remember { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val err = Sound.saveCustom(ctx, uri)
            if (err == null) Alerts.ensureChannels(ctx)
            soundMsg = err ?: "تم تعيين الصوت. اضغط «تجربة التنبيه» لتسمعه."
        }
    }
    Page("الإعدادات", onBack = { Nav.screen = Screen.Home }) {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("تكرار التنبيه (كل 30 ثانية حتى دقيقة ونصف) إذا لم تفتح الطلب", Modifier.weight(1f))
                Switch(checked = Repo.repeatAlerts, onCheckedChange = { Repo.setRepeat(it) })
            }

            // ----- alert sound -----
            Spacer(Modifier.height(8.dp))
            Text("صوت التنبيه", style = MaterialTheme.typography.titleMedium)
            Text("الصوت الحالي: " + (Sound.customName ?: "نغمة التطبيق الافتراضية"))
            Button(modifier = Modifier.fillMaxWidth(), onClick = { picker.launch(arrayOf("audio/*")) }) {
                Text("اختيار ملف صوتي من الهاتف")
            }
            if (Sound.customName != null) {
                OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                    Sound.clearCustom(ctx)
                    Alerts.ensureChannels(ctx)
                    soundMsg = "رجع الصوت إلى نغمة التطبيق الافتراضية."
                }) { Text("الرجوع للنغمة الافتراضية") }
            }
            Button(modifier = Modifier.fillMaxWidth(), onClick = {
                Alerts.test(ctx)
                soundMsg = "أُرسل تنبيه تجريبي. إن لم تسمع صوتًا فعّل «تشغيل الصوت من التطبيق نفسه» أدناه ثم جرّب مرة أخرى."
            }) { Text("تجربة التنبيه") }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("تشغيل الصوت من التطبيق نفسه (فعّله إن لم تسمع صوتًا). يعمل بمستوى صوت المنبّه.", Modifier.weight(1f))
                Switch(checked = Sound.inApp, onCheckedChange = {
                    Sound.setInApp(ctx, it)
                    Alerts.ensureChannels(ctx)
                })
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("إضاءة الشاشة لثوانٍ عند وصول طلب وهي مقفلة", Modifier.weight(1f))
                Switch(checked = Sound.wake, onCheckedChange = { Sound.setWake(ctx, it) })
            }
            soundMsg?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                openSafely(
                    ctx,
                    Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                        .putExtra(Settings.EXTRA_CHANNEL_ID, Alerts.requestsChannelId()),
                    appDetails(ctx),
                )
            }) { Text("إعدادات إشعارات الطلبات في الهاتف") }

            // ----- phone setup so alerts arrive with the screen locked -----
            Spacer(Modifier.height(8.dp))
            Text("تجهيز الهاتف لتصلك التنبيهات والشاشة مقفلة", style = MaterialTheme.typography.titleMedium)
            Text(
                "اسمح بالإشعارات، واستثنِ التطبيق من توفير البطارية، وفعّل التشغيل التلقائي، ولا تغلق التطبيق بالقوة. قد يكتم وضع «عدم الإزعاج» الصوت.",
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                openSafely(ctx, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), appDetails(ctx))
            }) { Text("استثناء التطبيق من توفير البطارية") }
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                openSafely(
                    ctx,
                    Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                    appDetails(ctx),
                )
            }) { Text("التشغيل التلقائي (شاومي)") }
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                openSafely(
                    ctx,
                    Intent("miui.intent.action.APP_PERM_EDITOR")
                        .setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")
                        .putExtra("extra_pkgname", ctx.packageName),
                    appDetails(ctx),
                )
            }) { Text("أذونات التطبيق: شاشة القفل والنوافذ المنبثقة (شاومي)") }
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = {
                openSafely(ctx, appDetails(ctx))
            }) { Text("إعدادات التطبيق في الهاتف") }

            Spacer(Modifier.height(16.dp))
            Button(modifier = Modifier.fillMaxWidth(), onClick = {
                Nav.screen = Screen.Home
                Repo.signOut()
            }) { Text("تسجيل الخروج") }
        }
    }
}
