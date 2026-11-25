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

    /** True while the activity is on screen. */
    var visible = false

    fun isShowing(rid: String): Boolean = visible && (screen as? Screen.Request)?.rid == rid
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
        // On recreation (rotation, theme change) the old intent must not override where the user is now.
        if (savedInstanceState == null) handle(intent)
        setContent { App() }
    }

    override fun onStart() {
        super.onStart()
        Nav.visible = true
        (Nav.screen as? Screen.Request)?.let { Alerts.stopMessage(this, it.rid) }
        // Android may have refused or stopped the background service; being visible is a safe moment to restart it.
        if (Repo.uid != null && Repo.cars.isNotEmpty()) Alerts.startService(this)
    }

    override fun onStop() {
        Nav.visible = false
        super.onStop()
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
