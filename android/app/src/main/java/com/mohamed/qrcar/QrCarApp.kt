package com.mohamed.qrcar

import android.app.Application

class QrCarApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Repo.init(this)
        Alerts.ensureChannels(this)
    }
}
