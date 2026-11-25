package com.mohamed.qrcar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.firebase.auth.FirebaseAuth

/** Resumes receiving requests after a reboot or an app update, without waiting for the owner to open the app. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val user = FirebaseAuth.getInstance().currentUser
        if (user != null && !user.isAnonymous) Alerts.startService(context)
    }
}
