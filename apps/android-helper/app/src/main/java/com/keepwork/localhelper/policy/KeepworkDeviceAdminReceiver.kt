package com.keepwork.localhelper.policy

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import com.keepwork.localhelper.AppLog
import com.keepwork.localhelper.service.SupervisorService

class KeepworkDeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        AppLog.info("policy.enabled")
        DevicePolicyController(context).applyManagedPolicies()
        SupervisorService.start(context)
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        AppLog.info("policy.provisioning.complete")
        DevicePolicyController(context).applyManagedPolicies()
        SupervisorService.start(context)
    }
}
