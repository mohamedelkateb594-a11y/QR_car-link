package com.mohamed.qrcar

import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** Keeps the process alive so Repo's Firebase listeners and Alerts' timers keep running in the background. */
class AlertService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(this, Alerts.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("QR Car يستقبل الطلبات")
            .setContentText("التطبيق يعمل في الخلفية لاستقبال طلبات التواصل")
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
        try {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } catch (e: Exception) {
            // Android refuses a foreground start from the background (e.g. a sticky restart): give up quietly.
            stopSelf()
        }
        return START_STICKY
    }
}
