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
 * Everything that talks to Firebase (Auth + Realtime Database) plus the car list kept on this phone.
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

    /** links/<hash>/active as last seen (false = paused). Missing = unknown, treated as active. */
    val active = mutableStateMapOf<String, Boolean>()

    private var skew = 0L
    private val handles = mutableListOf<() -> Unit>()

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
        auth.addAuthStateListener { onAuth(it.currentUser) }
    }

    // ---------- auth ----------
    private fun onAuth(user: FirebaseUser?) {
        detachAll()
        cars.clear(); requests.clear(); active.clear()
        Alerts.resetAll(app)
        val u = user?.takeIf { !it.isAnonymous }?.uid
        uid = u
        if (u == null) {
            Alerts.stopService(app)
            return
        }
        cars.addAll(loadCars(u))
        attachAll()
        if (cars.isNotEmpty()) Alerts.startService(app)
    }

    fun signIn(email: String, password: String) = authCall { auth.signInWithEmailAndPassword(email.trim(), password) }
    fun signUp(email: String, password: String) = authCall { auth.createUserWithEmailAndPassword(email.trim(), password) }

    /** Sign-out cleanup happens in onAuth(null): listeners, timers, notifications and the service all stop. */
    fun signOut() { auth.signOut() }

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

    // ---------- cars (kept on this phone; the database only knows hash -> owner) ----------
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

    fun addCar(label: String, done: (String?) -> Unit) {
        val u = uid ?: return done("سجّل الدخول أولًا")
        val clean = Strs.clean(label).take(60)
        if (clean.isEmpty()) return done("اكتب اسم السيارة")
        val car = Car(Crypto.randomHex(8), clean, Crypto.newToken())
        db.getReference("links/${car.hash}").setValue(linkValue(u, car, true))
            .addOnSuccessListener {
                cars.add(car); saveCars(); attachCar(car); Alerts.startService(app); done(null)
            }
            .addOnFailureListener { done("تعذر إضافة السيارة. تحقق من الاتصال ومن قواعد قاعدة البيانات") }
    }

    fun setActive(car: Car, on: Boolean) {
        db.getReference("links/${car.hash}/active").setValue(on)
    }

    /** New token for the same car: the printed QR stops working. Requests of the old link are no longer reachable. */
    fun rotate(car: Car, done: (String?) -> Unit) {
        val u = uid ?: return done("سجّل الدخول أولًا")
        val fresh = Car(car.id, car.label, Crypto.newToken())
        db.getReference("links/${fresh.hash}").setValue(linkValue(u, fresh, active[car.hash] != false))
            .addOnSuccessListener {
                db.getReference("links/${car.hash}").removeValue()
                val i = cars.indexOfFirst { it.id == car.id }
                if (i >= 0) cars[i] = fresh
                saveCars(); reload(); done(null)
            }
            .addOnFailureListener { done("تعذر تغيير الرمز. تحقق من الاتصال") }
    }

    fun deleteCar(car: Car, done: (String?) -> Unit) {
        db.getReference("links/${car.hash}").removeValue()
            .addOnSuccessListener {
                cars.removeAll { it.id == car.id }
                saveCars(); reload()
                if (cars.isEmpty()) Alerts.stopService(app)
                done(null)
            }
            .addOnFailureListener { done("تعذر حذف السيارة. تحقق من الاتصال") }
    }

    // ---------- listeners ----------
    private fun detachAll() {
        handles.forEach { it() }
        handles.clear()
    }

    private fun reload() {
        detachAll()
        requests.clear()
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
        }
    }

    // ---------- actions on a request ----------
    fun markViewed(r: Req) {
        db.getReference("requests/${r.hash}/${r.id}/status").setValue("viewed")
    }

    fun sendMessage(r: Req, text: String, done: (String?) -> Unit) {
        val t = Strs.clean(text)
        if (t.isEmpty()) return done("اكتب رسالة أولًا")
        if (t.codePointCount(0, t.length) > 500) return done("الرسالة طويلة (الحد 500 حرف)")
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
