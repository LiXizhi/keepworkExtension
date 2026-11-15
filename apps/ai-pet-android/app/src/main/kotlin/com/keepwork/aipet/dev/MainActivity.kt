package com.keepwork.aipet.dev

import android.app.Activity
import android.content.Context
import android.database.ContentObserver
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
    private lateinit var pet: DeveloperPetView
    private var pose = Pose.IDLE
    private var mouthLevel = 0f
    private var previewVisible = true
    private val motionObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) { updatePet() }
    }
    override fun attachBaseContext(base: Context) { super.attachBaseContext(DevLanguage.wrap(base)) }
    private fun updatePet() {
        if (!::pet.isInitialized) return
        pet.pose = pose; pet.level = mouthLevel; pet.active = resumed
        pet.reducedMotion = DevLanguage.prefs(this).getBoolean("reduce-motion", false)
        pet.visibility = if (previewVisible) View.VISIBLE else View.GONE
        pet.contentDescription = getString(R.string.pet_description, getString(poseLabels[pose.ordinal]))
    }
    private val poseLabels = intArrayOf(R.string.pose_idle, R.string.pose_happy, R.string.pose_listening,
        R.string.pose_thinking, R.string.pose_speaking, R.string.pose_sleeping, R.string.pose_error)
    private val handler = Handler(Looper.getMainLooper())
    private val watchdog = object : Runnable {
        override fun run() { render(); handler.postDelayed(this, 500) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        panel.addView(TextView(this).apply {
            text = getString(R.string.intro, packageManager.getPackageInfo(packageName, 0).versionName)
            textSize = 20f
        })
        val languages = DevLanguage.preference(this)
        panel.addView(TextView(this).apply { setText(R.string.language); labelFor = R.id.language_picker })
        panel.addView(Spinner(this).apply {
            id = R.id.language_picker
            minimumHeight = (48 * resources.displayMetrics.density).toInt()
            contentDescription = getString(R.string.language)
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, resources.getStringArray(R.array.language_names))
            setSelection(languages.locale.ordinal)
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) {}
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, itemId: Long) {
                    val chosen = PetLocale.entries[position]
                    if (chosen != languages.locale) {
                        if (languages.select(chosen)) recreate()
                        else Toast.makeText(this@MainActivity, R.string.language_failed, Toast.LENGTH_LONG).show()
                    }
                }
            }
        })
        panel.addView(TextView(this).apply { setText(R.string.preview); textSize = 20f })
        panel.addView(TextView(this).apply { setText(R.string.preview_help) })
        pet = DeveloperPetView(this).apply { id = R.id.pet_preview; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES }
        panel.addView(pet, LinearLayout.LayoutParams(-1, (180 * resources.displayMetrics.density).toInt()))
        panel.addView(TextView(this).apply { setText(R.string.pose); labelFor = R.id.pose_picker })
        panel.addView(Spinner(this).apply {
            id = R.id.pose_picker; contentDescription = getString(R.string.pose)
            minimumHeight = (48 * resources.displayMetrics.density).toInt()
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, poseLabels.map { getString(it) })
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) {}
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, itemId: Long) { pose = Pose.entries[position]; updatePet() }
            }
        })
        panel.addView(TextView(this).apply { setText(R.string.mouth); labelFor = R.id.mouth_level })
        panel.addView(SeekBar(this).apply {
            id = R.id.mouth_level; max = 100; contentDescription = getString(R.string.mouth)
            minimumHeight = (48 * resources.displayMetrics.density).toInt()
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onStartTrackingTouch(view: SeekBar?) {}
                override fun onStopTrackingTouch(view: SeekBar?) {}
                override fun onProgressChanged(view: SeekBar?, progress: Int, fromUser: Boolean) { mouthLevel = progress / 100f; updatePet() }
            })
        })
        panel.addView(Switch(this).apply {
            id = R.id.reduce_motion; setText(R.string.reduce_motion); minimumHeight = (48 * resources.displayMetrics.density).toInt()
            isChecked = DevLanguage.prefs(this@MainActivity).getBoolean("reduce-motion", false)
            setOnCheckedChangeListener { _, value -> DevLanguage.prefs(this@MainActivity).edit().putBoolean("reduce-motion", value).apply(); updatePet() }
        })
        panel.addView(Switch(this).apply {
            id = R.id.preview_visible; setText(R.string.preview_visible); isChecked = true; minimumHeight = (48 * resources.displayMetrics.density).toInt()
            setOnCheckedChangeListener { _, value -> previewVisible = value; updatePet() }
        })
        status = TextView(this).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        panel.addView(status)
        overlayStatus = TextView(this).apply {
            text = getString(R.string.overlay_help)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        panel.addView(overlayStatus)
        fun button(label: Int, action: () -> Unit) {
            panel.addView(Button(this).apply { setText(label); minimumHeight = (48 * resources.displayMetrics.density).toInt(); setOnClickListener { action(); render() } })
        }
        button(R.string.overlay_settings) {
            try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) }
            catch (_: ActivityNotFoundException) { overlayStatus.text = getString(R.string.settings_unavailable) }
        }
        button(R.string.notification_allow) {
            if (android.os.Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 42)
            else overlayStatus.text = getString(R.string.notifications_needed)
        }
        button(R.string.show_overlay) {
            if (!resumed || !Settings.canDrawOverlays(this)) overlayStatus.text = getString(R.string.permission_denied)
            else if (!OverlayService.notificationsAllowed(this)) overlayStatus.text = getString(R.string.notifications_needed)
            else {
                val token = OverlayService.gate.issue()
                try {
                    startForegroundService(Intent(this, OverlayService::class.java).setAction(OverlayService.START).putExtra("admission", token))
                    overlayStatus.text = getString(R.string.overlay_requested)
                } catch (_: RuntimeException) {
                    OverlayService.gate.cancel()
                    overlayStatus.text = getString(R.string.start_unavailable)
                }
            }
        }
        button(R.string.remove_overlay) { stopOverlay() }
        button(R.string.start_fake) {
            voice.start(binding, admission)?.let { ticket ->
                val grant = authority.acquire(binding, SystemClock.elapsedRealtime())
                if (grant == null) voice.end() else voice.grant(ticket, grant, admission)
            }
        }
        button(R.string.reply_fake) { voice.key?.let { voice.audioChunk(it, 0) } }
        button(R.string.interrupt_fake) { voice.spokenInterruption() }
        button(R.string.network_fake) { voice.pause(PauseReason.NETWORK) }
        button(R.string.restore_fake) { voice.transportRestored() }
        button(R.string.resume_fake) { voice.resume(admission) }
        button(R.string.mute_fake) { voice.mute(!voice.state.muted) }
        button(R.string.stop_fake) { voice.end() }
        val scroll = ScrollView(this).apply {
            addView(panel)
            setOnApplyWindowInsetsListener { view, insets ->
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
                    view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                } else {
                    @Suppress("DEPRECATION")
                    view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                        insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                }
                insets
            }
        }
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        setContentView(scroll)
        scroll.requestApplyInsets()
        updatePet()
    }
    // Lint's listener-identity heuristic is inapplicable: this is an explicit component Intent, not a SAM listener.
    @android.annotation.SuppressLint("ImplicitSamInstance")
    private fun stopOverlay() {
        OverlayService.gate.cancel()
        stopService(Intent(this, OverlayService::class.java))
        overlayStatus.text = getString(R.string.overlay_stopped)
    }
    private fun render() {
        voice.tick()
        val label = when (voice.state.session) {
            Session.ACTIVE -> R.string.session_active
            Session.CONNECTING -> R.string.session_connecting
            Session.PAUSED -> R.string.session_paused
            Session.ENDED -> R.string.session_ended
        }
        val next = getString(R.string.fake_status, getString(label), getString(if (audio.capturing) R.string.yes else R.string.no))
        if (status.text.toString() != next) status.text = next
    }
    override fun onResume() {
        super.onResume(); resumed = true; updatePet()
        contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, motionObserver)
        handler.removeCallbacks(watchdog); watchdog.run()
    }
    override fun onPause() { resumed = false; updatePet(); contentResolver.unregisterContentObserver(motionObserver); super.onPause() }
    override fun onStop() { handler.removeCallbacks(watchdog); super.onStop() }
    override fun onDestroy() { handler.removeCallbacks(watchdog); voice.end(); super.onDestroy() }
}
