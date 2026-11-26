package com.mohamed.qrcar

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
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
 * Sound: see Sound. In "channel" mode the notification channel carries the sound; in "app" mode the channel is silent
 * and the app plays the sound itself. The channel id encodes the mode and the sound version because Android never
 * changes an existing channel's sound.
 */
object Alerts {
    const val CHANNEL_SERVICE = "service"
    private const val REQUESTS_PREFIX = "requests"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val jobs = HashMap<String, Job>()
    private val handled = HashSet<String>()

    /** Id of the request-alert channel for the current mode and sound. Call after ensureChannels(). */
    fun requestsChannelId(): String = REQUESTS_PREFIX + (if (Sound.inApp) "_app_" else "_snd_") + Sound.version

    /** Creates the channels for the current sound settings and removes request channels of older settings. */
    fun ensureChannels(ctx: Context) {
        Sound.load(ctx)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "التطبيق يعمل في الخلفية", NotificationManager.IMPORTANCE_LOW),
        )
        val id = requestsChannelId()
        val ch = NotificationChannel(id, "طلبات التواصل", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "تنبيه عند وصول طلب تواصل بخصوص سيارتك"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400)
            val uri = if (Sound.inApp) null else Sound.channelUri(ctx)
            if (uri == null) {
                setSound(null, null)
            } else {
                setSound(
                    uri,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            }
        }
        nm.createNotificationChannel(ch)
        nm.notificationChannels
            .filter { it.id.startsWith(REQUESTS_PREFIX) && it.id != id }
            .forEach { nm.deleteNotificationChannel(it.id) }
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
        val job = jobs.remove(id)
        if (job != null) {
            job.cancel()
            Sound.stop()
        }
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
        Sound.stop()
        NotificationManagerCompat.from(ctx).cancelAll()
    }

    /** Settings → "test the alert": the same notification, sound and screen wake as a real request. */
    fun test(ctx: Context) {
        post(ctx, null, 7777, "تجربة تنبيه", "هكذا سيصلك تنبيه طلب تواصل جديد")
    }

    private fun notify(ctx: Context, r: Req) {
        post(ctx, r, r.id.hashCode(), "طلب تواصل جديد", Strs.reasons[r.reason] ?: Strs.reasons.getValue("other"))
    }

    private fun post(ctx: Context, r: Req?, id: Int, title: String, body: String) {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        val open = Intent(ctx, MainActivity::class.java).apply {
            if (r != null) {
                putExtra("hash", r.hash)
                putExtra("rid", r.id)
            }
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val pi = PendingIntent.getActivity(
            ctx, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(ctx, requestsChannelId())
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
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS revoked while running: nothing to do.
            return
        }
        if (Sound.wake) Sound.wakeScreen(ctx)
        // App mode, or the sound could not be registered for the channel: the app plays it itself.
        if (Sound.inApp || Sound.registrationFailed) Sound.play(ctx)
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
