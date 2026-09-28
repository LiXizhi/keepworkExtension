package com.keepwork.localhelper.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.keepwork.localhelper.AppLog
import com.keepwork.localhelper.policy.DevicePolicyController

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AppLog.info("lifecycle.broadcast", intent.action.orEmpty())
        DevicePolicyController(context).applyManagedPolicies()
        SupervisorService.start(context)
    }
}
