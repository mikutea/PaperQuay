package dev.paperquay.mobile;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** Plain javac/java harness. Android/Capacitor compilation and device tests are separate evidence. */
public final class IncomingShareStoreTest {
    private static int assertions;
    private static final String OWNER_A = new String(new char[64]).replace('\0', 'a');
    private static final String OWNER_B = new String(new char[64]).replace('\0', 'b');
    private static final class Memory implements IncomingShareStore.Storage {
        byte[] bytes, quarantine;
        boolean failWrite, failClear;
        public byte[] read() { return bytes == null ? null : bytes.clone(); }
        public boolean hasQuarantine() { return quarantine != null; }
        public void write(byte[] value) throws IOException { if (failWrite) throw new IOException("private detail"); bytes = value.clone(); }
        public void quarantineAndReset(byte[] empty) throws IOException {
            if (failClear || quarantine != null) throw new IOException();
            quarantine = bytes.clone(); bytes = null; write(empty);
        }
    }
    interface Operation { void run() throws Exception; }
    private static void equal(Object expected, Object actual) { assertions++; if (!expected.equals(actual)) throw new AssertionError(expected + " != " + actual); }
    private static void failure(IncomingSharePolicy.Code code, Operation operation) throws Exception {
        assertions++;
        try { operation.run(); throw new AssertionError("expected " + code); }
        catch (IncomingSharePolicy.Failure error) { if (error.code != code || !error.getMessage().equals(code.name())) throw new AssertionError(error); }
    }
    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private static byte[] ascii(int length) { byte[] result = new byte[length]; Arrays.fill(result, (byte) 'x'); return result; }
    private static IncomingShareStore.Item add(IncomingShareStore store, byte[] bytes, boolean file) throws Exception {
        return store.add(file ? "references.json" : "Shared text.txt", file ? "file" : "text", file ? "application/json" : "text/plain", bytes, 1793232000000L);
    }
    public static void main(String[] args) throws Exception {
        if (args.length == 2 && args[0].equals("--bridge-fixtures")) { writeBridgeFixtures(args[1]); return; }
        ownedErasure();
        Memory memory = new Memory(); IncomingShareStore store = new IncomingShareStore(memory);
        String raw = "\ufeff标题\r\n\t$\\alpha$ e\u0301 😀\n";
        IncomingShareStore.Item first = add(store, bytes(raw), false);
        equal(first.id, add(new IncomingShareStore(memory), bytes(raw), false).id);
        equal(raw, store.read(first.id, OWNER_A).text); equal(bytes(raw).length, first.sizeBytes);
        equal(raw, new IncomingShareStore(memory).read(first.id, OWNER_A).text);
        equal(1, store.list(OWNER_A).size()); store.list(OWNER_A).clear(); equal(1, store.list(OWNER_A).size());
        failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.basename("C:\\private\\folder/refs.json", "shared.json"));
        failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.basename("..", "shared.json"));
        failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.basename(new String(ascii(300), StandardCharsets.UTF_8), "x"));
        equal("shared.json", IncomingSharePolicy.basename(null, "shared.json"));
        equal("application/json", IncomingSharePolicy.fileMime("application/octet-stream", "refs.json"));
        equal("application/x-bibtex", IncomingSharePolicy.fileMime("text/plain", "refs.bib"));
        equal("application/x-research-info-systems", IncomingSharePolicy.fileMime("text/ris", "refs.ris"));
        failure(IncomingSharePolicy.Code.UNSUPPORTED, () -> IncomingSharePolicy.fileMime("application/pdf", "refs.json"));
        failure(IncomingSharePolicy.Code.UNSUPPORTED, () -> IncomingSharePolicy.fileMime("application/json", "refs.pdf"));
        failure(IncomingSharePolicy.Code.UNSUPPORTED, () -> IncomingSharePolicy.fileMime("text/html", "refs.md"));
        for (byte[] invalid : new byte[][]{ {0}, {1}, {127}, {(byte) 0xc2, (byte) 0x80}, {(byte) 0xc0, (byte) 0xaf}, {(byte) 0xe4, (byte) 0xb8}, {(byte) 0xed, (byte) 0xa0, (byte) 0x80} })
            failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.decode(invalid, 65536));
        failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.encode("\ud800", 65536));
        failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.encode("\udc00", 65536));
        failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.encode("x\0", 65536));
        failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.decode(new byte[0], 65536));
        equal("\t\r\n", IncomingSharePolicy.decode(bytes("\t\r\n"), 65536));
        equal(65536, IncomingSharePolicy.encode(new String(ascii(65536), StandardCharsets.UTF_8), 65536).length);
        failure(IncomingSharePolicy.Code.TOO_LARGE, () -> IncomingSharePolicy.encode(new String(ascii(65537), StandardCharsets.UTF_8), 65536));
        String multiByte = new String(new char[21845]).replace('\0', '汉');
        equal(65535, IncomingSharePolicy.encode(multiByte, 65536).length);
        failure(IncomingSharePolicy.Code.TOO_LARGE, () -> IncomingSharePolicy.encode(multiByte + "汉", 65536));
        memory.failWrite = true;
        failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE, () -> add(store, bytes("not committed"), false));
        equal(1, store.list(OWNER_A).size()); equal(raw, new IncomingShareStore(memory).read(first.id, OWNER_A).text);
        failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE, () -> store.remove(first.id, OWNER_A)); equal(1, store.list(OWNER_A).size());
        memory.failWrite = false;
        failure(IncomingSharePolicy.Code.INVALID, () -> store.remove("../items.bin", OWNER_A));
        failure(IncomingSharePolicy.Code.INVALID, () -> store.remove("ABCDEF00-0000-0000-0000-000000000000", OWNER_A));
        store.remove(first.id, OWNER_A); equal(0, new IncomingShareStore(memory).list(OWNER_A).size());
        IncomingShareStore large = new IncomingShareStore(new Memory());
        add(large, ascii(4 * 1024 * 1024), true);
        byte[] secondLarge = ascii(4 * 1024 * 1024); secondLarge[0] = 'y'; add(large, secondLarge, true);
        failure(IncomingSharePolicy.Code.FULL, () -> add(large, bytes("x"), true)); equal(2, large.list(OWNER_A).size());
        failure(IncomingSharePolicy.Code.TOO_LARGE, () -> add(new IncomingShareStore(new Memory()), ascii(4 * 1024 * 1024 + 1), true));
        IncomingShareStore four = new IncomingShareStore(new Memory()); for (int i = 0; i < 4; i++) add(four, bytes("record" + i), false);
        failure(IncomingSharePolicy.Code.FULL, () -> add(four, bytes("fifth"), false)); equal(4, four.list(OWNER_A).size());
        add(store, bytes("preserved"), false); memory.bytes[15] ^= 1;
        IncomingShareStore broken = new IncomingShareStore(memory);
        failure(IncomingSharePolicy.Code.INVALID, () -> broken.list(OWNER_A));
        failure(IncomingSharePolicy.Code.INVALID, () -> add(broken, bytes("must not overwrite"), false));
        memory.failClear = true; failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE, () -> broken.clear(OWNER_A));
        byte[] corruptOriginal = memory.bytes.clone();
        memory.failClear = false; equal(true, broken.clear(OWNER_A)); equal(true, Arrays.equals(corruptOriginal, memory.quarantine));
        equal(0, broken.list(OWNER_A).size()); add(broken, bytes("recovered"), false);
        equal("recovered", new IncomingShareStore(memory).list(OWNER_A).get(0).text);
        Memory trailing = new Memory(); trailing.bytes = Arrays.copyOf(memory.bytes, memory.bytes.length + 1);
        failure(IncomingSharePolicy.Code.INVALID, () -> new IncomingShareStore(trailing).list(OWNER_A));
        // This is the same gate used by the Android adapter, not a reimplementation of its race.
        IncomingShareStore intakeStore = new IncomingShareStore(new Memory()); AtomicLong clock = new AtomicLong(0);
        IncomingShareStore.Intake timedOut = new IncomingShareStore.Intake(intakeStore, clock::get, 100);
        equal(true, timedOut.cancel());
        failure(IncomingSharePolicy.Code.READ_FAILED, () -> timedOut.commit("x.json", "file", "application/json", bytes("late provider"), 1));
        equal(false, timedOut.accepted()); equal(0, intakeStore.list(OWNER_A).size());
        IncomingShareStore.Intake lateTimer = new IncomingShareStore.Intake(intakeStore, clock::get, 100); clock.set(100);
        failure(IncomingSharePolicy.Code.READ_FAILED, () -> lateTimer.commit("x.json", "file", "application/json", bytes("deadline reached"), 1));
        equal(0, intakeStore.list(OWNER_A).size());
        clock.set(0); IncomingShareStore.Intake accepted = new IncomingShareStore.Intake(intakeStore, clock::get, 100);
        accepted.commit("x.json", "file", "application/json", bytes("on time"), 1); clock.set(200);
        equal(true, accepted.accepted()); equal(false, accepted.cancel()); intakeStore.clear(OWNER_A); equal(0, intakeStore.list(OWNER_A).size());
        clock.set(0); IncomingShareStore.Intake blocked = new IncomingShareStore.Intake(intakeStore, clock::get, 100);
        CountDownLatch started = new CountDownLatch(1); AtomicReference<Throwable> background = new AtomicReference<>();
        Thread lateReader = new Thread(() -> {
            started.countDown();
            try { blocked.commit("x.json", "file", "application/json", bytes("late after clear"), 1); }
            catch (Throwable error) { background.set(error); }
        });
        synchronized (intakeStore) { lateReader.start(); started.await(); blocked.cancel(); intakeStore.clear(OWNER_A); }
        lateReader.join(1000); equal(false, lateReader.isAlive());
        equal(IncomingSharePolicy.Code.READ_FAILED, ((IncomingSharePolicy.Failure) background.get()).code); equal(0, intakeStore.list(OWNER_A).size());
        ownerIsolation();
        strictNames();
        System.out.println("PASS IncomingShareStoreTest: " + assertions + " assertions (pure Java; no Android runtime)");
    }
    private static void ownedErasure() throws Exception {
        Memory memory = new Memory(); IncomingShareStore store = new IncomingShareStore(memory);
        IncomingShareStore.Item own = add(store, bytes("own private input"), false);
        IncomingShareStore.Item foreign = add(store, bytes("foreign private input"), false);
        IncomingShareStore.Item unassigned = add(store, bytes("unassigned input"), false);
        store.read(own.id, OWNER_A); store.read(foreign.id, OWNER_B);
        memory.failWrite = true;
        failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE, () -> store.purgeOwned(OWNER_A));
        equal("own private input", new IncomingShareStore(memory).read(own.id, OWNER_A).text);
        memory.failWrite = false; store.purgeOwned(OWNER_A);
        IncomingShareStore restarted = new IncomingShareStore(memory);
        equal(1, restarted.list(OWNER_A).size()); equal(unassigned.id, restarted.list(OWNER_A).get(0).id);
        equal(2, restarted.list(OWNER_B).size()); equal("foreign private input", restarted.read(foreign.id, OWNER_B).text);
        store.purgeOwned(OWNER_A); equal(1, new IncomingShareStore(memory).list(OWNER_A).size());
        memory.quarantine = bytes("unknown corrupt private content");
        failure(IncomingSharePolicy.Code.INVALID, () -> store.purgeOwned(OWNER_A));
        equal(1, new IncomingShareStore(memory).list(OWNER_A).size());
    }
    private static void ownerIsolation() throws Exception {
        Memory memory = new Memory(); IncomingShareStore inbox = new IncomingShareStore(memory);
        IncomingShareStore.Item first = add(inbox, bytes("private A/B input"), false);
        equal(first.id, inbox.list(OWNER_A).get(0).id); equal(first.id, inbox.list(OWNER_B).get(0).id);
        memory.failWrite = true; AtomicReference<IncomingShareStore.Item> leaked = new AtomicReference<>();
        failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE, () -> leaked.set(inbox.read(first.id, OWNER_A)));
        equal(true, leaked.get() == null); equal(1, new IncomingShareStore(memory).list(OWNER_B).size());
        memory.failWrite = false; IncomingShareStore.Item claimed = inbox.read(first.id, OWNER_A);
        equal(first.id, claimed.id); equal(first.createdAt, claimed.createdAt);
        IncomingShareStore restarted = new IncomingShareStore(memory);
        equal(0, restarted.list(OWNER_B).size());
        failure(IncomingSharePolicy.Code.INVALID, () -> restarted.read(first.id, OWNER_B));
        failure(IncomingSharePolicy.Code.INVALID, () -> restarted.remove(first.id, OWNER_B));
        memory.failWrite = true;
        equal("private A/B input", restarted.read(first.id, new String(OWNER_A)).text); // Stable owner across sign-in/restart needs no rewrite.
        memory.failWrite = false;
        IncomingShareStore.Item sameNewShare = add(restarted, bytes("private A/B input"), false);
        equal(false, sameNewShare.id.equals(first.id));
        equal(sameNewShare.id, add(restarted, bytes("private A/B input"), false).id);
        equal(1, restarted.list(OWNER_B).size()); restarted.read(sameNewShare.id, OWNER_B);
        add(restarted, bytes("unclaimed"), false);
        memory.failWrite = true; failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE, () -> restarted.clear(OWNER_A));
        equal(2, restarted.list(OWNER_A).size()); equal(2, restarted.list(OWNER_B).size());
        memory.failWrite = false; equal(false, restarted.clear(OWNER_A));
        equal(0, restarted.list(OWNER_A).size()); equal(1, restarted.list(OWNER_B).size());
        equal("private A/B input", new IncomingShareStore(memory).read(sameNewShare.id, OWNER_B).text);
        failure(IncomingSharePolicy.Code.INVALID, () -> restarted.remove(sameNewShare.id, OWNER_A));
        for (String invalid : new String[]{null, "a", OWNER_A.toUpperCase(java.util.Locale.ROOT), "https://account.example/user"}) {
            failure(IncomingSharePolicy.Code.INVALID, () -> restarted.list(invalid));
            failure(IncomingSharePolicy.Code.INVALID, () -> restarted.read(sameNewShare.id, invalid));
            failure(IncomingSharePolicy.Code.INVALID, () -> restarted.remove(sameNewShare.id, invalid));
            failure(IncomingSharePolicy.Code.INVALID, () -> restarted.clear(invalid));
        }
        // Corrupt owner bytes without updating the snapshot digest. Preserve the exact bytes before resetting.
        byte[] beforeCorruption = memory.bytes.clone();
        for (int i = 0; i < memory.bytes.length - 64; i++) {
            boolean ownerAt = true; for (int j = 0; j < 64; j++) if (memory.bytes[i + j] != 'b') { ownerAt = false; break; }
            if (ownerAt) { memory.bytes[i] = 'a'; break; }
        }
        equal(false, Arrays.equals(beforeCorruption, memory.bytes));
        byte[] original = memory.bytes.clone(); IncomingShareStore damaged = new IncomingShareStore(memory);
        failure(IncomingSharePolicy.Code.INVALID, () -> damaged.list(OWNER_A));
        equal(true, damaged.clear(OWNER_A)); equal(true, Arrays.equals(original, memory.quarantine));
        equal(0, damaged.list(OWNER_A).size()); equal(0, damaged.list(OWNER_B).size());
        add(damaged, bytes("second snapshot"), false); memory.bytes[15] ^= 1;
        byte[] second = memory.bytes.clone(); IncomingShareStore damagedAgain = new IncomingShareStore(memory);
        failure(IncomingSharePolicy.Code.STORAGE_UNAVAILABLE, () -> damagedAgain.clear(OWNER_B));
        equal(true, Arrays.equals(original, memory.quarantine)); equal(true, Arrays.equals(second, memory.bytes));
    }
    private static List<String> invalidNames() {
        List<String> names = new ArrayList<>(Arrays.asList("notes:2026.md", "dir/notes.md", "dir\\notes.md", "", ".", "..", "notes\0.md", "notes\u007f.md",
            "notes\t2026.md", "notes\r2026.md", "notes\n2026.md", "\ud800.md", "x\udc00.md", new String(ascii(129), StandardCharsets.UTF_8)));
        int[] spaces = {0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
            0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff};
        for (int space : spaces) { names.add((char) space + "notes.md"); names.add("notes.md" + (char) space); }
        return names;
    }
    private static void strictNames() throws Exception {
        Memory memory = new Memory(); IncomingShareStore inbox = new IncomingShareStore(memory);
        String original = "original\t$\\alpha$\r\n正文\n";
        IncomingShareStore.Item good = inbox.add("normal.md", "file", "text/markdown", bytes(original), 1);
        inbox.read(good.id, OWNER_A); byte[] before = memory.bytes.clone();
        for (String invalid : invalidNames()) {
            failure(IncomingSharePolicy.Code.INVALID, () -> IncomingSharePolicy.basename(invalid, "shared.md"));
            failure(IncomingSharePolicy.Code.INVALID, () -> inbox.add(invalid, "file", "text/markdown", bytes("new rejected input"), 1));
            equal(true, Arrays.equals(before, memory.bytes)); equal(1, inbox.list(OWNER_A).size()); equal(original, inbox.read(good.id, OWNER_A).text);
        }
        String boundary = new String(ascii(123), StandardCharsets.UTF_8) + "😀.md";
        equal(128, boundary.length()); equal(boundary, IncomingSharePolicy.basename(boundary, "shared.md"));
        equal("notes\u00a0draft.md", IncomingSharePolicy.basename("notes\u00a0draft.md", "shared.md"));
        // Simulate an old writer that accepted an illegal name but wrote a valid checksum.
        ByteArrayOutputStream body = new ByteArrayOutputStream(); DataOutputStream output = new DataOutputStream(body);
        output.writeLong(0x50514953544f5232L); output.writeInt(2);
        String[] ids = {"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"};
        String[] names = {"normal.md", "notes:2026.md"};
        for (int i = 0; i < 2; i++) {
            output.writeUTF(ids[i]); output.writeUTF(names[i]); output.writeUTF("file"); output.writeUTF("text/markdown"); output.writeLong(1); output.writeBoolean(false);
            byte[] text = bytes(i == 0 ? original : "preserve rejected original too"); output.writeInt(text.length); output.write(text);
        }
        output.flush(); byte[] checksum = MessageDigest.getInstance("SHA-256").digest(body.toByteArray()); output.write(checksum); output.flush();
        Memory old = new Memory(); old.bytes = body.toByteArray(); byte[] raw = old.bytes.clone(); IncomingShareStore legacy = new IncomingShareStore(old);
        failure(IncomingSharePolicy.Code.INVALID, () -> legacy.list(OWNER_A));
        failure(IncomingSharePolicy.Code.INVALID, () -> legacy.read(ids[0], OWNER_A));
        equal(true, Arrays.equals(raw, old.bytes)); equal(true, legacy.clear(OWNER_A)); equal(true, Arrays.equals(raw, old.quarantine));
    }
    private static String quote(String value) {
        StringBuilder output = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') output.append('\\').append(c);
            else if (c < 32 || Character.isSurrogate(c)) output.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
            else output.append(c);
        }
        return output.append('"').toString();
    }
    private static String wire(IncomingShareStore.Item item, boolean text) {
        return "{\"version\":1,\"id\":" + quote(item.id) + ",\"name\":" + quote(item.name) + ",\"kind\":" + quote(item.kind) + ",\"mediaType\":" + quote(item.mediaType)
            + ",\"sizeBytes\":" + item.sizeBytes + ",\"createdAt\":" + item.createdAt + (text ? ",\"text\":" + quote(item.text) : "") + "}";
    }
    private static void writeBridgeFixtures(String path) throws Exception {
        IncomingShareStore inbox = new IncomingShareStore(new Memory());
        String[] names = {"normal.md", "中文😀.md", "notes\u00a0draft.md", new String(ascii(123), StandardCharsets.UTF_8) + "😀.md"};
        for (String name : names) inbox.add(name, "file", "text/markdown", bytes("line1\t$\\alpha$\r\nline2\n"), 1793232000000L);
        List<IncomingShareStore.Item> visible = inbox.list(OWNER_A); StringBuilder json = new StringBuilder("{\"list\":{\"items\":[");
        for (int i = 0; i < visible.size(); i++) { if (i != 0) json.append(','); json.append(wire(visible.get(i), false)); }
        json.append("],\"notice\":null},\"items\":[");
        for (int i = 0; i < visible.size(); i++) { if (i != 0) json.append(','); json.append(wire(inbox.read(visible.get(i).id, OWNER_A), true)); }
        json.append("],\"rejectedNames\":["); List<String> rejected = invalidNames();
        for (int i = 0; i < rejected.size(); i++) { if (i != 0) json.append(','); json.append(quote(rejected.get(i))); }
        json.append("]}"); try (FileOutputStream output = new FileOutputStream(path)) { output.write(bytes(json.toString())); }
        System.out.println("PASS Native fixture export: " + visible.size() + " actual store items, " + rejected.size() + " rejected-name cases");
    }
}
