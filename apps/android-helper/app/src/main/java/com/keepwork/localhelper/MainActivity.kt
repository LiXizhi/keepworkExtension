package com.keepwork.localhelper

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.keepwork.localhelper.mcp.McpTokenStore
import com.keepwork.localhelper.mcp.SafRepository
import com.keepwork.localhelper.policy.AdminAccess
import com.keepwork.localhelper.policy.DevicePolicyController
import com.keepwork.localhelper.service.ServiceProbe
import com.keepwork.localhelper.service.SupervisorService
import com.keepwork.localhelper.update.UpdateScheduler
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var status: TextView
    private lateinit var folder: TextView
    private lateinit var token: TextView
    private var pendingLog: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SupervisorService.start(this)
        DevicePolicyController(this).applyManagedPolicies()
        setContentView(buildContent())
        refresh()
    }

    private fun buildContent(): ScrollView {
        val density = resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(40))
        }
        content.addView(TextView(this).apply {
            text = "KP Local Helper"
            textSize = 26f
            setTypeface(typeface, Typeface.BOLD)
        })
        content.addView(TextView(this).apply {
            text = "本机服务由设备管理员维护，应用关闭后仍会运行。"
            textSize = 15f
            setPadding(0, dp(8), 0, dp(24))
        })
        status = section("服务状态", content)
        folder = section("授权目录", content)
        content.addView(Button(this).apply {
            text = "选择授权目录"
            setOnClickListener { chooseFolder() }
        })
        token = section("AIChat MCP 配对令牌", content)
        content.addView(Button(this).apply {
            text = "复制配对令牌"
            setOnClickListener {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Keepwork MCP token", McpTokenStore(this@MainActivity).current()))
                Toast.makeText(this@MainActivity, "令牌已复制", Toast.LENGTH_SHORT).show()
            }
        })
        content.addView(Button(this).apply {
            text = "重新检查"
            setOnClickListener { refresh() }
        })
        content.addView(Button(this).apply {
            text = "管理员维护"
            setOnClickListener { openAdministrator() }
        })
        return ScrollView(this).apply { addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)) }
    }

    private fun section(title: String, parent: LinearLayout): TextView {
        parent.addView(TextView(this).apply {
            text = title
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, 16, 0, 6)
        })
        return TextView(this).also {
            it.textSize = 15f
            it.setTextIsSelectable(true)
            it.setPadding(0, 0, 0, 12)
            parent.addView(it)
        }
    }

    private fun refresh() {
        status.text = "正在检查 8089 和 18089…"
        folder.text = SafRepository(this).rootLabel()
        token.text = McpTokenStore(this).current()
        executor.execute {
            val mcp = ServiceProbe.compatibleMcp()
            val model = ServiceProbe.compatibleModel()
            val owner = DevicePolicyController(this).isDeviceOwner
            runOnUiThread {
                status.text = "MCP 8089：${if (mcp) "正常" else "恢复中"}\nlocal-model 18089：${if (model) "正常" else "恢复中"}\n设备管控：${if (owner) "Device Owner" else "尚未配置"}"
            }
        }
    }

    private fun chooseFolder() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        startActivityForResult(intent, REQUEST_TREE)
    }

    @Deprecated("Activity result API is kept here to support the minimum Android deployment image")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_TREE && resultCode == RESULT_OK) {
            data?.data?.let { SafRepository(this).setRoot(it) }
            refresh()
        } else if (requestCode == REQUEST_LOG && resultCode == RESULT_OK) {
            val value = pendingLog ?: return
            data?.data?.let { uri -> contentResolver.openOutputStream(uri, "wt")?.use { it.write(value.toByteArray()) } }
            pendingLog = null
        }
    }

    private fun openAdministrator() {
        if (!AdminAccess.configured(this)) {
            configureAdministratorPin()
            return
        }
        val input = EditText(this).apply {
            hint = "管理员 PIN"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        AlertDialog.Builder(this).setTitle("管理员验证").setView(input)
            .setNegativeButton("取消", null)
            .setPositiveButton("继续") { _, _ ->
                if (AdminAccess.verify(this, input.text.toString().toCharArray())) showMaintenance()
                else Toast.makeText(this, "管理员 PIN 不正确", Toast.LENGTH_SHORT).show()
            }.show()
    }

    private fun configureAdministratorPin() {
        val input = EditText(this).apply {
            hint = "设置至少 8 位管理员 PIN"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        AlertDialog.Builder(this).setTitle("初始化管理员维护入口").setMessage("设备交付用户前必须由管理员完成此设置。")
            .setView(input).setNegativeButton("取消", null).setPositiveButton("设置") { _, _ ->
                runCatching { AdminAccess.configureOnce(this, input.text.toString().toCharArray()) }
                    .onSuccess { Toast.makeText(this, "管理员 PIN 已设置", Toast.LENGTH_SHORT).show() }
                    .onFailure { Toast.makeText(this, it.message, Toast.LENGTH_LONG).show() }
            }.show()
    }

    private fun showMaintenance() {
        val actions = arrayOf("重启本机服务", "立即检查更新", "导出诊断日志", "打开应用系统信息", "解除 Device Owner 管控")
        AlertDialog.Builder(this).setTitle("管理员维护").setItems(actions) { _, index ->
            when (index) {
                0 -> {
                    startService(Intent(this, SupervisorService::class.java).setAction(AppConstants.ACTION_ADMIN_RESTART))
                    handler.postDelayed(::refresh, 1500)
                }
                1 -> {
                    UpdateScheduler.checkNow(this)
                    Toast.makeText(this, "已开始检查签名更新", Toast.LENGTH_SHORT).show()
                }
                2 -> exportLogs()
                3 -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                4 -> confirmReleaseManagement()
            }
        }.show()
    }

    private fun exportLogs() {
        pendingLog = AppLog.snapshot()
        startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TITLE, "kp-local-helper-${System.currentTimeMillis()}.log")
        }, REQUEST_LOG)
    }

    private fun confirmReleaseManagement() {
        AlertDialog.Builder(this).setTitle("解除设备管控？")
            .setMessage("这会允许停止或卸载本应用，只能在设备回收或维修时执行。")
            .setNegativeButton("取消", null)
            .setPositiveButton("确认解除") { _, _ ->
                runCatching { DevicePolicyController(this).releaseForAdministrator() }
                    .onSuccess { refresh() }
                    .onFailure { Toast.makeText(this, it.message, Toast.LENGTH_LONG).show() }
            }.show()
    }

    override fun onResume() {
        super.onResume()
        handler.postDelayed(::refresh, 300)
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_TREE = 41
        private const val REQUEST_LOG = 42
    }
}
