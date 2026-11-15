package com.keepwork.aipet.dev

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*
import android.provider.Settings
import android.view.WindowManager
import android.view.Display
import android.hardware.display.DisplayManager
import com.keepwork.aipet.core.*

/** Development-only specialUse FGS. No audio/network, persistent admission, boot receiver or restart. */
class OverlayService : Service() {
    companion object {
        const val START = "com.keepwork.aipet.dev.SHOW"
        const val STOP = "com.keepwork.aipet.dev.STOP"
        const val CHANNEL = "dev-overlay"
        val gate = OverlayStartGate()
        fun notificationsAllowed(context: android.content.Context): Boolean {
            val manager = context.getSystemService(NotificationManager::class.java)
            return manager.areNotificationsEnabled() &&
                (manager.getNotificationChannel(CHANNEL)?.importance ?: NotificationManager.IMPORTANCE_LOW) != NotificationManager.IMPORTANCE_NONE
        }
    }
    private var owner: OverlayOwner? = null
    private var driver: DevOverlay? = null
    private val languageListener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == DevLanguage.KEY && owner?.showing == true && !ending) {
            driver?.refreshLabels()
            getSystemService(NotificationManager::class.java).notify(41, notification())
        }
    }
    private var displays: DisplayManager? = null
    private var displayId = -1
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(id: Int) {}
        override fun onDisplayChanged(id: Int) {}
        override fun onDisplayRemoved(id: Int) { if (id == displayId) finish() }
    }
    private val handler = Handler(Looper.getMainLooper())
    private var ending = false
    private val watchdog = object : Runnable {
        override fun run() {
            if (!Settings.canDrawOverlays(this@OverlayService) || !notificationsAllowed(this@OverlayService)) finish()
            else if (!ending) handler.postDelayed(this, 1000)
        }
    }
    override fun onCreate() {
        super.onCreate()
        try {
            val manager = getSystemService(DisplayManager::class.java)
            val display = manager.getDisplay(Display.DEFAULT_DISPLAY)
            if (display == null) { finish(); return }
            displayId = display.displayId
            val context = if (Build.VERSION.SDK_INT >= 30)
                createDisplayContext(display).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
                else this
            driver = DevOverlay(context) { finish() }
            owner = OverlayOwner(driver!!)
            DevLanguage.prefs(this).registerOnSharedPreferenceChangeListener(languageListener)
            displays = manager
            manager.registerDisplayListener(displayListener, handler)
        } catch (_: RuntimeException) { finish() }

    }
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { gate.cancel(); finish(); return START_NOT_STICKY }
        if (intent?.action != START || !gate.consume(intent.getStringExtra("admission"))) {
            // Unknown/OS-redelivered commands cannot resurrect a service after process recreation.
            if (owner?.showing != true) finish()
            return START_NOT_STICKY
        }
        if (ending || owner == null || !Settings.canDrawOverlays(this) || !notificationsAllowed(this)) { finish(); return START_NOT_STICKY }
        try {
            val notification = notification()
            if (Build.VERSION.SDK_INT >= 34) startForeground(41, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(41, notification)
            if (owner?.show(true, true) != true) finish()
            else { handler.removeCallbacks(watchdog); handler.post(watchdog) }
        } catch (_: RuntimeException) { finish() } // Native admission/window failure leaves no owned resources.
        return START_NOT_STICKY
    }
    private fun notification(): Notification {
        val copy = DevLanguage.wrap(this)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, copy.getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 1, Intent(this, OverlayService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(copy.getString(R.string.notification_title))
            .setContentText(copy.getString(R.string.notification_body))
            .setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, copy.getString(R.string.notification_stop), stop).build()).build()
    }
    private fun finish() {
        if (ending) return
        ending = true
        gate.cancel()
        handler.removeCallbacks(watchdog)
        owner?.stop()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
    override fun onDestroy() {
        DevLanguage.prefs(this).unregisterOnSharedPreferenceChangeListener(languageListener)
        displays?.unregisterDisplayListener(displayListener)
        handler.removeCallbacks(watchdog)
        owner?.stop()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
