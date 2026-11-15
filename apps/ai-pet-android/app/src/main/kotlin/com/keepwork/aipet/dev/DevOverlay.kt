package com.keepwork.aipet.dev

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.view.*
import android.widget.TextView
import com.keepwork.aipet.core.*

/** Native window driver owned only by OverlayService. */
class DevOverlay(private val activity: Context, private val stop: () -> Unit) : OverlayDriver {
    private val manager = activity.getSystemService(WindowManager::class.java)
    private var view: DeveloperPetView? = null
    private val width = (112 * activity.resources.displayMetrics.density).toInt()
    private val height = (112 * activity.resources.displayMetrics.density).toInt()
    private val drag = OverlayDrag(ViewConfiguration.get(activity).scaledTouchSlop.toFloat())
    private val params = WindowManager.LayoutParams(width, height,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            title = "AI Pet development overlay"
            x = 32; y = 140
        }
    override fun attach(): Boolean {
        val pet = DeveloperPetView(activity).apply {
            contentDescription = DevLanguage.wrap(activity).getString(R.string.overlay_description)
            active = false // Static idle artwork; overlay never schedules animation.
            setOnClickListener { stop() }
            setOnTouchListener { target, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> { drag.down(event.rawX, event.rawY, Point(params.x, params.y)); true }
                    MotionEvent.ACTION_MOVE -> {
                        drag.move(event.rawX, event.rawY, bounds())?.let { point ->
                            params.x = point.x; params.y = point.y
                            try { manager.updateViewLayout(target, params) }
                            catch (_: SecurityException) { stop() }
                            catch (_: IllegalArgumentException) { stop() }
                        }
                        true
                    }
                    MotionEvent.ACTION_UP -> { if (drag.up()) target.performClick(); true }
                    MotionEvent.ACTION_CANCEL -> { drag.cancel(); true }
                    else -> false
                }
            }
        }
        val initial = bounds().clamp(Point(params.x, params.y)); params.x = initial.x; params.y = initial.y
        return try { manager.addView(pet, params); view = pet; true }
        catch (_: SecurityException) { false }
        catch (_: WindowManager.BadTokenException) { false }
        catch (_: WindowManager.InvalidDisplayException) { false }
    }
    fun refreshLabels() { view?.contentDescription = DevLanguage.wrap(activity).getString(R.string.overlay_description) }
    override fun detach() {
        drag.cancel()
        val attached = view; view = null
        if (attached != null) try { manager.removeViewImmediate(attached) }
        catch (_: IllegalArgumentException) { /* OS already removed the window. */ }
    }
    @Suppress("DEPRECATION")
    private fun bounds(): DragBounds {
        if (Build.VERSION.SDK_INT >= 30) {
            val metrics = manager.currentWindowMetrics
            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            return DragBounds(insets.left, insets.top,
                (metrics.bounds.width() - insets.right - width).coerceAtLeast(insets.left),
                (metrics.bounds.height() - insets.bottom - height).coerceAtLeast(insets.top))
        }
        val size = android.graphics.Point(); manager.defaultDisplay.getSize(size)
        return DragBounds(0, 0, (size.x - width).coerceAtLeast(0), (size.y - height).coerceAtLeast(0))
    }
}
