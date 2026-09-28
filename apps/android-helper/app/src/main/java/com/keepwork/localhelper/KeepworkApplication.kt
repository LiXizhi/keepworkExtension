package com.keepwork.localhelper

import android.app.Application
import com.keepwork.localhelper.service.NotificationFactory
import com.keepwork.localhelper.service.SupervisorService

class KeepworkApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        NotificationFactory.ensureChannel(this)
        if (Application.getProcessName() == packageName) runCatching { SupervisorService.start(this) }
            .onFailure { AppLog.error("supervisor.application-start.failed", it) }
    }
}
