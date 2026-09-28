package com.keepwork.localhelper.model

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import com.keepwork.localhelper.AppConstants
import com.keepwork.localhelper.AppLog
import com.keepwork.localhelper.service.NotificationFactory
import com.keepwork.localhelper.service.ServiceProbe
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class LocalModelService : Service() {
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private var engine: SpeakerEngine? = null
    private var server: LocalModelHttpServer? = null
    private var backoffSeconds = 1L

    override fun onCreate() {
        super.onCreate()
        NotificationFactory.ensureChannel(this)
        ServiceCompat.startForeground(
            this,
            AppConstants.MODEL_NOTIFICATION_ID,
            NotificationFactory.model(this),
            if (android.os.Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
        scheduler.execute(::ensureServer)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        scheduler.execute(::ensureServer)
        return START_STICKY
    }

    private fun ensureServer() {
        if (server != null) return
        if (ServiceProbe.compatibleModel()) {
            AppLog.info("local-model.attached", "compatible service already owns port ${AppConstants.MODEL_PORT}")
            stopSelf()
            return
        }
        try {
            val verified = ModelIntegrity.verify(this)
            val newEngine = SpeakerEngine(this, verified)
            val newServer = LocalModelHttpServer(newEngine)
            newServer.start()
            engine = newEngine
            server = newServer
            backoffSeconds = 1
            AppLog.info("local-model.ready", "${verified.id}@${verified.version}")
        } catch (error: Throwable) {
            AppLog.error("local-model.start.failed", error)
            val delay = backoffSeconds
            backoffSeconds = (backoffSeconds * 2).coerceAtMost(30)
            scheduler.schedule(::ensureServer, delay, TimeUnit.SECONDS)
        }
    }

    override fun onDestroy() {
        server?.close()
        engine?.close()
        server = null
        engine = null
        scheduler.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
