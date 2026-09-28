package com.keepwork.localhelper.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.keepwork.localhelper.AppConstants
import com.keepwork.localhelper.AppLog
import com.keepwork.localhelper.BuildConfig
import com.keepwork.localhelper.policy.DevicePolicyController
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest

class UpdateWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        if (!DevicePolicyController(applicationContext).isDeviceOwner) return Result.success()
        return runCatching {
            val release = loadManifest()
            if (release.versionCode <= BuildConfig.VERSION_CODE) return Result.success()
            val apk = download(release)
            verifyPackageSignature(apk, release)
            install(apk, release)
            Result.success()
        }.getOrElse {
            AppLog.error("update.failed", it)
            Result.retry()
        }
    }

    private data class Release(val version: String, val versionCode: Int, val url: String, val size: Long, val sha256: String)

    private fun loadManifest(): Release {
        val connection = URL(MANIFEST_URL).openConnection() as HttpURLConnection
        connection.connectTimeout = 8_000
        connection.readTimeout = 10_000
        connection.useCaches = false
        connection.setRequestProperty("Cache-Control", "no-cache")
        require(connection.responseCode == 200) { "Update manifest HTTP ${connection.responseCode}" }
        val value = connection.inputStream.use { JSONObject(String(it.readBytes(), Charsets.UTF_8)) }
        val version = value.getString("version")
        val fileName = "KP-Local-Helper-Android-$version-arm64-v8a.apk"
        val url = URI(value.getString("url"))
        require(value.getInt("schemaVersion") == 1 && value.getString("product") == "kp-local-helper-android")
        require(value.getString("channel") == "internal" && value.getBoolean("signed"))
        require(value.getString("platform") == "android" && value.getString("arch") == "arm64-v8a")
        require(value.getString("installerType") == "apk" && value.getString("fileName") == fileName)
        require(value.getJSONArray("capabilities").let { array ->
            (0 until array.length()).map(array::getString).containsAll(listOf("mcp", "local-model"))
        })
        require(value.getString("localModelProtocolVersion") == AppConstants.MODEL_PROTOCOL_VERSION)
        require(url.scheme == "https" && url.host == "cdn.keepwork.com" && url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null)
        require(url.path == "/keepwork/KP-Local-Helper-Android/$fileName")
        val sha = value.getString("sha256")
        require(sha.matches(Regex("[a-f0-9]{64}")))
        val size = value.getLong("size")
        require(size in 1..MAX_APK_BYTES)
        return Release(version, value.getInt("versionCode"), url.toString(), size, sha)
    }

    private fun download(release: Release): File {
        val target = File(applicationContext.cacheDir, "kp-local-helper-update.apk")
        val temporary = File(applicationContext.cacheDir, "kp-local-helper-update.apk.part")
        temporary.delete()
        val digest = MessageDigest.getInstance("SHA-256")
        val connection = URL(release.url).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        require(connection.responseCode == 200) { "APK download HTTP ${connection.responseCode}" }
        var total = 0L
        connection.inputStream.use { input ->
            temporary.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= release.size && total <= MAX_APK_BYTES) { "APK download exceeds declared size" }
                    digest.update(buffer, 0, count)
                    output.write(buffer, 0, count)
                }
            }
        }
        require(total == release.size) { "APK size mismatch" }
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        require(actual == release.sha256) { "APK SHA-256 mismatch" }
        if (target.exists()) target.delete()
        require(temporary.renameTo(target)) { "Unable to finalize downloaded APK" }
        return target
    }

    @Suppress("DEPRECATION")
    private fun verifyPackageSignature(apk: File, release: Release) {
        val manager = applicationContext.packageManager
        val current = if (Build.VERSION.SDK_INT >= 33) {
            manager.getPackageInfo(applicationContext.packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        } else manager.getPackageInfo(applicationContext.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        val candidate = if (Build.VERSION.SDK_INT >= 33) {
            manager.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        } else manager.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)
        val candidateInfo = candidate ?: throw IllegalArgumentException("Update APK package metadata is missing")
        require(candidateInfo.packageName == applicationContext.packageName) { "Update APK package name mismatch" }
        require(candidateInfo.longVersionCode == release.versionCode.toLong()) { "Update APK versionCode mismatch" }
        fun certs(info: android.content.pm.PackageInfo) = info.signingInfo.apkContentsSigners.map { certificate ->
            MessageDigest.getInstance("SHA-256").digest(certificate.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
        require(certs(current) == certs(candidateInfo)) { "Update APK signing certificate mismatch" }
    }

    private fun install(apk: File, release: Release) {
        val installer = applicationContext.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(applicationContext.packageName)
            setSize(release.size)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("base.apk", 0, release.size).use { output ->
                apk.inputStream().use { it.copyTo(output) }
                session.fsync(output)
            }
            val callback = PendingIntent.getBroadcast(
                applicationContext,
                sessionId,
                Intent(applicationContext, UpdateResultReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            session.commit(callback.intentSender)
        }
        AppLog.info("update.commit", "${release.version} (${release.versionCode})")
    }

    companion object {
        private const val MANIFEST_URL = "https://cdn.keepwork.com/keepwork/KP-Local-Helper-Android/latest.json"
        private const val MAX_APK_BYTES = 250L * 1024 * 1024
    }
}
