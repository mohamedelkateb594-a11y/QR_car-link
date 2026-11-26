package com.mohamed.qrcar

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Incoming-request alerts. A new unopened request notifies immediately and then repeats at +30/+60/+90 s
 * (or once, if repeat is off) until the owner opens it, it is closed/cancelled, or its 15 minutes run out.
 * Runs on the main thread inside the process kept alive by AlertService.
 *
 * The sound is played by the app itself (playSound) on the alarm audio stream, NOT by the notification channel:
 * on the owner's Xiaomi phone the channel-based sound stayed silent even after the channel was recreated.
 * The channel is therefore silent (vibration only) so the two never overlap.
 */
object Alerts {
    const val CHANNEL_SERVICE = "service"

    /** Android never changes a channel after it was created, so every change of channel settings needs a new id. */
    const val CHANNEL_REQUESTS = "requests_v3"
    private val OLD_REQUEST_CHANNELS = listOf("requests", "requests_v2")

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val jobs = HashMap<String, Job>()
    private val handled = HashSet<String>()
    private var ringtone: Ringtone? = null

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "التطبيق يعمل في الخلفية", NotificationManager.IMPORTANCE_LOW),
        )
        OLD_REQUEST_CHANNELS.forEach { nm.deleteNotificationChannel(it) }
        val requests = NotificationChannel(CHANNEL_REQUESTS, "طلبات التواصل", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "تنبيه عند وصول طلب تواصل بخصوص سيارتك (الصوت يشغّله التطبيق نفسه)"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400)
            setSound(null, null)
        }
        nm.createNotificationChannel(requests)
    }

    /** Plays the default notification sound (falls back to ringtone, then alarm) on the alarm stream. */
    private fun playSound(ctx: Context) {
        try {
            ringtone?.stop()
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: return
            val r = RingtoneManager.getRingtone(ctx.applicationContext, uri) ?: return
            r.audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            r.play()
            ringtone = r
        } catch (e: Exception) {
            // Sound is best effort; the notification and vibration still happen.
        }
    }

    /** Start escalating alerts for a request. Each request id is tracked once per sign-in. */
    fun track(ctx: Context, r: Req) {
        if (!handled.add(r.id)) return
        val app = ctx.applicationContext
        jobs[r.id] = scope.launch {
            val repeats = if (Repo.repeatAlerts) listOf(30_000L, 60_000L, 90_000L) else emptyList()
            val now = Repo.serverNow()
            // The first alert is always immediate (even if the request arrives late); only future repeats follow.
            val pending = listOf(0L) + repeats.filter { r.createdAt + it > now }
            for (off in pending) {
                val wait = r.createdAt + off - Repo.serverNow()
                if (off > 0 && wait > 0) delay(wait)
                val cur = Repo.current(r.id) ?: break
                if (cur.status != "sent" || !cur.isOpen(Repo.serverNow())) break
                notify(app, cur)
            }
            // An unopened request disappears from the notification shade once it expires.
            val left = r.createdAt + Repo.TTL_MS - Repo.serverNow()
            if (left > 0) delay(left)
            NotificationManagerCompat.from(app).cancel(r.id.hashCode())
            jobs.remove(r.id)
        }
    }

    fun stop(ctx: Context, id: String) {
        jobs.remove(id)?.cancel()
        NotificationManagerCompat.from(ctx).cancel(id.hashCode())
    }

    /** One notification per new visitor message; silent about the request the owner is currently reading. */
    fun message(ctx: Context, r: Req, mid: String, text: String, createdAt: Long) {
        val prefs = ctx.getSharedPreferences("qrcar", Context.MODE_PRIVATE)
        if (prefs.getString("msg:${r.id}", null) == mid) return
        prefs.edit().putString("msg:${r.id}", mid).apply()
        if (Nav.isShowing(r.id)) return
        // Messages older than a minute were most likely seen on another phone or before a reinstall.
        if (Repo.serverNow() - createdAt > 60_000L) return
        post(ctx, r, messageId(r.id), "رسالة جديدة من الزائر", text)
    }

    fun stopMessage(ctx: Context, id: String) {
        NotificationManagerCompat.from(ctx).cancel(messageId(id))
    }

    private fun messageId(rid: String): Int = "msg:$rid".hashCode()

    fun resetAll(ctx: Context) {
        jobs.values.forEach { it.cancel() }
        jobs.clear()
        handled.clear()
        try { ringtone?.stop() } catch (e: Exception) { }
        NotificationManagerCompat.from(ctx).cancelAll()
    }

    private fun notify(ctx: Context, r: Req) {
        post(ctx, r, r.id.hashCode(), "طلب تواصل جديد", Strs.reasons[r.reason] ?: Strs.reasons.getValue("other"))
    }

    private fun post(ctx: Context, r: Req, id: Int, title: String, body: String) {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        val open = Intent(ctx, MainActivity::class.java).apply {
            putExtra("hash", r.hash)
            putExtra("rid", r.id)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val pi = PendingIntent.getActivity(
            ctx, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL_REQUESTS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setContentIntent(pi)
            .build()
        try {
            nm.notify(id, n)
            playSound(ctx)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS revoked while running: nothing to do.
        }
    }

    fun startService(ctx: Context) {
        try {
            ContextCompat.startForegroundService(ctx, Intent(ctx, AlertService::class.java))
        } catch (e: Exception) {
            // Android may refuse a foreground start from the background; the next app open retries.
        }
    }

    fun stopService(ctx: Context) {
        ctx.stopService(Intent(ctx, AlertService::class.java))
    }
}
