package com.mohamed.qrcar

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
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
 */
object Alerts {
    const val CHANNEL_SERVICE = "service"
    const val CHANNEL_REQUESTS = "requests"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val jobs = HashMap<String, Job>()
    private val handled = HashSet<String>()

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "التطبيق يعمل في الخلفية", NotificationManager.IMPORTANCE_LOW),
        )
        val requests = NotificationChannel(CHANNEL_REQUESTS, "طلبات التواصل", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "تنبيه عند وصول طلب تواصل بخصوص سيارتك"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
        }
        nm.createNotificationChannel(requests)
    }

    /** Start escalating alerts for a request. Each request id is tracked once per sign-in. */
    fun track(ctx: Context, r: Req) {
        if (!handled.add(r.id)) return
        val app = ctx.applicationContext
        jobs[r.id] = scope.launch {
            val offsets = if (Repo.repeatAlerts) listOf(0L, 30_000L, 60_000L, 90_000L) else listOf(0L)
            val now = Repo.serverNow()
            // Offsets already in the past are skipped, but a request seen late still alerts once, immediately.
            val pending = offsets.filter { r.createdAt + it >= now - 1_000L }.ifEmpty { listOf(0L) }
            for (off in pending) {
                val wait = r.createdAt + off - Repo.serverNow()
                if (wait > 0) delay(wait)
                val cur = Repo.current(r.id) ?: break
                if (cur.status != "sent" || !cur.isOpen(Repo.serverNow())) break
                notify(app, cur)
            }
            jobs.remove(r.id)
        }
    }

    fun stop(ctx: Context, id: String) {
        jobs.remove(id)?.cancel()
        NotificationManagerCompat.from(ctx).cancel(id.hashCode())
    }

    fun resetAll(ctx: Context) {
        jobs.values.forEach { it.cancel() }
        jobs.clear()
        handled.clear()
        NotificationManagerCompat.from(ctx).cancelAll()
    }

    private fun notify(ctx: Context, r: Req) {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        val open = Intent(ctx, MainActivity::class.java).apply {
            putExtra("hash", r.hash)
            putExtra("rid", r.id)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val pi = PendingIntent.getActivity(
            ctx, r.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL_REQUESTS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("طلب تواصل جديد")
            .setContentText(Strs.reasons[r.reason] ?: Strs.reasons.getValue("other"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setContentIntent(pi)
            .build()
        try {
            nm.notify(r.id.hashCode(), n)
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
