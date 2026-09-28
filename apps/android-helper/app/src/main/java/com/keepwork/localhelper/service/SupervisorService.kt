package com.keepwork.localhelper.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.keepwork.localhelper.AppConstants
import com.keepwork.localhelper.AppLog
import com.keepwork.localhelper.mcp.McpServer
import com.keepwork.localhelper.model.LocalModelService
import com.keepwork.localhelper.policy.DevicePolicyController
import com.keepwork.localhelper.update.UpdateScheduler
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class SupervisorService : Service() {
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private var mcp: McpServer? = null
    private var mcpBackoff = 1L
    private var modelMisses = 0

    override fun onCreate() {
        super.onCreate()
        NotificationFactory.ensureChannel(this)
        ServiceCompat.startForeground(
            this,
            AppConstants.SUPERVISOR_NOTIFICATION_ID,
            NotificationFactory.supervisor(this),
            if (android.os.Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
        DevicePolicyController(this).applyManagedPolicies()
        UpdateScheduler.ensure(this)
        scheduler.execute(::ensureMcp)
        scheduler.scheduleWithFixedDelay(::watchModel, 0, 5, TimeUnit.SECONDS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            AppConstants.ACTION_ADMIN_RESTART -> scheduler.execute(::restartOwnedServices)
            else -> scheduler.execute {
                ensureMcp()
                watchModel()
            }
        }
        return START_STICKY
    }

    private fun ensureMcp() {
        if (mcp != null || ServiceProbe.compatibleMcp()) return
        try {
            val newServer = McpServer(this)
            newServer.start()
            mcp = newServer
            mcpBackoff = 1
        } catch (error: Throwable) {
            AppLog.error("mcp.start.failed", error)
            val delay = mcpBackoff
            mcpBackoff = (mcpBackoff * 2).coerceAtMost(30)
            scheduler.schedule(::ensureMcp, delay, TimeUnit.SECONDS)
        }
    }

    private fun watchModel() {
        if (ServiceProbe.compatibleModel()) {
            modelMisses = 0
            return
        }
        modelMisses += 1
        if (modelMisses == 1 || modelMisses % 6 == 0) AppLog.warn("local-model.unavailable", "attempt=$modelMisses")
        startModelService()
    }

    private fun startModelService() {
        ContextCompat.startForegroundService(this, Intent(this, LocalModelService::class.java))
    }

    private fun restartOwnedServices() {
        AppLog.warn("admin.restart")
        mcp?.close()
        mcp = null
        stopService(Intent(this, LocalModelService::class.java))
        modelMisses = 0
        scheduler.schedule(::ensureMcp, 500, TimeUnit.MILLISECONDS)
        scheduler.schedule(::startModelService, 500, TimeUnit.MILLISECONDS)
    }

    override fun onDestroy() {
        mcp?.close()
        mcp = null
        scheduler.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, SupervisorService::class.java))
        }
    }
}
