package dev.paperquay.mobile;

import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Process;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

@CapacitorPlugin(name = "PaperQuayIncomingShare")
public final class PaperQuayIncomingSharePlugin extends Plugin {
    private static final long READ_TIMEOUT_MS = 10000;
    private final ThreadPoolExecutor io = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4));
    private final ThreadPoolExecutor operations = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(16));
    private final ThreadPoolExecutor closeIo = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8));
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    private final Set<IncomingRead> reads = Collections.newSetFromMap(new ConcurrentHashMap<IncomingRead, Boolean>());
    private final AtomicReference<IncomingSharePolicy.Code> notice = new AtomicReference<>();
    private static IncomingShareStore sharedStore;
    private volatile boolean destroyed;
    private IncomingShareStore store;

    @Override public void load() {
        // Constant private names only; no shared URI, display name or bridge argument is a path.
        synchronized (PaperQuayIncomingSharePlugin.class) {
            if (sharedStore == null) sharedStore = new IncomingShareStore(new PrivateStorage(new File(getContext().getNoBackupFilesDir(), "paperquay-incoming-share-v1")));
            store = sharedStore;
        }
    }
    private static final class PrivateStorage implements IncomingShareStore.Storage {
        private final File directory, base, quarantine;
        private final AtomicFile atomic;
        PrivateStorage(File directory) {
            this.directory = directory; this.base = new File(directory, "items.bin"); this.quarantine = new File(directory, "items.corrupt.bin");
            this.atomic = new AtomicFile(base);
        }
            private void directory() throws IOException {
                if ((!directory.isDirectory() && !directory.mkdirs()) || !directory.isDirectory()) throw new IOException();
            }
            @Override public byte[] read() throws IOException {
                directory();
                if (!base.exists() && !new File(base.getPath() + ".bak").exists()) return null;
                try (FileInputStream input = atomic.openRead()) { return bounded(input, IncomingShareStore.SNAPSHOT_BYTES); }
            }
            @Override public void write(byte[] bytes) throws IOException {
                directory(); FileOutputStream output = null;
                try { output = atomic.startWrite(); output.write(bytes); output.getFD().sync(); atomic.finishWrite(output); }
                catch (IOException | RuntimeException error) { if (output != null) atomic.failWrite(output); throw error; }
            }
            @Override public void quarantineAndReset(byte[] empty) throws IOException {
                directory();
                if (quarantine.exists()) throw new IOException(); // Never overwrite another owner's retained evidence.
                try (FileInputStream ignored = atomic.openRead()) { /* Recover AtomicFile's own legacy backup before isolating the original. */ }
                if (!base.isFile() || !base.renameTo(quarantine)) throw new IOException();
                // The exact original now survives even if writing the new empty inbox fails.
                atomic.delete();
                write(empty);
            }
    }

    @PluginMethod public void list(PluginCall call) {
        String owner = owner(call, false); if (owner == null) return;
        dispatch(call, () -> {
            JSArray items = new JSArray(); IncomingSharePolicy.Code code = notice.getAndSet(null);
            try { for (IncomingShareStore.Item item : store.list(owner)) items.put(meta(item, false)); }
            catch (IncomingSharePolicy.Failure error) { code = error.code; }
            JSObject result = new JSObject(); result.put("items", items); result.put("notice", code == null ? JSONObject.NULL : code.name()); call.resolve(result);
        });
    }
    @PluginMethod public void read(PluginCall call) {
        String owner = owner(call, true); if (owner == null) return;
        String id = id(call); if (id == null) return;
        dispatch(call, () -> { try { call.resolve(meta(store.read(id, owner), true)); } catch (IncomingSharePolicy.Failure error) { reject(call, error.code); } });
    }
    @PluginMethod public void remove(PluginCall call) {
        String owner = owner(call, true); if (owner == null) return;
        String id = id(call); if (id == null) return;
        dispatch(call, () -> { try { store.remove(id, owner); call.resolve(); changed(); } catch (IncomingSharePolicy.Failure error) { reject(call, error.code); } });
    }
    @PluginMethod public void clear(PluginCall call) {
        String owner = owner(call, false); if (owner == null) return;
        // Cancel in-flight intake first so a late content provider cannot refill an explicitly cleared queue.
        for (IncomingRead read : reads) read.cancel(false);
        dispatch(call, () -> { try { boolean recovered = store.clear(owner); notice.set(recovered ? IncomingSharePolicy.Code.INVALID : null); call.resolve(); changed(); } catch (IncomingSharePolicy.Failure error) { reject(call, error.code); } });
    }
    private String owner(PluginCall call, boolean withId) {
        Object value = call.getData().opt("owner");
        if (call.getData().length() != (withId ? 2 : 1) || !(value instanceof String) || !IncomingSharePolicy.OWNER.matcher((String) value).matches()
            || (withId && !call.getData().has("id"))) { reject(call, IncomingSharePolicy.Code.INVALID); return null; }
        return (String) value;
    }
    private String id(PluginCall call) {
        Object id = call.getData().opt("id");
        if (!(id instanceof String) || !IncomingSharePolicy.UUID.matcher((String) id).matches()) {
            reject(call, IncomingSharePolicy.Code.INVALID); return null;
        }
        return (String) id;
    }
    private void dispatch(PluginCall call, Runnable work) {
        if (destroyed) { reject(call, IncomingSharePolicy.Code.STORAGE_UNAVAILABLE); return; }
        try { operations.execute(() -> { try { work.run(); } catch (RuntimeException error) { reject(call, IncomingSharePolicy.Code.STORAGE_UNAVAILABLE); } }); }
        catch (RejectedExecutionException error) { reject(call, IncomingSharePolicy.Code.STORAGE_UNAVAILABLE); }
    }
    private static void reject(PluginCall call, IncomingSharePolicy.Code code) { call.reject(code.name(), code.name()); }
    private static JSObject meta(IncomingShareStore.Item item, boolean content) {
        JSObject value = new JSObject(); value.put("version", 1); value.put("id", item.id); value.put("name", item.name); value.put("kind", item.kind);
        value.put("mediaType", item.mediaType); value.put("sizeBytes", item.sizeBytes); value.put("createdAt", item.createdAt);
        if (content) value.put("text", item.text);
        return value;
    }
    private void changed() {
        if (!destroyed) getActivity().runOnUiThread(() -> { if (!destroyed) notifyListeners("changed", new JSObject()); });
    }
    private void report(IncomingSharePolicy.Code code) { notice.set(code); changed(); }

    @Override protected void handleOnNewIntent(Intent intent) {
        if (intent == null || destroyed) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return; // VIEW/OIDC remains untouched.
        // BridgeActivity dispatches its launch Intent once during load. Recreated activities must not import it a second time.
        getActivity().setIntent(new Intent(getContext(), MainActivity.class).setAction(Intent.ACTION_MAIN));
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) { report(IncomingSharePolicy.Code.UNSUPPORTED); return; }
        try {
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 1) { report(IncomingSharePolicy.Code.UNSUPPORTED); return; }
            Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream != null && !(stream instanceof Uri)) { report(IncomingSharePolicy.Code.INVALID); return; }
            Uri uri = (Uri) stream;
            Uri clipUri = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getUri();
            if (uri != null && clipUri != null && !uri.equals(clipUri)) { report(IncomingSharePolicy.Code.INVALID); return; }
            if (uri == null) uri = clipUri;
            if (uri != null) {
                if (!"content".equals(uri.getScheme())) { report(IncomingSharePolicy.Code.UNSUPPORTED); return; }
                if ((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0
                    || getContext().checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
                    report(IncomingSharePolicy.Code.INVALID); return;
                }
                queue(new IncomingRead(uri, intent.getType(), null)); return;
            }
            if (!"text/plain".equals(IncomingSharePolicy.canonicalMime(intent.getType()))) { report(IncomingSharePolicy.Code.UNSUPPORTED); return; }
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text == null && clip != null && clip.getItemCount() == 1) text = clip.getItemAt(0).getText();
            if (text == null) { report(IncomingSharePolicy.Code.INVALID); return; }
            if (text.length() > IncomingSharePolicy.TEXT_BYTES) { report(IncomingSharePolicy.Code.TOO_LARGE); return; }
            queue(new IncomingRead(null, "text/plain", text.toString()));
        } catch (RuntimeException error) { report(IncomingSharePolicy.Code.INVALID); }
    }
    private void queue(IncomingRead read) {
        if (reads.size() >= IncomingSharePolicy.ITEMS) { report(IncomingSharePolicy.Code.FULL); return; }
        reads.add(read);
        try {
            read.timeout = deadlines.schedule(() -> read.cancel(true), READ_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            read.future = io.submit(read);
        } catch (RejectedExecutionException error) { read.cancel(false); report(IncomingSharePolicy.Code.FULL); }
    }
    private final class IncomingRead implements Runnable {
        final Uri uri; final String mime, text;
        final IncomingShareStore.Intake intake = new IncomingShareStore.Intake(store, SystemClock::elapsedRealtime, READ_TIMEOUT_MS);
        final CancellationSignal cancellation = new CancellationSignal();
        volatile AssetFileDescriptor descriptor;
        volatile InputStream input;
        volatile Cursor cursor;
        volatile Future<?> future;
        volatile ScheduledFuture<?> timeout;
        IncomingRead(Uri uri, String mime, String text) { this.uri = uri; this.mime = mime; this.text = text; }
        void check() throws IncomingSharePolicy.Failure {
            intake.check();
            if (destroyed || Thread.currentThread().isInterrupted())
                throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.READ_FAILED);
        }
        void cancel(boolean timedOut) {
            if (!intake.cancel()) return;
            Future<?> pending = future; if (pending != null) pending.cancel(true);
            ScheduledFuture<?> timer = timeout; if (timer != null) timer.cancel(false);
            // Provider cancellation/close may cross Binder. Neither happens on the Activity or deadline thread.
            try { closeIo.execute(() -> { try { cancellation.cancel(); } finally { close(); } }); } catch (RejectedExecutionException ignored) { }
            reads.remove(this);
            if (timedOut && !destroyed) report(IncomingSharePolicy.Code.READ_FAILED);
        }
        void close() {
            InputStream stream = input; input = null; if (stream != null) try { stream.close(); } catch (IOException ignored) { }
            AssetFileDescriptor afd = descriptor; descriptor = null; if (afd != null) try { afd.close(); } catch (IOException ignored) { }
            Cursor metadata = cursor; cursor = null; if (metadata != null) try { metadata.close(); } catch (RuntimeException ignored) { }
        }
        @Override public void run() {
            try {
                check();
                store.checkAvailable(); // Reject corrupt/unavailable storage before reading a provider; deduplication precedes capacity checks in add().
                byte[] bytes; String name, type, kind;
                if (uri == null) {
                    bytes = IncomingSharePolicy.encode(text, IncomingSharePolicy.TEXT_BYTES); name = "Shared text.txt"; type = "text/plain"; kind = "text";
                } else {
                    name = IncomingSharePolicy.fallback(mime);
                    try (Cursor metadata = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null, cancellation)) {
                        cursor = metadata;
                        check();
                        if (metadata != null && metadata.moveToFirst()) {
                            int display = metadata.getColumnIndex(OpenableColumns.DISPLAY_NAME), size = metadata.getColumnIndex(OpenableColumns.SIZE);
                            if (display >= 0 && !metadata.isNull(display)) name = IncomingSharePolicy.basename(metadata.getString(display), name);
                            if (size >= 0 && !metadata.isNull(size) && metadata.getLong(size) > IncomingSharePolicy.FILE_BYTES) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.TOO_LARGE);
                        }
                    } finally { cursor = null; }
                    type = IncomingSharePolicy.fileMime(mime, name); kind = "file"; check();
                    descriptor = getContext().getContentResolver().openAssetFileDescriptor(uri, "r", cancellation); check();
                    if (descriptor == null) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.READ_FAILED);
                    if (descriptor.getDeclaredLength() > IncomingSharePolicy.FILE_BYTES) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.TOO_LARGE);
                    input = descriptor.createInputStream(); check();
                    ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        check(); if (output.size() + count > IncomingSharePolicy.FILE_BYTES) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.TOO_LARGE);
                        output.write(buffer, 0, count);
                    }
                    bytes = output.toByteArray();
                }
                IncomingSharePolicy.decode(bytes, uri == null ? IncomingSharePolicy.TEXT_BYTES : IncomingSharePolicy.FILE_BYTES);
                close(); check();
                // Intake must win the atomic cancellation race before committing. A late provider
                // response can never write after the timeout has won. Clear shares the store lock,
                // so a commit already accepted within the read deadline is cleared afterwards.
                intake.commit(name, kind, type, bytes, System.currentTimeMillis());
                if (timeout != null) timeout.cancel(false);
                if (!destroyed) { notice.set(null); changed(); }
            } catch (IncomingSharePolicy.Failure error) { if ((intake.accepted() || !intake.settled()) && !destroyed) report(error.code); }
            catch (IOException | RuntimeException error) { if ((intake.accepted() || !intake.settled()) && !destroyed) report(IncomingSharePolicy.Code.READ_FAILED); }
            finally { close(); intake.cancel(); if (timeout != null) timeout.cancel(false); reads.remove(this); }
        }
    }
    private static byte[] bounded(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) != -1) { if (output.size() + count > limit) throw new IncomingShareStore.Corrupt(); output.write(buffer, 0, count); }
        return output.toByteArray();
    }
    @Override protected void handleOnDestroy() {
        destroyed = true;
        for (IncomingRead read : reads) read.cancel(false);
        deadlines.shutdownNow(); io.shutdownNow(); operations.shutdownNow(); closeIo.shutdown();
    }
}
