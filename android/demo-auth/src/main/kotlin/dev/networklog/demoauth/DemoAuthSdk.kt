package dev.networklog.demoauth

import dev.networklog.logger.*
import org.json.JSONObject

/** Demonstration authentication, NOT OAuth, identity proofing, or a production security decision. */
class DemoAuthSdk(private val session: Session, private val taskHandler: TaskHandler, private val progress: (String) -> Unit = {}) {
    fun interface TaskHandler { fun loadTask(context: CaptureContext): String }
    data class Identity(val displayName: String, val userId: Int, val challengeId: String, val task: String)
    fun authenticate(parent: CaptureContext, recoverFrom401: Boolean = false): Identity {
        val actor = Actor("sdk", "DemoAuthSdk", "authenticate")
        val op = session.startOperation("DemoAuthSdk.authenticate", actor, parent)
        val http = LoggingHttpClient(session, Actor("integrator", "SampleApp", "signIn"), actor, op.context)
        val json = listOf("Content-Type" to "application/json; charset=utf-8")
        fun post(url: String, body: JSONObject) = http.execute("POST", url, json, body.toString().toByteArray()).requireSuccess()
        try {
            progress("Create demonstration challenge · httpbin")
            val challenge = http.execute("GET", "https://httpbin.org/uuid").requireSuccess().json().getString("uuid")
            progress("Echo challenge acknowledgement · httpbin")
            val acknowledgement = post("https://httpbin.org/anything/challenge", JSONObject().put("challengeId", challenge).put("demo", true))
            check(acknowledgement.json().getJSONObject("json").getString("challengeId") == challenge)
            progress("Sign in with public demo credentials · DummyJSON")
            val tokens = post("https://dummyjson.com/auth/login", JSONObject().put("username", "emilys").put("password", "emilyspass").put("expiresInMins", 5)).json()
            val accessToken = tokens.getString("accessToken")
            val refreshToken = tokens.getString("refreshToken")
            progress("Read authenticated profile · DummyJSON")
            val profile = http.execute("GET", "https://dummyjson.com/auth/me", listOf("Authorization" to "Bearer $accessToken")).requireSuccess().json()
            val rejected = if (recoverFrom401) {
                progress("Exercise expected 401 · DummyJSON")
                http.execute("GET", "https://dummyjson.com/auth/me", listOf("Authorization" to "Bearer deliberately-invalid-demo-token"))
                    .also { check(it.status == 401) { "Expected demo 401, got ${it.status}" } }
            } else null
            progress("Refresh demo token · DummyJSON")
            val refreshed = post("https://dummyjson.com/auth/refresh", JSONObject().put("refreshToken", refreshToken).put("expiresInMins", 5)).json().getString("accessToken")
            progress(if (rejected == null) "Confirm refreshed session · DummyJSON" else "Retry rejected profile · DummyJSON")
            val confirmed = http.execute("GET", "https://dummyjson.com/auth/me", listOf("Authorization" to "Bearer $refreshed"), retryOf = rejected?.exchange).requireSuccess().json()
            check(confirmed.getInt("id") == profile.getInt("id"))
            progress("SDK → app handler · CustomerTaskHandler.loadTask")
            val task = session.invokeHandler("CustomerTaskHandler.loadTask", actor,
                Actor("integrator", "CustomerTaskHandler", "loadTask"), op.context) { context ->
                taskHandler.loadTask(context)
            }
            progress("App handler → SDK · returned")
            val resume = session.startOperation("DemoAuthSdk.acceptTask", Actor("sdk", "DemoAuthSdk", "acceptTask"), op.context)
            try {
                check(task.isNotBlank()) { "Handler returned an empty task" }
                resume.complete()
            } catch (error: Exception) { resume.complete("error", error); throw error }
            op.complete()
            return Identity(profile.getString("firstName"), profile.getInt("id"), challenge, task)
        } catch (error: Exception) { op.complete("error", error); throw error }
    }
    fun completeDemo(identity: Identity, parent: CaptureContext) {
        val actor = Actor("sdk", "DemoAuthSdk", "completeDemo")
        val op = session.startOperation("DemoAuthSdk.completeDemo", actor, parent)
        try {
            progress("Echo completion receipt · httpbin")
            val response = LoggingHttpClient(session, Actor("integrator", "SampleApp", "signIn"), actor, op.context).execute(
                "POST", "https://httpbin.org/anything/receipt", listOf("Content-Type" to "application/json"),
                JSONObject().put("challengeId", identity.challengeId).put("completed", true).put("demo", true).toString().toByteArray()
            ).requireSuccess()
            check(response.json().getJSONObject("json").getBoolean("completed"))
            op.complete()
        } catch (error: Exception) { op.complete("error", error); throw error }
    }
}
