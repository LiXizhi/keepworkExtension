package com.keepwork.aipet.dev

import android.animation.ValueAnimator
import android.app.KeyguardManager
import android.content.Context
import android.graphics.*
import android.os.PowerManager
import android.view.View
import com.keepwork.aipet.core.*

/** Original circles/triangles, drawn only on invalidation. No timer, animator, bitmap, microphone or catalog asset. */
class DeveloperPetView(context: Context) : View(context) {
    var pose = Pose.IDLE; set(value) { field = value; invalidate() }
    var level = 0f; set(value) { field = value; invalidate() }
    var active = false; set(value) { field = value; invalidate() }
    var reducedMotion = false; set(value) { field = value; invalidate() }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (!isShown || windowVisibility != VISIBLE) return
        val power = context.getSystemService(PowerManager::class.java)
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        val mouth = PreviewGate(isAttachedToWindow, isShown, active, power.isInteractive, keyguard.isKeyguardLocked,
            reducedMotion, ValueAnimator.areAnimatorsEnabled()).mouth(pose, level)
        val size = minOf(width, height).toFloat(); val left = (width-size)/2; val top = (height-size)/2
        canvas.save(); canvas.translate(left,top); canvas.scale(size/200f,size/200f)
        fun color(value: Int) { paint.color = value; paint.style = Paint.Style.FILL; paint.strokeWidth = 5f }
        color(if (pose == Pose.ERROR) Color.rgb(167,54,73) else Color.rgb(67,79,169))
        val ears = Path().apply { moveTo(38f,76f); lineTo(42f,22f); lineTo(80f,55f); close(); moveTo(120f,55f); lineTo(158f,22f); lineTo(162f,76f); close() }
        canvas.drawPath(ears,paint); canvas.drawRoundRect(30f,48f,170f,176f,48f,48f,paint)
        color(Color.WHITE)
        if (pose == Pose.SLEEPING) { canvas.drawLine(61f,100f,80f,100f,paint); canvas.drawLine(120f,100f,139f,100f,paint) }
        else { canvas.drawCircle(70f,100f,if (pose==Pose.LISTENING) 12f else 8f,paint); canvas.drawCircle(130f,100f,8f,paint) }
        paint.style = Paint.Style.STROKE
        when (pose) {
            Pose.HAPPY -> canvas.drawArc(75f,115f,125f,150f,0f,180f,false,paint)
            Pose.SPEAKING -> canvas.drawOval(88f,126f-mouth*12f,112f,133f+mouth*18f,paint)
            Pose.ERROR -> { canvas.drawLine(87f,123f,113f,143f,paint); canvas.drawLine(87f,143f,113f,123f,paint) }
            else -> canvas.drawLine(87f,134f,113f,134f,paint)
        }
        paint.style = Paint.Style.FILL
        if (pose == Pose.THINKING) repeat(3) { canvas.drawCircle(82f+18*it,27f,4f,paint) }
        if (pose == Pose.LISTENING) { paint.style=Paint.Style.STROKE; canvas.drawArc(13f,78f,43f,123f,100f,160f,false,paint) }
        canvas.restore()
    }
    override fun onWindowVisibilityChanged(visibility: Int) { super.onWindowVisibilityChanged(visibility); invalidate() }
    override fun onDetachedFromWindow() { active = false; super.onDetachedFromWindow() }
}
