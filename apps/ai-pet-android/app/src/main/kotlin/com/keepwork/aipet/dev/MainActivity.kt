package com.keepwork.aipet.dev

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.widget.*
import com.keepwork.aipet.core.*

/** Local fake voice controls and explicit admission to the synthetic overlay service. */
class MainActivity : Activity() {
    private val audio = FakeAudio()
    private val authority = FakeLeaseAuthority()
    private val transport = FakeTransport(authority::release)
    private val voice = VoiceOwner(audio, transport, SystemClock::elapsedRealtime)
    private val binding = Binding("dev-account", "dev-placeholder", "dev-conversation")
    private val admission = Admission(true, true, true, true)
    private lateinit var status: TextView
    private lateinit var overlayStatus: TextView
    private var resumed = false
    private val handler = Handler(Looper.getMainLooper())
    private val watchdog = object : Runnable {
        override fun run() { render(); handler.postDelayed(this, 500) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        panel.addView(TextView(this).apply {
            text = "AI Pet · 0.1.0-dev.3\nOffline development simulator\nNo login, microphone, AI service or purchases.\nCharacter: geometric developer placeholder."
            textSize = 20f
        })
        panel.addView(Spinner(this).apply {
            contentDescription = "Development locale identifier (interface translation pending)"
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, PetLocale.entries.map { it.tag })
        })
        status = TextView(this).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        panel.addView(status)
        overlayStatus = TextView(this).apply {
            text = "Synthetic cross-app overlay with Stop notification. No microphone; store qualification pending."
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        panel.addView(overlayStatus)
        fun button(label: String, action: () -> Unit) {
            panel.addView(Button(this).apply { text = label; setOnClickListener { action(); render() } })
        }
        button("Overlay permission settings") {
            try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) }
            catch (_: ActivityNotFoundException) { overlayStatus.text = "Overlay settings unavailable. In-app controls remain available." }
        }
        button("Allow overlay notifications") {
            if (android.os.Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 42)
            else overlayStatus.text = "Enable notifications in system app settings. Then explicitly press Show."
        }
        button("Show development overlay") {
            if (!resumed || !Settings.canDrawOverlays(this)) overlayStatus.text = "Overlay permission not granted. In-app controls remain available."
            else if (!OverlayService.notificationsAllowed(this)) overlayStatus.text = "Allow notifications so the Stop control stays available, then press Show again."
            else {
                val token = OverlayService.gate.issue()
                try {
                    startForegroundService(Intent(this, OverlayService::class.java).setAction(OverlayService.START).putExtra("admission", token))
                    overlayStatus.text = "Requested synthetic overlay. It may remain on Home; stop in-app, on the pet, or in its notification."
                } catch (_: RuntimeException) {
                    OverlayService.gate.cancel()
                    overlayStatus.text = "Native service start unavailable. In-app controls remain available."
                }
            }
        }
        button("Remove development overlay") { stopOverlay() }
        button("Start simulated session") {
            voice.start(binding, admission)?.let { ticket ->
                val grant = authority.acquire(binding, SystemClock.elapsedRealtime())
                if (grant == null) voice.end() else voice.grant(ticket, grant, admission)
            }
        }
        button("Simulate reply") { voice.key?.let { voice.audioChunk(it, 0) } }
        button("Simulate spoken interruption") { voice.spokenInterruption() }
        button("Simulate network interruption") { voice.pause(PauseReason.NETWORK) }
        button("Restore fake transport") { voice.transportRestored() }
        button("Resume deliberately") { voice.resume(admission) }
        button("Toggle mute") { voice.mute(!voice.state.muted) }
        button("Stop") { voice.end() }
        setContentView(ScrollView(this).apply { addView(panel) })
        watchdog.run()
    }
    // Lint's listener-identity heuristic is inapplicable: this is an explicit component Intent, not a SAM listener.
    @android.annotation.SuppressLint("ImplicitSamInstance")
    private fun stopOverlay() {
        OverlayService.gate.cancel()
        stopService(Intent(this, OverlayService::class.java))
        overlayStatus.text = "Overlay service stopped."
    }
    private fun render() { voice.tick(); status.text = "${voice.state}\nFake capture: ${audio.capturing}" }
    override fun onResume() { super.onResume(); resumed = true }
    override fun onStop() { resumed = false; super.onStop() }
    override fun onDestroy() { handler.removeCallbacks(watchdog); voice.end(); super.onDestroy() }
}
