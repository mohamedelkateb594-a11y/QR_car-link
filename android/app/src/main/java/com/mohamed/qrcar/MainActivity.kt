package com.mohamed.qrcar

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat

sealed interface Screen {
    data object Home : Screen
    data object Settings : Screen
    data class Qr(val carId: String) : Screen
    data class Request(val hash: String, val rid: String) : Screen
}

object Nav {
    var screen by mutableStateOf<Screen>(Screen.Home)
}

class MainActivity : ComponentActivity() {
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        handle(intent)
        setContent { App() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    /** Tapping an alert notification opens that request. */
    private fun handle(i: Intent?) {
        val hash = i?.getStringExtra("hash")
        val rid = i?.getStringExtra("rid")
        if (hash != null && rid != null) Nav.screen = Screen.Request(hash, rid)
    }
}
