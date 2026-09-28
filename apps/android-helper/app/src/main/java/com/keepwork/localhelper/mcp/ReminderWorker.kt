package com.keepwork.localhelper.mcp

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.keepwork.localhelper.AppConstants
import com.keepwork.localhelper.R
import com.keepwork.localhelper.service.NotificationFactory

class ReminderWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        NotificationFactory.ensureChannel(applicationContext)
        val title = inputData.getString("title") ?: "Keepwork 提醒"
        val text = inputData.getString("text") ?: ""
        val notification = NotificationCompat.Builder(applicationContext, AppConstants.NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_keepwork)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .build()
        applicationContext.getSystemService(NotificationManager::class.java)
            .notify((System.currentTimeMillis() and 0x7fffffff).toInt(), notification)
        return Result.success()
    }
}
