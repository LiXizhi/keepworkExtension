package com.keepwork.localhelper.model

import android.content.Context
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Base64

data class VerifiedModel(val id: String, val version: String, val dimension: Int, val assetPath: String)

object ModelIntegrity {
    private const val ROOT = "local-model"

    fun verify(context: Context): VerifiedModel {
        val config = JSONObject(readText(context, "$ROOT/model-config.json"))
        val manifest = JSONObject(readText(context, "$ROOT/manifest.json"))
        val checksums = JSONObject(readText(context, "$ROOT/checksums.json")).getJSONObject("files")
        val identity = config.getJSONObject("identity")
        val artifact = config.getJSONObject("artifact")
        val model = readBytes(context, "$ROOT/model.onnx")

        require(identity.getString("id") == manifest.getString("modelId")) { "Model ID mismatch" }
        require(identity.getString("version") == manifest.getString("modelVersion")) { "Model version mismatch" }
        require(model.size.toLong() == artifact.getLong("bytes")) { "Model size mismatch" }
        require(sha256(model) == artifact.getString("sha256")) { "Model SHA-256 mismatch" }
        require(manifest.getJSONObject("artifact").getString("sha256") == artifact.getString("sha256")) { "Manifest artifact mismatch" }
        require(manifest.getString("configSha256") == sha256(canonical(config).toByteArray())) { "Config signature binding mismatch" }

        for (name in checksums.keys()) {
            val assetName = when (name) {
                "model.onnx", "manifest.json", "LICENSE", "README.md" -> name
                else -> throw IllegalArgumentException("Unexpected model package file: $name")
            }
            require(sha256(readBytes(context, "$ROOT/$assetName")) == checksums.getString(name)) {
                "Model package checksum mismatch: $name"
            }
        }

        val signature = manifest.getJSONObject("signature")
        require(signature.getString("algorithm") == "Ed25519") { "Unsupported model signature" }
        val unsigned = JSONObject(manifest.toString()).apply { remove("signature") }
        val publicDer = pemBytes(readText(context, "$ROOT/model-signing-public.pem"))
        val publicKey = SubjectPublicKeyInfo.getInstance(publicDer).publicKeyData.bytes
        val verifier = Ed25519Signer().apply { init(false, Ed25519PublicKeyParameters(publicKey, 0)) }
        val payload = canonical(unsigned).toByteArray(Charsets.UTF_8)
        verifier.update(payload, 0, payload.size)
        require(verifier.verifySignature(Base64.getDecoder().decode(signature.getString("value")))) {
            "Model manifest signature verification failed"
        }

        return VerifiedModel(identity.getString("id"), identity.getString("version"), 512, "$ROOT/model.onnx")
    }

    internal fun canonical(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted()
            .joinToString(prefix = "{", postfix = "}") { "${JSONObject.quote(it)}:${canonical(value.get(it))}" }
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        is Boolean, is Number -> value.toString()
        else -> throw IllegalArgumentException("Unsupported canonical JSON value")
    }

    private fun readText(context: Context, path: String) = String(readBytes(context, path), Charsets.UTF_8)
    private fun readBytes(context: Context, path: String) = context.assets.open(path).use { it.readBytes() }
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun pemBytes(pem: String) = Base64.getMimeDecoder().decode(
        pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", ""),
    )
}
