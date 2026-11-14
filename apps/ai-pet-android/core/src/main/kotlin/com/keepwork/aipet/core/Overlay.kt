package com.keepwork.aipet.core

/** Service-owned development overlay; returning from Settings never automatically shows it. */
interface OverlayDriver {
    fun attach(): Boolean
    fun detach()
}
class OverlayOwner(private val driver: OverlayDriver) {
    var showing = false; private set
    fun show(permission: Boolean, startEligible: Boolean): Boolean {
        if (!permission || !startEligible) { stop(); return false }
        if (showing) return true
        showing = driver.attach()
        return showing
    }
    fun reconcile(permission: Boolean, ownerAlive: Boolean) {
        if (!permission || !ownerAlive) stop()
    }
    fun stop() {
        if (showing) { showing = false; driver.detach() }
    }
}
data class Point(val x: Int, val y: Int)
data class DragBounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    init { require(right >= left && bottom >= top) }
    fun clamp(point: Point) = Point(point.x.coerceIn(left, right), point.y.coerceIn(top, bottom))
}
/** Screen-coordinate drag with a native touch-slop threshold. A drag is never a click. */
class OverlayDrag(private val slop: Float) {
    init { require(slop.isFinite() && slop >= 0) }
    private var start: Point? = null
    private var downX = 0f
    private var downY = 0f
    private var dragging = false
    fun down(rawX: Float, rawY: Float, position: Point) {
        cancel()
        if (rawX.isFinite() && rawY.isFinite()) { start = position; downX = rawX; downY = rawY }
    }
    fun move(rawX: Float, rawY: Float, bounds: DragBounds): Point? {
        val origin = start ?: return null
        if (!rawX.isFinite() || !rawY.isFinite()) { cancel(); return null }
        val dx = rawX - downX; val dy = rawY - downY
        if (dx * dx + dy * dy > slop * slop) dragging = true
        return if (dragging) bounds.clamp(Point(origin.x + dx.toInt(), origin.y + dy.toInt())) else null
    }
    fun up(): Boolean { val click = start != null && !dragging; cancel(); return click }
    fun cancel() { start = null; dragging = false }
}

/** Volatile one-use admission. A recreated process has a different nonce and cannot replay an intent. */
class OverlayStartGate(private val nonce: String = java.util.UUID.randomUUID().toString()) {
    private var sequence = 0L
    private var pending: String? = null
    @Synchronized fun issue(): String = "$nonce:${++sequence}".also { pending = it }
    @Synchronized fun consume(token: String?): Boolean {
        if (token == null || token != pending) return false
        pending = null
        return true
    }
    @Synchronized fun cancel() { pending = null }
}
