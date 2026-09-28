package com.keepwork.localhelper.policy

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.UserManager
import com.keepwork.localhelper.AppLog
import com.keepwork.localhelper.BuildConfig

class DevicePolicyController(private val context: Context) {
    private val manager = context.getSystemService(DevicePolicyManager::class.java)
    private val admin = ComponentName(context, KeepworkDeviceAdminReceiver::class.java)

    val isDeviceOwner: Boolean get() = manager.isDeviceOwnerApp(context.packageName)

    fun applyManagedPolicies(): Boolean {
        if (!isDeviceOwner) {
            AppLog.warn("policy.skipped", "application is not Device Owner")
            return false
        }
        return runCatching {
            manager.setUninstallBlocked(admin, context.packageName, true)
            manager.addUserRestriction(admin, UserManager.DISALLOW_APPS_CONTROL)
            manager.addUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT)
            manager.addUserRestriction(admin, UserManager.DISALLOW_FACTORY_RESET)
            if (!BuildConfig.DEBUG) manager.addUserRestriction(admin, UserManager.DISALLOW_DEBUGGING_FEATURES)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                manager.setUserControlDisabledPackages(admin, listOf(context.packageName))
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                manager.setPermissionGrantState(
                    admin,
                    context.packageName,
                    Manifest.permission.POST_NOTIFICATIONS,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                )
            }
            AppLog.info("policy.applied")
            true
        }.getOrElse {
            AppLog.error("policy.apply.failed", it)
            false
        }
    }

    @Suppress("DEPRECATION")
    fun releaseForAdministrator() {
        check(isDeviceOwner) { "Application is not Device Owner" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) manager.setUserControlDisabledPackages(admin, emptyList())
        for (restriction in listOf(
            UserManager.DISALLOW_APPS_CONTROL,
            UserManager.DISALLOW_SAFE_BOOT,
            UserManager.DISALLOW_FACTORY_RESET,
            UserManager.DISALLOW_DEBUGGING_FEATURES,
        )) manager.clearUserRestriction(admin, restriction)
        manager.setUninstallBlocked(admin, context.packageName, false)
        manager.clearDeviceOwnerApp(context.packageName)
        AppLog.warn("policy.released")
    }

    fun provisioningCommand(): String =
        "adb shell dpm set-device-owner ${context.packageName}/.policy.KeepworkDeviceAdminReceiver"
}
