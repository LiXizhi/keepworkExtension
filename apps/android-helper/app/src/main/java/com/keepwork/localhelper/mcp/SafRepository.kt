package com.keepwork.localhelper.mcp

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.ByteArrayOutputStream

class SafRepository(private val context: Context) {
    private val preferences = context.getSharedPreferences("saf-root", Context.MODE_PRIVATE)

    fun rootUri(): Uri? = preferences.getString("uri", null)?.let(Uri::parse)

    fun setRoot(uri: Uri) {
        context.contentResolver.takePersistableUriPermission(
            uri,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        preferences.edit().putString("uri", uri.toString()).apply()
    }

    fun rootLabel(): String = rootUri()?.lastPathSegment ?: "未授权"

    fun list(relativePath: String = ""): List<Map<String, Any>> {
        val directory = resolve(relativePath, requireDirectory = true)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(
            directory.treeUri,
            DocumentsContract.getDocumentId(directory.documentUri),
        )
        val result = mutableListOf<Map<String, Any>>()
        context.contentResolver.query(
            children,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
            ), null, null, null,
        )?.use { cursor ->
            while (cursor.moveToNext() && result.size < 500) {
                val mime = cursor.getString(2)
                result += mapOf(
                    "name" to cursor.getString(1),
                    "path" to join(relativePath, cursor.getString(1)),
                    "directory" to (mime == DocumentsContract.Document.MIME_TYPE_DIR),
                    "size" to cursor.getLong(3),
                )
            }
        }
        return result.sortedWith(compareBy<Map<String, Any>> { it["directory"] != true }.thenBy { it["name"].toString().lowercase() })
    }

    fun read(relativePath: String, maxBytes: Int = 1_048_576): ByteArray {
        val target = resolve(relativePath, requireDirectory = false)
        val output = ByteArrayOutputStream()
        context.contentResolver.openInputStream(target.documentUri)?.use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > maxBytes) throw IllegalArgumentException("File exceeds $maxBytes bytes")
                output.write(buffer, 0, count)
            }
        } ?: throw IllegalArgumentException("Unable to read $relativePath")
        return output.toByteArray()
    }

    fun write(relativePath: String, data: ByteArray) {
        require(data.size <= 1_048_576) { "File exceeds 1048576 bytes" }
        val segments = segments(relativePath)
        require(segments.isNotEmpty()) { "A file path is required" }
        val parentPath = segments.dropLast(1).joinToString("/")
        val name = segments.last()
        val parent = resolve(parentPath, requireDirectory = true)
        val existing = child(parent.documentUri, name)
        val target = existing ?: DocumentsContract.createDocument(
            context.contentResolver,
            parent.documentUri,
            "text/plain",
            name,
        ) ?: throw IllegalArgumentException("Unable to create $relativePath")
        context.contentResolver.openOutputStream(target, "wt")?.use { it.write(data) }
            ?: throw IllegalArgumentException("Unable to write $relativePath")
    }

    fun search(query: String): List<String> {
        val needle = query.trim().lowercase()
        require(needle.isNotEmpty()) { "Search query is required" }
        val found = mutableListOf<String>()
        val queue = ArrayDeque<String>().apply { add("") }
        var scanned = 0
        while (queue.isNotEmpty() && scanned < 3000 && found.size < 100) {
            val path = queue.removeFirst()
            for (item in list(path)) {
                scanned += 1
                val childPath = item["path"].toString()
                if (item["name"].toString().lowercase().contains(needle)) found += childPath
                if (item["directory"] == true) queue.add(childPath)
                if (scanned >= 3000 || found.size >= 100) break
            }
        }
        return found
    }

    private data class Resolved(val treeUri: Uri, val documentUri: Uri)

    private fun resolve(relativePath: String, requireDirectory: Boolean): Resolved {
        val root = rootUri() ?: throw IllegalStateException("请先在 KP Local Helper 中授权文件夹")
        var current = DocumentsContract.buildDocumentUriUsingTree(root, DocumentsContract.getTreeDocumentId(root))
        for (segment in segments(relativePath)) {
            current = child(current, segment) ?: throw IllegalArgumentException("Path does not exist: $relativePath")
        }
        if (requireDirectory && !isDirectory(current)) throw IllegalArgumentException("Not a directory: $relativePath")
        return Resolved(root, current)
    }

    private fun child(parent: Uri, name: String): Uri? {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(parent, DocumentsContract.getDocumentId(parent))
        context.contentResolver.query(
            children,
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null, null, null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(1) == name) {
                    return DocumentsContract.buildDocumentUriUsingTree(parent, cursor.getString(0))
                }
            }
        }
        return null
    }

    private fun isDirectory(uri: Uri): Boolean {
        context.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use {
            return it.moveToFirst() && it.getString(0) == DocumentsContract.Document.MIME_TYPE_DIR
        }
        return false
    }

    private fun segments(path: String): List<String> = path.replace('\\', '/').split('/')
        .filter { it.isNotBlank() && it != "." }
        .also { parts -> require(parts.none { it == ".." || it.contains('\u0000') }) { "Path traversal is not allowed" } }

    private fun join(parent: String, name: String) = if (parent.isBlank()) name else "$parent/$name"
}
