package com.mohamed.qrcar

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.google.firebase.auth.FirebaseAuthWeakPasswordException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.Query
import com.google.firebase.database.ServerValue
import com.google.firebase.database.ValueEventListener
import org.json.JSONArray
import org.json.JSONObject

/**
 * Everything that talks to Firebase (Auth + Realtime Database) plus the car list cached on this phone.
 * All protection lives in database.rules.json; this object only performs the writes those rules allow.
 */
object Repo {
    /** Must match the 900000 in database.rules.json. */
    const val TTL_MS = 15 * 60 * 1000L

    /** Where the visitor page (docs/) is published. The QR holds PAGE_BASE + "#" + token. */
    const val PAGE_BASE = "https://mohamedelkateb594-a11y.github.io/QR_car-link/"

    // Public web config (same values as docs/firebase-config.js). Not secret.
    private const val API_KEY = "AIzaSyCzazAM6KTDj8BLAES5mjfJYZIaMP-q10k"
    private const val APP_ID = "1:168803483793:web:e9ee7497a2687b5c1a3f30"
    private const val PROJECT_ID = "qr-car-contact"
    private const val DB_URL = "https://qr-car-contact-default-rtdb.firebaseio.com"

    private lateinit var app: Context
    private lateinit var auth: FirebaseAuth
    private lateinit var db: FirebaseDatabase
    private val prefs get() = app.getSharedPreferences("qrcar", Context.MODE_PRIVATE)

    /** Signed-in owner uid, or null (anonymous users are treated as signed out). */
    var uid by mutableStateOf<String?>(null)
        private set
    var authError by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
        private set
    var repeatAlerts by mutableStateOf(true)
        private set

    val cars = mutableStateListOf<Car>()
    val requests = mutableStateListOf<Req>()

    /** False while the database connection is down. Car changes are refused then instead of hanging. */
    var connected by mutableStateOf(false)
        private set

    /** links/<hash>/active as last seen (false = paused). Missing = unknown, treated as active. */
    val active = mutableStateMapOf<String, Boolean>()

    private var skew = 0L
    private val handles = mutableListOf<() -> Unit>()
    private var carsHandle: (() -> Unit)? = null
    private val messageHandles = HashMap<String, () -> Unit>()
    private val uploaded = HashSet<String>()
    private const val OFFLINE = "لا يوجد اتصال بقاعدة البيانات. تحقق من الإنترنت وحاول مرة أخرى"

    fun serverNow(): Long = System.currentTimeMillis() + skew
    fun linkFor(car: Car): String = PAGE_BASE + "#" + car.token
    fun current(id: String): Req? = requests.firstOrNull { it.id == id }

    fun init(ctx: Context) {
        app = ctx.applicationContext
        if (FirebaseApp.getApps(app).isEmpty()) {
            FirebaseApp.initializeApp(
                app,
                FirebaseOptions.Builder()
                    .setApiKey(API_KEY).setApplicationId(APP_ID)
                    .setProjectId(PROJECT_ID).setDatabaseUrl(DB_URL).build(),
            )
        }
        auth = FirebaseAuth.getInstance()
        db = FirebaseDatabase.getInstance()
        repeatAlerts = prefs.getBoolean("repeat", true)
        db.getReference(".info/serverTimeOffset").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { skew = snapshot.getValue(Long::class.java) ?: 0L }
            override fun onCancelled(error: DatabaseError) {}
        })
        db.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { connected = snapshot.getValue(Boolean::class.java) ?: false }
            override fun onCancelled(error: DatabaseError) {}
        })
        auth.addAuthStateListener { onAuth(it.currentUser) }
    }

    // ---------- auth ----------
    private fun onAuth(user: FirebaseUser?) {
        val u = user?.takeIf { !it.isAnonymous }?.uid
        if (u != null && u == uid) return
        detachAll()
        carsHandle?.invoke()
        carsHandle = null
        uploaded.clear()
        cars.clear(); requests.clear(); active.clear()
        Alerts.resetAll(app)
        uid = u
        if (u == null) {
            Alerts.stopService(app)
            return
        }
        cars.addAll(loadCars(u))
        attachAll()
        watchCars(u)
        if (cars.isNotEmpty()) Alerts.startService(app)
    }

    fun signIn(email: String, password: String) = authCall { auth.signInWithEmailAndPassword(email.trim(), password) }
    fun signUp(email: String, password: String) = authCall { auth.createUserWithEmailAndPassword(email.trim(), password) }

    /** Sign-out cleanup happens in onAuth(null): listeners, timers, notifications and the service all stop. */
    fun signOut() { auth.signOut() }

    fun resetPassword(email: String, done: (String) -> Unit) {
        val e = email.trim()
        if (e.isEmpty()) return done("اكتب بريدك الإلكتروني أولًا")
        auth.sendPasswordResetEmail(e).addOnCompleteListener { t ->
            done(if (t.isSuccessful) "إذا كان البريد مسجلًا فستصلك رسالة لتغيير كلمة المرور" else authMessage(t.exception))
        }
    }

    private fun authCall(start: () -> Task<*>) {
        if (busy) return
        busy = true
        authError = null
        try {
            start().addOnCompleteListener { t ->
                busy = false
                if (!t.isSuccessful) authError = authMessage(t.exception)
            }
        } catch (e: Exception) {
            busy = false
            authError = authMessage(e)
        }
    }

    private fun authMessage(e: Exception?): String = when (e) {
        is FirebaseAuthInvalidCredentialsException, is FirebaseAuthInvalidUserException -> "البريد أو كلمة المرور غير صحيحة"
        is FirebaseAuthUserCollisionException -> "هذا البريد مسجل بالفعل. سجّل الدخول بدل إنشاء حساب"
        is FirebaseAuthWeakPasswordException -> "كلمة المرور ضعيفة (6 أحرف على الأقل)"
        is FirebaseNetworkException -> "تعذر الاتصال. تحقق من الإنترنت"
        else -> "تعذر إتمام العملية. حاول مرة أخرى"
    }

    fun setRepeat(v: Boolean) {
        repeatAlerts = v
        prefs.edit().putBoolean("repeat", v).apply()
    }

    // ---------- cars: cached on this phone, backed up under owners/<uid>/cars (readable by the owner only) ----------
    private fun loadCars(u: String): List<Car> = try {
        val arr = JSONArray(prefs.getString("cars:$u", "[]"))
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Car(o.getString("id"), o.getString("label"), o.getString("token"))
        }
    } catch (e: Exception) {
        emptyList()
    }

    private fun saveCars() {
        val u = uid ?: return
        val arr = JSONArray()
        cars.forEach { arr.put(JSONObject().put("id", it.id).put("label", it.label).put("token", it.token)) }
        prefs.edit().putString("cars:$u", arr.toString()).apply()
    }

    private fun linkValue(u: String, car: Car, on: Boolean): Map<String, Any> =
        mapOf("ownerUid" to u, "carId" to car.id, "active" to on)

    private fun backupValue(car: Car): Map<String, Any> =
        mapOf("label" to car.label, "token" to car.token, "updatedAt" to ServerValue.TIMESTAMP)

    /** Keeps the local list equal to the backup, so a new or reinstalled phone gets its cars (and QR codes) back. */
    private fun watchCars(u: String) {
        val ref = db.getReference("owners/$u/cars")
        val l = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { onCarsBackup(u, snapshot) }
            override fun onCancelled(error: DatabaseError) {}
        }
        ref.addValueEventListener(l)
        carsHandle = { ref.removeEventListener(l) }
    }

    private fun onCarsBackup(u: String, snapshot: DataSnapshot) {
        if (uid != u) return
        var changed = false
        val known = HashSet<String>()
        snapshot.children.forEach { c ->
            val id = c.key ?: return@forEach
            known.add(id)
            if (c.child("deleted").getValue(Boolean::class.java) == true) {
                if (cars.removeAll { it.id == id }) changed = true
                return@forEach
            }
            val label = c.child("label").getValue(String::class.java) ?: return@forEach
            val token = c.child("token").getValue(String::class.java) ?: return@forEach
            val car = Car(id, label, token)
            val i = cars.indexOfFirst { it.id == id }
            if (i < 0) {
                cars.add(car); changed = true
            } else if (cars[i] != car) {
                cars[i] = car; changed = true
            }
        }
        // Cars created by an older version exist only on this phone: upload each once.
        cars.filter { it.id !in known }.forEach { car ->
            if (uploaded.add(car.id)) carRef(u, car.id).setValue(backupValue(car))
        }
        if (changed) carsChanged()
    }

    private fun carRef(u: String, carId: String) = db.getReference("owners/$u/cars/$carId")

    private fun carsChanged() {
        saveCars()
        reload()
        if (cars.isEmpty()) Alerts.stopService(app) else Alerts.startService(app)
    }

    fun addCar(label: String, done: (String?) -> Unit) {
        val u = uid ?: return done("سجّل الدخول أولًا")
        val clean = Strs.clean(label).take(60)
        if (clean.isEmpty()) return done("اكتب اسم السيارة")
        if (!connected) return done(OFFLINE)
        val car = Car(Crypto.randomHex(8), clean, Crypto.newToken())
        uploaded.add(car.id)
        db.reference.updateChildren(
            mapOf(
                "links/${car.hash}" to linkValue(u, car, true),
                "owners/$u/cars/${car.id}" to backupValue(car),
            ),
        )
            .addOnSuccessListener {
                if (cars.none { it.id == car.id }) cars.add(car)
                carsChanged(); done(null)
            }
            .addOnFailureListener {
                if (cars.removeAll { it.id == car.id }) carsChanged()
                done("تعذر إضافة السيارة. تحقق من الاتصال ومن نشر قواعد قاعدة البيانات الجديدة")
            }
    }

    fun setActive(car: Car, on: Boolean) {
        db.getReference("links/${car.hash}/active").setValue(on)
    }

    /**
     * New token for the same car: the printed QR stops working. The old link is switched off, never removed,
     * so nobody who scanned it can claim it later. Requests of the old link are no longer shown.
     */
    fun rotate(car: Car, done: (String?) -> Unit) {
        val u = uid ?: return done("سجّل الدخول أولًا")
        if (!connected) return done(OFFLINE)
        val fresh = Car(car.id, car.label, Crypto.newToken())
        db.reference.updateChildren(
            mapOf(
                "links/${fresh.hash}" to linkValue(u, fresh, active[car.hash] != false),
                "links/${car.hash}/active" to false,
                "owners/$u/cars/${car.id}" to backupValue(fresh),
            ),
        )
            .addOnSuccessListener {
                val i = cars.indexOfFirst { it.id == car.id }
                if (i >= 0) cars[i] = fresh
                carsChanged(); done(null)
            }
            .addOnFailureListener { done("تعذر تغيير الرمز. تحقق من الاتصال") }
    }

    fun deleteCar(car: Car, done: (String?) -> Unit) {
        val u = uid ?: return done("سجّل الدخول أولًا")
        if (!connected) return done(OFFLINE)
        db.reference.updateChildren(
            mapOf(
                "links/${car.hash}/active" to false,
                "owners/$u/cars/${car.id}" to mapOf("deleted" to true, "updatedAt" to ServerValue.TIMESTAMP),
            ),
        )
            .addOnSuccessListener {
                cars.removeAll { it.id == car.id }
                carsChanged(); done(null)
            }
            .addOnFailureListener { done("تعذر حذف السيارة. تحقق من الاتصال") }
    }

    // ---------- listeners ----------
    private fun detachAll() {
        handles.forEach { it() }
        handles.clear()
        messageHandles.values.forEach { it() }
        messageHandles.clear()
    }

    private fun reload() {
        detachAll()
        // Requests of a removed or rotated link must not keep alerting.
        val hashes = cars.map { it.hash }.toSet()
        requests.filter { it.hash !in hashes }.forEach { Alerts.stop(app, it.id); Alerts.stopMessage(app, it.id) }
        requests.clear()
        active.clear()
        attachAll()
    }

    private fun attachAll() { cars.toList().forEach { attachCar(it) } }

    private fun attachCar(c: Car) {
        val h = c.hash
        val rq: Query = db.getReference("requests/$h").orderByChild("createdAt").limitToLast(30)
        val l1 = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { onRequests(h, snapshot) }
            override fun onCancelled(error: DatabaseError) {}
        }
        rq.addValueEventListener(l1)
        handles.add { rq.removeEventListener(l1) }

        val ar = db.getReference("links/$h/active")
        val l2 = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { active[h] = snapshot.getValue(Boolean::class.java) ?: false }
            override fun onCancelled(error: DatabaseError) {}
        }
        ar.addValueEventListener(l2)
        handles.add { ar.removeEventListener(l2) }
    }

    private fun parse(hash: String, c: DataSnapshot): Req? {
        val id = c.key ?: return null
        val status = c.child("status").getValue(String::class.java) ?: return null
        val created = c.child("createdAt").getValue(Long::class.java) ?: return null
        return Req(
            hash, id,
            c.child("reason").getValue(String::class.java) ?: "other",
            c.child("note").getValue(String::class.java) ?: "",
            status, created,
        )
    }

    private fun onRequests(hash: String, snapshot: DataSnapshot) {
        val list = snapshot.children.mapNotNull { parse(hash, it) }
        requests.removeAll { it.hash == hash }
        requests.addAll(list)
        val now = serverNow()
        list.forEach { r ->
            // Alerts keep going only while the owner has NOT opened the request (status stays "sent").
            if (r.isOpen(now) && r.status == "sent") Alerts.track(app, r) else Alerts.stop(app, r.id)
            if (r.isOpen(now)) {
                watchLastMessage(r)
            } else {
                messageHandles.remove(r.id)?.invoke()
                Alerts.stopMessage(app, r.id)
            }
        }
    }

    /** Notifies about a new visitor message in an open request while the owner is not looking at it. */
    private fun watchLastMessage(r: Req) {
        if (messageHandles.containsKey(r.id)) return
        val q = db.getReference("messages/${r.hash}/${r.id}").orderByChild("createdAt").limitToLast(1)
        val l = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val last = snapshot.children.lastOrNull() ?: return
                if (last.child("from").getValue(String::class.java) != "visitor") {
                    Alerts.stopMessage(app, r.id)
                    return
                }
                val text = last.child("text").getValue(String::class.java) ?: return
                val at = last.child("createdAt").getValue(Long::class.java) ?: return
                val cur = current(r.id) ?: r
                if (cur.isOpen(serverNow())) Alerts.message(app, cur, last.key ?: return, text, at)
            }
            override fun onCancelled(error: DatabaseError) {}
        }
        q.addValueEventListener(l)
        messageHandles[r.id] = { q.removeEventListener(l) }
    }

    // ---------- actions on a request ----------
    fun markViewed(r: Req) {
        db.getReference("requests/${r.hash}/${r.id}/status").setValue("viewed")
    }

    fun sendMessage(r: Req, text: String, done: (String?) -> Unit) {
        val t = Strs.clean(text)
        if (t.isEmpty()) return done("اكتب رسالة أولًا")
        if (t.length > 500) return done("الرسالة طويلة (الحد 500 حرف)")
        db.getReference("messages/${r.hash}/${r.id}").push()
            .setValue(mapOf("from" to "owner", "text" to t, "createdAt" to ServerValue.TIMESTAMP))
            .addOnSuccessListener { done(null) }
            .addOnFailureListener { done("تعذر إرسال الرسالة. ربما انتهى الطلب") }
    }

    /** Optional last message, then the final status. After this the rules refuse any further message. */
    fun close(r: Req, onTheWay: Boolean, note: String, done: (String?) -> Unit) {
        val n = Strs.clean(note)
        val status = if (onTheWay) "closed_on_the_way" else "closed_resolved"
        val fail = "تعذر إنهاء الطلب. ربما انتهى بالفعل"
        fun setStatus() {
            db.getReference("requests/${r.hash}/${r.id}/status").setValue(status)
                .addOnSuccessListener { done(null) }
                .addOnFailureListener { done(fail) }
        }
        if (n.isEmpty()) {
            setStatus()
        } else {
            db.getReference("messages/${r.hash}/${r.id}").push()
                .setValue(mapOf("from" to "owner", "text" to n.take(500), "createdAt" to ServerValue.TIMESTAMP))
                .addOnSuccessListener { setStatus() }
                .addOnFailureListener { done(fail) }
        }
    }

    /** Returns a function that removes the listener. */
    fun watchMessages(hash: String, rid: String, cb: (List<Msg>) -> Unit): () -> Unit {
        val q = db.getReference("messages/$hash/$rid").orderByChild("createdAt")
        val l = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                cb(snapshot.children.mapNotNull { c ->
                    val id = c.key ?: return@mapNotNull null
                    val from = c.child("from").getValue(String::class.java) ?: return@mapNotNull null
                    val text = c.child("text").getValue(String::class.java) ?: return@mapNotNull null
                    Msg(id, from, text, c.child("createdAt").getValue(Long::class.java) ?: 0L)
                })
            }
            override fun onCancelled(error: DatabaseError) {}
        }
        q.addValueEventListener(l)
        return { q.removeEventListener(l) }
    }
}
