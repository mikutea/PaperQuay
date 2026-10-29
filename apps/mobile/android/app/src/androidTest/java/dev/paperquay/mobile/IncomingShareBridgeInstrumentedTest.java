package dev.paperquay.mobile;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Offline device regression for the production MainActivity and Native bridge. Run only in a fresh isolated fixture. */
@RunWith(AndroidJUnit4.class)
@LargeTest
public final class IncomingShareBridgeInstrumentedTest {
    private static final String PLUGIN = "PaperQuayIncomingShare";
    private static final String[] META = {"version", "id", "name", "kind", "mediaType", "sizeBytes", "createdAt"};
    private static final int SNAPSHOT_MAX = 8 * 1024 * 1024 + 16384;
    private static final long WAIT_MS = 20000;
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final String nonce = UUID.randomUUID().toString();
    private final String ownerA = sha256("paperquay-incoming-instrumentation/" + nonce + "/A");
    private final String ownerB = sha256("paperquay-incoming-instrumentation/" + nonce + "/B");
    private final Map<String, Owned> created = new LinkedHashMap<>();
    private ActivityScenario<MainActivity> scenario;

    @Test(timeout = 240000)
    public void productionDomAndRealJavascriptBridgeKeepOfflineInboxAccountBound() throws Exception {
        assertNotEquals("Never wait on the UI thread", Looper.getMainLooper(), Looper.myLooper());
        assertEquals("dev.paperquay.mobile", context.getPackageName());
        assertNoPreexistingPrivateItems();
        final String cold = "PaperQuay QA " + nonce + "\nCOLD\t$\\alpha$\r\n";
        final String warmB = "PaperQuay QA " + nonce + "\nWARM-B\t正文\r\n";
        final String unassignedC = "PaperQuay QA " + nonce + "\nUNASSIGNED-C\tline\r\n";
        Throwable primary = null;
        try {
            // Match the deliberate MAIN reset exactly; no LAUNCHER category. OS cold SEND is tested by the external source APK.
            scenario = ActivityScenario.launch(mainIntent());
            readyAndProductionDom();
            assertEquals("Dedicated isolated fixture must have no visible/unassigned inbox items", 0, list(ownerA).length());
            assertEquals(0, list(ownerB).length());
            assertNoPreexistingPrivateItems();
            assertNoNetwork();
            android.net.Uri ungranted = android.net.Uri.parse("content://dev.paperquay.fixture.share.files/ungranted-" + nonce);
            assertEquals(android.content.pm.PackageManager.PERMISSION_DENIED, context.checkUriPermission(ungranted,
                android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION));
            Intent forged = new Intent(context, MainActivity.class).setAction(Intent.ACTION_SEND).setType("text/markdown")
                .putExtra(Intent.EXTRA_STREAM, ungranted).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            forged.setClipData(android.content.ClipData.newRawUri("ungranted", ungranted));
            // Receiver-side forged flags cannot manufacture a kernel URI permission.
            // Real cross-UID OS delivery is exercised separately by the Source APK.
            scenario.onActivity(activity -> activity.getBridge().onNewIntent(forged));
            JSONObject denied = success("list", owner(ownerA)).getJSONObject("data");
            assertEquals("INVALID", denied.getString("notice"));
            assertEquals(0, denied.getJSONArray("items").length());
            assertNoPreexistingPrivateItems(); // A fresh install need not have an empty snapshot file yet.
            installChangedListener();
            int beforeFirst = eventCount();
            warm(cold);
            awaitChangedAfter(beforeFirst); // Consume the first commit notification before testing the duplicate.
            JSONObject metaA = awaitCount(ownerA, 1).getJSONObject(0);
            remember(metaA, cold, ownerA); // Read-only disk proof identifies our own raw text before any claim.
            assertMeta(metaA, cold);
            assertMetaEqual(metaA, list(ownerB).getJSONObject(0));
            assertNull(disk().get(metaA.getString("id")).owner); // list does not claim or return a body.

            int beforeDuplicate = eventCount();
            int firstActivity = activityIdentity();
            warm(cold);
            awaitChangedAfter(beforeDuplicate); // Completion event avoids a false early "still one item" pass.
            assertEquals(firstActivity, activityIdentity());
            JSONObject afterRetry = awaitCount(ownerA, 1).getJSONObject(0);
            assertMetaEqual(metaA, afterRetry); // Pending duplicate keeps id and createdAt.

            JSONObject itemA = success("read", idOwner(metaA.getString("id"), ownerA)).getJSONObject("data");
            assertItem(metaA, cold, itemA);
            assertEquals(ownerA, disk().get(metaA.getString("id")).owner); // Actual fsynced owner claim, not only JS state.
            assertEquals(0, list(ownerB).length());
            rejected("read", idOwner(metaA.getString("id"), ownerB), "INVALID");
            rejected("remove", idOwner(metaA.getString("id"), ownerB), "INVALID");
            guardedClear(ownerB); // B cannot clear claimed A.
            assertItem(metaA, cold, success("read", idOwner(metaA.getString("id"), ownerA)).getJSONObject("data"));
            assertEventPayloads();
            assertNoNetwork();

            int oldActivity = activityIdentity();
            scenario.recreate();
            readyAndProductionDom();
            assertNotEquals(oldActivity, activityIdentity());
            assertItem(metaA, cold, success("read", idOwner(metaA.getString("id"), new String(ownerA))).getJSONObject("data"));
            assertEquals(0, list(ownerB).length());
            assertEquals(ownerA, disk().get(metaA.getString("id")).owner);

            installChangedListener();
            int beforeB = eventCount();
            int warmActivity = activityIdentity();
            warm(warmB);
            awaitChangedAfter(beforeB);
            assertEquals(warmActivity, activityIdentity());
            JSONObject metaB = awaitCount(ownerB, 1).getJSONObject(0);
            remember(metaB, warmB, ownerB);
            assertEquals(2, list(ownerA).length());
            assertNull(disk().get(metaB.getString("id")).owner);
            assertItem(metaB, warmB, success("read", idOwner(metaB.getString("id"), ownerB)).getJSONObject("data"));
            assertEquals(ownerB, disk().get(metaB.getString("id")).owner);
            assertEquals(1, list(ownerA).length());

            for (Object invalid : new Object[]{JSONObject.NULL, "abc", repeat('A', 64), "raw-account-identity"}) {
                JSONObject onlyOwner = new JSONObject().put("owner", invalid);
                JSONObject selected = new JSONObject().put("id", metaB.getString("id")).put("owner", invalid);
                rejected("list", onlyOwner, "INVALID");
                rejected("read", selected, "INVALID");
                rejected("remove", selected, "INVALID");
                rejected("clear", onlyOwner, "INVALID");
            }
            assertItem(metaB, warmB, success("read", idOwner(metaB.getString("id"), ownerB)).getJSONObject("data"));

            int beforeC = eventCount();
            warm(unassignedC);
            awaitChangedAfter(beforeC);
            JSONArray bothA = awaitCount(ownerA, 2);
            JSONObject metaC = null;
            for (int i = 0; i < bothA.length(); i++) {
                JSONObject candidate = bothA.getJSONObject(i);
                if (!created.containsKey(candidate.getString("id"))) {
                    assertNull("Only one newly shared fixture is expected", metaC);
                    metaC = candidate;
                }
            }
            assertNotNull(metaC);
            remember(metaC, unassignedC, ownerA);
            assertNull(disk().get(metaC.getString("id")).owner);
            assertEquals(2, list(ownerB).length());
            guardedClear(ownerA); // Removes own A + unassigned C, preserves claimed B.
            assertEquals(0, list(ownerA).length());
            assertMetaEqual(metaB, list(ownerB).getJSONObject(0));
            Map<String, DiskItem> afterClear = disk();
            assertFalse(afterClear.containsKey(metaA.getString("id")));
            assertFalse(afterClear.containsKey(metaC.getString("id")));
            assertEquals(ownerB, afterClear.get(metaB.getString("id")).owner);

            rejected("remove", idOwner(metaB.getString("id"), ownerA), "INVALID");
            assertItem(metaB, warmB, success("read", idOwner(metaB.getString("id"), ownerB)).getJSONObject("data"));
            assertTrue(success("remove", idOwner(metaB.getString("id"), ownerB)).isNull("data"));
            assertEquals(0, list(ownerB).length());
            assertFalse(disk().containsKey(metaB.getString("id")));
            assertEventPayloads();
            assertNoNetwork();
        } catch (Exception | AssertionError failure) {
            primary = failure;
            throw failure;
        } finally {
            try { cleanupOnlyCreatedIds(); }
            catch (Exception | AssertionError cleanupFailure) {
                if (primary != null) primary.addSuppressed(cleanupFailure); else throw cleanupFailure;
            } finally {
                if (scenario != null) scenario.close();
                scenario = null;
            }
        }
    }

    private Intent mainIntent() {
        return new Intent(context, MainActivity.class).setAction(Intent.ACTION_MAIN);
    }
    private Intent sendText(String text) {
        return new Intent(context, MainActivity.class).setAction(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
    }
    private void warm(String text) {
        scenario.onActivity(activity -> activity.startActivity(sendText(text).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)));
    }
    private int activityIdentity() {
        AtomicReference<Integer> identity = new AtomicReference<>();
        scenario.onActivity(activity -> identity.set(System.identityHashCode(activity)));
        return identity.get();
    }
    private JSONObject evaluate(String expression) throws Exception {
        assertNotEquals(Looper.getMainLooper(), Looper.myLooper());
        CountDownLatch callback = new CountDownLatch(1);
        AtomicReference<String> raw = new AtomicReference<>();
        scenario.onActivity(activity -> {
            assertNotNull("Real MainActivity must own a Capacitor bridge", activity.getBridge());
            WebView webView = activity.getBridge().getWebView();
            assertNotNull(webView);
            webView.evaluateJavascript(expression, value -> { raw.set(value); callback.countDown(); });
        });
        assertTrue("WebView callback exceeded 5s", callback.await(5, TimeUnit.SECONDS));
        Object decoded = new JSONTokener(raw.get() == null ? "null" : raw.get()).nextValue();
        assertTrue("Every test expression returns JSON.stringify(object)", decoded instanceof String);
        return new JSONObject((String) decoded);
    }
    private void readyAndProductionDom() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 30000;
        boolean ready = false;
        while (SystemClock.elapsedRealtime() < deadline) {
            JSONObject state = evaluate("JSON.stringify({ready:!!(window.Capacitor&&typeof window.Capacitor.nativePromise==='function'&&typeof window.Capacitor.nativeCallback==='function')})");
            if (state.getBoolean("ready")) { ready = true; break; }
            Thread.sleep(80);
        }
        assertTrue("Native JS bridge did not appear", ready);
        evaluate("(function(){window.__pqInboxQaNetwork=0;window.__pqInboxQaErrors=[];"
            + "var deny=function(){window.__pqInboxQaNetwork++;throw new Error('OFFLINE_INBOX_TEST');};window.fetch=deny;"
            + "if(window.XMLHttpRequest)window.XMLHttpRequest.prototype.open=deny;"
            + "window.addEventListener('error',function(){window.__pqInboxQaErrors.push('error');});"
            + "window.addEventListener('unhandledrejection',function(){window.__pqInboxQaErrors.push('unhandledrejection');});"
            + "return JSON.stringify({installed:true});})()");
        boolean rendered = false;
        while (SystemClock.elapsedRealtime() < deadline) {
            JSONObject state = evaluate("(function(){var root=document.getElementById('root');var h=root&&root.querySelector('.login-panel h1');"
                + "var heading=h?h.textContent.trim():'';var panel=root&&root.querySelector('.login-panel');"
                + "return JSON.stringify({rendered:!!(panel&&(heading==='连接你的 PaperQuay'||heading==='登录到你的文库')&&panel.querySelector('input')&&panel.querySelector('button')),heading:heading});})()");
            if (state.getBoolean("rendered")) { rendered = true; break; }
            Thread.sleep(80);
        }
        assertTrue("Production React config/login DOM did not boot; bridge injection alone is insufficient", rendered);
        JSONObject capabilities = evaluate("JSON.stringify({platform:window.Capacitor.getPlatform(),available:window.Capacitor.isPluginAvailable('PaperQuayIncomingShare'),secure:window.isSecureContext===true,crypto:!!(window.crypto&&window.crypto.subtle&&typeof window.crypto.subtle.digest==='function')})");
        assertEquals("android", capabilities.getString("platform"));
        assertTrue("Production UI availability gate must see the custom plugin", capabilities.getBoolean("available"));
        assertTrue("Account owner derivation requires a secure WebView context", capabilities.getBoolean("secure"));
        assertTrue("Production incoming client requires WebCrypto", capabilities.getBoolean("crypto"));
    }
    private JSONObject invoke(String method, JSONObject options) throws Exception {
        String token = "__pqInboxQaCall_" + UUID.randomUUID().toString().replace("-", "");
        String key = JSONObject.quote(token);
        evaluate("(function(){var k=" + key + ";window[k]={done:false};Promise.resolve().then(function(){return window.Capacitor.nativePromise("
            + JSONObject.quote(PLUGIN) + "," + JSONObject.quote(method) + "," + options.toString() + ");}).then(function(data){window[k]={done:true,ok:true,data:data===undefined?null:data};},"
            + "function(error){window[k]={done:true,ok:false,code:error&&typeof error.code==='string'?error.code:'UNKNOWN'};});return JSON.stringify({scheduled:true});})()");
        long deadline = SystemClock.elapsedRealtime() + WAIT_MS;
        try {
            while (SystemClock.elapsedRealtime() < deadline) {
                JSONObject state = evaluate("JSON.stringify(window[" + key + "]||{done:false})");
                if (state.optBoolean("done", false)) return state;
                Thread.sleep(60);
            }
            throw new AssertionError("Bounded nativePromise timeout: " + method);
        } finally {
            evaluate("(function(){delete window[" + key + "];return JSON.stringify({deleted:true});})()");
        }
    }
    private JSONObject success(String method, JSONObject options) throws Exception {
        JSONObject reply = invoke(method, options);
        assertTrue("Native method failed: " + method + "/" + reply.optString("code", ""), reply.getBoolean("ok"));
        return reply;
    }
    private void rejected(String method, JSONObject options, String code) throws Exception {
        JSONObject reply = invoke(method, options); assertFalse(reply.getBoolean("ok")); assertEquals(code, reply.getString("code"));
    }
    private JSONObject owner(String value) throws Exception { return new JSONObject().put("owner", value); }
    private JSONObject idOwner(String id, String value) throws Exception { return owner(value).put("id", id); }
    private JSONArray list(String value) throws Exception {
        JSONObject result = success("list", owner(value)).getJSONObject("data");
        assertEquals(new HashSet<>(Arrays.asList("items", "notice")), keys(result));
        assertTrue("Unexpected inbox notice", result.isNull("notice"));
        JSONArray items = result.getJSONArray("items");
        for (int i = 0; i < items.length(); i++) assertMetaOnly(items.getJSONObject(i));
        return items;
    }
    private JSONArray awaitCount(String value, int expected) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + WAIT_MS;
        while (SystemClock.elapsedRealtime() < deadline) {
            JSONArray items = list(value);
            assertTrue("Unexpected visible items; refusing to touch unknown data", items.length() <= expected);
            if (items.length() == expected) return items;
            Thread.sleep(80);
        }
        throw new AssertionError("Incoming text did not reach the native inbox");
    }
    private void assertMetaOnly(JSONObject value) throws Exception {
        assertEquals(new HashSet<>(Arrays.asList(META)), keys(value));
        assertEquals(1, value.getInt("version"));
        assertTrue(value.getString("id").matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));
        assertEquals("Shared text.txt", value.getString("name")); assertEquals("text", value.getString("kind"));
        assertEquals("text/plain", value.getString("mediaType")); assertTrue(value.getLong("createdAt") > 0);
    }
    private void assertMeta(JSONObject value, String text) throws Exception { assertMetaOnly(value); assertEquals(text.getBytes(StandardCharsets.UTF_8).length, value.getInt("sizeBytes")); }
    private void assertMetaEqual(JSONObject expected, JSONObject actual) throws Exception {
        assertMetaOnly(actual);
        for (String field : META) assertEquals("Metadata changed: " + field, expected.get(field), actual.get(field));
    }
    private void assertItem(JSONObject meta, String text, JSONObject item) throws Exception {
        Set<String> expected = new HashSet<>(Arrays.asList(META)); expected.add("text"); assertEquals(expected, keys(item));
        JSONObject actual = new JSONObject(); for (String field : META) actual.put(field, item.get(field));
        assertMetaEqual(meta, actual); assertTrue("Raw fixture text changed", text.equals(item.getString("text")));
    }
    private void remember(JSONObject meta, String body, String hint) throws Exception {
        assertMeta(meta, body);
        DiskItem raw = disk().get(meta.getString("id")); assertNotNull(raw);
        assertTrue("An unknown external share must never be claimed or cleaned", body.equals(raw.text));
        assertNull(raw.owner);
        created.put(meta.getString("id"), new Owned(body, hint));
    }
    private void guardedClear(String value) throws Exception {
        JSONArray visible = list(value); Map<String, DiskItem> persisted = disk();
        for (int i = 0; i < visible.length(); i++) {
            String id = visible.getJSONObject(i).getString("id");
            assertTrue("Refusing clear: visible inbox contains a non-fixture id", created.containsKey(id));
            assertNotNull(persisted.get(id)); assertTrue("Fixture bytes changed; refusing clear", created.get(id).body.equals(persisted.get(id).text));
        }
        assertTrue(success("clear", owner(value)).isNull("data"));
    }
    private void installChangedListener() throws Exception {
        JSONObject value = evaluate("(function(){window.__pqInboxQaEvents=[];window.__pqInboxQaListener=window.Capacitor.nativeCallback('PaperQuayIncomingShare','addListener',{eventName:'changed'},"
            + "function(data,error){window.__pqInboxQaEvents.push({data:data===undefined?null:data,error:error?'ERROR':null});});return JSON.stringify({id:window.__pqInboxQaListener});})()");
        assertTrue(value.getString("id").length() > 0);
        list(ownerA); // Same bridge Handler queue provides a registration barrier before the warm Intent.
    }
    private int eventCount() throws Exception { return evaluate("JSON.stringify({count:(window.__pqInboxQaEvents||[]).length})").getInt("count"); }
    private void awaitChangedAfter(int count) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + WAIT_MS;
        while (SystemClock.elapsedRealtime() < deadline) { if (eventCount() > count) { assertEventPayloads(); return; } Thread.sleep(60); }
        throw new AssertionError("No changed event after warm SEND");
    }
    private void assertEventPayloads() throws Exception {
        JSONArray events = evaluate("JSON.stringify({events:window.__pqInboxQaEvents||[]})").getJSONArray("events");
        for (int i = 0; i < events.length(); i++) { JSONObject event = events.getJSONObject(i); assertTrue(event.isNull("error")); assertEquals(0, event.getJSONObject("data").length()); }
    }
    private void assertNoNetwork() throws Exception {
        JSONObject state = evaluate("JSON.stringify({count:window.__pqInboxQaNetwork||0,errors:window.__pqInboxQaErrors||[]})");
        assertEquals("Offline bridge tests must not request HTTP", 0, state.getInt("count"));
        assertEquals("Production page raised JS errors after guard installation", 0, state.getJSONArray("errors").length());
    }
    private void cleanupOnlyCreatedIds() throws Exception {
        if (scenario == null) return;
        for (Map.Entry<String, Owned> entry : created.entrySet()) {
            JSONObject reply = invoke("remove", idOwner(entry.getKey(), entry.getValue().hint));
            if (!reply.getBoolean("ok")) {
                assertEquals("INVALID", reply.getString("code"));
                JSONObject retry = invoke("remove", idOwner(entry.getKey(), entry.getValue().hint.equals(ownerA) ? ownerB : ownerA));
                if (!retry.getBoolean("ok")) assertEquals("INVALID", retry.getString("code")); // Already removed is fine.
            }
        }
        if (!created.isEmpty()) {
            Map<String, DiskItem> persisted = disk();
            for (String id : created.keySet()) assertFalse("Self-created fixture was not removed", persisted.containsKey(id));
        }
        evaluate("(function(){if(window.__pqInboxQaListener){window.Capacitor.nativeCallback('PaperQuayIncomingShare','removeListener',{eventName:'changed',callbackId:window.__pqInboxQaListener});delete window.__pqInboxQaListener;}return JSON.stringify({removed:true});})()");
        list(ownerA); // removeListener is RETURN_NONE in Cap8; never await it with nativePromise.
    }
    private Map<String, DiskItem> disk() throws Exception {
        File snapshot = new File(context.getNoBackupFilesDir(), "paperquay-incoming-share-v1/items.bin");
        assertTrue("Intake must create an actual private snapshot", snapshot.isFile());
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(snapshot)) {
            byte[] buffer = new byte[8192]; int read;
            while ((read = input.read(buffer)) != -1) { assertTrue(bytes.size() + read <= SNAPSHOT_MAX); bytes.write(buffer, 0, read); }
        }
        byte[] raw = bytes.toByteArray(); assertTrue(raw.length >= 44);
        byte[] body = Arrays.copyOf(raw, raw.length - 32);
        assertTrue("Actual disk snapshot checksum must cover owner/content", MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(body), Arrays.copyOfRange(raw, body.length, raw.length)));
        DataInputStream input = new DataInputStream(new ByteArrayInputStream(body));
        assertEquals(0x50514953544f5232L, input.readLong()); int count = input.readInt(); assertTrue(count >= 0 && count <= 4);
        Map<String, DiskItem> result = new LinkedHashMap<>();
        for (int i = 0; i < count; i++) {
            String id = input.readUTF(); input.readUTF(); input.readUTF(); input.readUTF(); input.readLong();
            int marker = input.readUnsignedByte(); assertTrue(marker == 0 || marker == 1); String owner = marker == 1 ? input.readUTF() : null;
            int size = input.readInt(); assertTrue(size > 0 && size <= 4 * 1024 * 1024 && size <= input.available());
            byte[] text = new byte[size]; input.readFully(text); assertNull(result.put(id, new DiskItem(owner, new String(text, StandardCharsets.UTF_8))));
        }
        assertEquals(0, input.available()); return result;
    }
    private void assertNoPreexistingPrivateItems() throws Exception {
        File directory = new File(context.getNoBackupFilesDir(), "paperquay-incoming-share-v1");
        for (String name : new String[]{"items.corrupt.bin", "items.bin.bak", "items.bin.new"})
            assertFalse("Dedicated fixture contains existing private evidence; refusing to clear it", new File(directory, name).exists());
        File active = new File(directory, "items.bin");
        if (active.exists()) {
            assertEquals("Nonempty/unknown inbox must be preserved; use a dedicated fresh fixture", 44, active.length());
            assertTrue("Hidden pre-existing account items must be preserved", disk().isEmpty());
        }
    }
    private static Set<String> keys(JSONObject value) {
        Set<String> result = new HashSet<>(); Iterator<String> names = value.keys();
        while (names.hasNext()) result.add(names.next()); return result;
    }
    private static String sha256(String value) {
        try { StringBuilder result = new StringBuilder(); for (byte part : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))) result.append(String.format(java.util.Locale.ROOT, "%02x", part & 255)); return result.toString(); }
        catch (Exception impossible) { throw new AssertionError(impossible); }
    }
    private static String repeat(char value, int count) { char[] chars = new char[count]; Arrays.fill(chars, value); return new String(chars); }
    private static final class Owned { final String body, hint; Owned(String body, String hint) { this.body = body; this.hint = hint; } }
    private static final class DiskItem { final String owner, text; DiskItem(String owner, String text) { this.owner = owner; this.text = text; } }
}
