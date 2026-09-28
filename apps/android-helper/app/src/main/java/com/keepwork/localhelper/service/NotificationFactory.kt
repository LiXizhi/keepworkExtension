package com.keepwork.localhelper.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.keepwork.localhelper.AppConstants
import com.keepwork.localhelper.MainActivity
import com.keepwork.localhelper.R

object NotificationFactory {
    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            AppConstants.NOTIFICATION_CHANNEL,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    fun supervisor(context: Context): Notification = notification(
        context,
        context.getString(R.string.notification_supervisor_title),
        context.getString(R.string.notification_supervisor_text),
    )

    fun model(context: Context): Notification = notification(
        context,
        context.getString(R.string.notification_model_title),
        context.getString(R.string.notification_model_text),
    )

    private fun notification(context: Context, title: String, text: String): Notification {
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, AppConstants.NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_keepwork)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}
