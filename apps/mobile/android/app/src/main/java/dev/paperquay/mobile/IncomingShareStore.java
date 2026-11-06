package dev.paperquay.mobile;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.DigestOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;

/** One bounded, checksummed atomic snapshot in app-private no-backup storage. */
final class IncomingShareStore {
    static final int SNAPSHOT_BYTES = IncomingSharePolicy.TOTAL_BYTES + 16384;
    interface Storage {
        byte[] read() throws IOException;
        void write(byte[] bytes) throws IOException;
        void quarantineAndReset(byte[] empty) throws IOException;
        boolean hasQuarantine() throws IOException;
    }
    static final class Corrupt extends IOException { }
    static final class Item {
        final int version = 1;
        final String id, name, kind, mediaType, text;
        final int sizeBytes;
        final long createdAt;
        private final String owner;
        Item(String id, String name, String kind, String mediaType, String text, int sizeBytes, long createdAt, String owner) {
            this.id = id; this.name = name; this.kind = kind; this.mediaType = mediaType;
            this.text = text; this.sizeBytes = sizeBytes; this.createdAt = createdAt; this.owner = owner;
        }
    }
    /** The actual cancellation/commit gate used by the ContentResolver adapter. */
    static final class Intake {
        private final IncomingShareStore store;
        private final LongSupplier clock;
        private final long deadline;
        private final AtomicBoolean settled = new AtomicBoolean();
        private volatile boolean accepted;
        Intake(IncomingShareStore store, LongSupplier clock, long timeoutMillis) {
            this.store = store; this.clock = clock; this.deadline = clock.getAsLong() + timeoutMillis;
        }
        boolean cancel() { return settled.compareAndSet(false, true); }
        boolean settled() { return settled.get(); }
        boolean accepted() { return accepted; }
        void check() throws IncomingSharePolicy.Failure {
            if (settled.get() || clock.getAsLong() >= deadline) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.READ_FAILED);
        }
        Item commit(String name, String kind, String type, byte[] bytes, long now) throws IncomingSharePolicy.Failure {
            synchronized (store) {
                check();
                if (!settled.compareAndSet(false, true)) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.READ_FAILED);
                accepted = true;
                return store.add(name, kind, type, bytes, now);
            }
        }
    }
    private final Storage storage;
    private List<Item> items = new ArrayList<>();
    private boolean loaded;
    private IncomingSharePolicy.Code broken;
    IncomingShareStore(Storage storage) { this.storage = storage; }
    private void load() throws IncomingSharePolicy.Failure {
        if (!loaded) {
            loaded = true;
            try { byte[] bytes = storage.read(); if (bytes != null) items = parse(bytes); }
            catch (IncomingSharePolicy.Failure | Corrupt e) { broken = IncomingSharePolicy.Code.INVALID; }
            catch (IOException | RuntimeException e) { broken = IncomingSharePolicy.Code.STORAGE_UNAVAILABLE; }
        }
        if (broken != null) throw new IncomingSharePolicy.Failure(broken);
    }
    synchronized List<Item> list(String owner) throws IncomingSharePolicy.Failure {
        IncomingSharePolicy.owner(owner); load(); List<Item> visible = new ArrayList<>();
        for (Item item : items) if (item.owner == null || item.owner.equals(owner)) visible.add(item);
        return visible;
    }
    synchronized void checkAvailable() throws IncomingSharePolicy.Failure { load(); }
    synchronized Item read(String id, String owner) throws IncomingSharePolicy.Failure {
        validId(id); IncomingSharePolicy.owner(owner); load();
        for (int i = 0; i < items.size(); i++) {
            Item item = items.get(i);
            if (!item.id.equals(id) || (item.owner != null && !item.owner.equals(owner))) continue;
            if (item.owner != null) return item;
            Item claimed = new Item(item.id, item.name, item.kind, item.mediaType, item.text, item.sizeBytes, item.createdAt, owner);
            List<Item> next = new ArrayList<>(items); next.set(i, claimed);
            commit(next); // No plaintext leaves read until the owner claim is durably committed.
            return claimed;
        }
        throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.INVALID);
    }
    synchronized Item add(String name, String kind, String mediaType, byte[] bytes, long now) throws IncomingSharePolicy.Failure {
        load();
        String text = IncomingSharePolicy.decode(bytes, "text".equals(kind) ? IncomingSharePolicy.TEXT_BYTES : IncomingSharePolicy.FILE_BYTES);
        Item item = new Item(java.util.UUID.randomUUID().toString(), name, kind, mediaType, text, bytes.length, now, null);
        validate(item);
        // Android can redeliver a launch Intent after process recreation. Reuse the
        // immutable identity of an identical item while it is still pending.
        for (Item existing : items) if (existing.owner == null && existing.name.equals(name) && existing.kind.equals(kind) && existing.mediaType.equals(mediaType) && existing.text.equals(text)) return existing;
        long total = bytes.length;
        for (Item existing : items) total += existing.sizeBytes;
        if (items.size() >= IncomingSharePolicy.ITEMS || total > IncomingSharePolicy.TOTAL_BYTES) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.FULL);
        List<Item> next = new ArrayList<>(items); next.add(item); commit(next); return item;
    }
    synchronized void remove(String id, String owner) throws IncomingSharePolicy.Failure {
        validId(id); IncomingSharePolicy.owner(owner); load();
        List<Item> next = new ArrayList<>(items);
        if (!next.removeIf(item -> item.id.equals(id) && (item.owner == null || item.owner.equals(owner)))) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.INVALID);
        commit(next);
    }
    synchronized boolean clear(String owner) throws IncomingSharePolicy.Failure {
        IncomingSharePolicy.owner(owner);
        try { load(); }
        catch (IncomingSharePolicy.Failure error) {
            if (error.code != IncomingSharePolicy.Code.INVALID) throw error;
            // Unknown owners in corrupt bytes must be retained intact, never selectively guessed or deleted.
            try { storage.quarantineAndReset(serialize(new ArrayList<>())); items = new ArrayList<>(); broken = null; loaded = true; return true; }
            catch (IOException | RuntimeException failure) { throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE); }
        }
        List<Item> next = new ArrayList<>();
        for (Item item : items) if (item.owner != null && !item.owner.equals(owner)) next.add(item);
        commit(next); return false;
    }
    synchronized void purgeOwned(String owner) throws IncomingSharePolicy.Failure {
        IncomingSharePolicy.owner(owner); load();
        try {
            // A quarantined corrupt snapshot has unknown owners. Preserve it,
            // but do not acknowledge complete erasure while it still exists.
            if (storage.hasQuarantine()) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.INVALID);
        } catch (IOException | RuntimeException error) {
            throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE);
        }
        List<Item> next = new ArrayList<>();
        for (Item item : items) if (!owner.equals(item.owner)) next.add(item);
        commit(next);
    }
    private void commit(List<Item> next) throws IncomingSharePolicy.Failure {
        try { storage.write(serialize(next)); items = next; }
        catch (IOException | RuntimeException e) { throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE); }
    }
    private static void validId(String id) throws IncomingSharePolicy.Failure {
        if (id == null || !IncomingSharePolicy.UUID.matcher(id).matches()) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.INVALID);
    }
    private static void validate(Item item) throws IncomingSharePolicy.Failure {
        validId(item.id);
        if (item.owner != null) IncomingSharePolicy.owner(item.owner);
        IncomingSharePolicy.name(item.name);
        if ((!"text".equals(item.kind) && !"file".equals(item.kind)) || !IncomingSharePolicy.canonical(item.mediaType)
            || (item.kind.equals("text") && !item.mediaType.equals("text/plain")) || (item.kind.equals("file") && item.mediaType.equals("text/plain"))
            || item.createdAt <= 0 || item.createdAt > 8640000000000000L) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.INVALID);
        byte[] bytes = IncomingSharePolicy.encode(item.text, item.kind.equals("text") ? IncomingSharePolicy.TEXT_BYTES : IncomingSharePolicy.FILE_BYTES);
        IncomingSharePolicy.encode(item.name, 512);
        if (item.sizeBytes != bytes.length) throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.INVALID);
    }
    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(); }
    }
    private static byte[] digest(byte[] value) { return sha256().digest(value); }
    private static byte[] serialize(List<Item> items) throws IOException, IncomingSharePolicy.Failure {
        ByteArrayOutputStream data = new ByteArrayOutputStream(); MessageDigest checksum = sha256();
        DataOutputStream out = new DataOutputStream(new DigestOutputStream(data, checksum));
        out.writeLong(0x50514953544f5232L); out.writeInt(items.size());
        for (Item item : items) {
            validate(item); out.writeUTF(item.id); out.writeUTF(item.name); out.writeUTF(item.kind); out.writeUTF(item.mediaType); out.writeLong(item.createdAt);
            out.writeBoolean(item.owner != null); if (item.owner != null) out.writeUTF(item.owner);
            byte[] text = item.text.getBytes(java.nio.charset.StandardCharsets.UTF_8); out.writeInt(text.length); out.write(text);
        }
        out.flush(); out.write(checksum.digest()); out.flush(); return data.toByteArray();
    }
    private static List<Item> parse(byte[] bytes) throws IncomingSharePolicy.Failure {
        try {
            if (bytes.length < 44 || bytes.length > SNAPSHOT_BYTES) throw new IOException();
            byte[] body = Arrays.copyOf(bytes, bytes.length - 32);
            if (!MessageDigest.isEqual(digest(body), Arrays.copyOfRange(bytes, body.length, bytes.length))) throw new IOException();
            DataInputStream in = new DataInputStream(new ByteArrayInputStream(body));
            if (in.readLong() != 0x50514953544f5232L) throw new IOException();
            int count = in.readInt(); if (count < 0 || count > IncomingSharePolicy.ITEMS) throw new IOException();
            List<Item> result = new ArrayList<>(); HashSet<String> ids = new HashSet<>(); long total = 0;
            for (int i = 0; i < count; i++) {
                String id = in.readUTF(), name = in.readUTF(), kind = in.readUTF(), type = in.readUTF(); long at = in.readLong();
                int marker = in.readUnsignedByte(); if (marker != 0 && marker != 1) throw new IOException();
                String owner = marker == 1 ? in.readUTF() : null;
                int size = in.readInt();
                if (size <= 0 || size > IncomingSharePolicy.FILE_BYTES || size > in.available()) throw new IOException();
                byte[] text = new byte[size]; in.readFully(text);
                Item item = new Item(id, name, kind, type, IncomingSharePolicy.decode(text, IncomingSharePolicy.FILE_BYTES), size, at, owner);
                validate(item); total += size;
                if (!ids.add(id) || total > IncomingSharePolicy.TOTAL_BYTES) throw new IOException();
                result.add(item);
            }
            if (in.available() != 0) throw new IOException();
            return result;
        } catch (IOException | RuntimeException e) { throw new IncomingSharePolicy.Failure(IncomingSharePolicy.Code.INVALID); }
    }
}
