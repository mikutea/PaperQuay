package dev.paperquay.mobile;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/** Pure policy: neither URIs nor filesystem locations cross the plugin bridge. */
final class IncomingSharePolicy {
    static final int TEXT_BYTES = 64 * 1024;
    static final int FILE_BYTES = 4 * 1024 * 1024;
    static final int TOTAL_BYTES = 8 * 1024 * 1024;
    static final int ITEMS = 4;
    static final Pattern UUID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    static final Pattern OWNER = Pattern.compile("[0-9a-f]{64}");
    enum Code { FULL, UNSUPPORTED, TOO_LARGE, INVALID, READ_FAILED, STORAGE_UNAVAILABLE }
    static final class Failure extends Exception {
        final Code code;
        Failure(Code code) { super(code.name()); this.code = code; }
    }
    static String mime(String value) {
        if (value == null) return "";
        return value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
    }
    static String canonicalMime(String raw) {
        switch (mime(raw)) {
            case "text/plain": return "text/plain";
            case "application/json": case "text/json": return "application/json";
            case "text/markdown": case "text/x-markdown": return "text/markdown";
            case "application/x-bibtex": case "application/bibtex": case "text/x-bibtex": return "application/x-bibtex";
            case "application/x-research-info-systems": case "application/ris": case "text/ris": case "text/x-research-info-systems": return "application/x-research-info-systems";
            default: return null;
        }
    }
    static boolean canonical(String mediaType) { return mediaType != null && mediaType.equals(canonicalMime(mediaType)); }
    static void owner(String value) throws Failure {
        if (value == null || !OWNER.matcher(value).matches()) throw new Failure(Code.INVALID);
    }
    private static boolean jsTrim(char c) {
        return (c >= 0x09 && c <= 0x0d) || c == '\u0020' || c == '\u00a0' || c == '\u1680'
            || (c >= '\u2000' && c <= '\u200a') || c == '\u2028' || c == '\u2029' || c == '\u202f'
            || c == '\u205f' || c == '\u3000' || c == '\ufeff';
    }
    static void name(String value) throws Failure {
        if (value == null || value.isEmpty() || value.length() > 128 || value.equals(".") || value.equals("..")
            || jsTrim(value.charAt(0)) || jsTrim(value.charAt(value.length() - 1))) throw new Failure(Code.INVALID);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '/' || c == '\\' || c == ':' || Character.isISOControl(c)) throw new Failure(Code.INVALID);
            if (Character.isHighSurrogate(c)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) throw new Failure(Code.INVALID);
            } else if (Character.isLowSurrogate(c)) throw new Failure(Code.INVALID);
        }
    }
    static String basename(String raw, String fallback) throws Failure {
        String value = raw == null ? fallback : raw;
        name(value); return value;
    }
    static String fileMime(String rawMime, String name) throws Failure {
        String suffix = name.toLowerCase(Locale.ROOT);
        String byName = suffix.endsWith(".json") ? "application/json" : suffix.endsWith(".md") || suffix.endsWith(".markdown") ? "text/markdown"
            : suffix.endsWith(".bib") || suffix.endsWith(".bibtex") ? "application/x-bibtex" : suffix.endsWith(".ris") ? "application/x-research-info-systems" : null;
        String provided = canonicalMime(rawMime);
        String raw = mime(rawMime);
        if (byName == null || (!raw.isEmpty() && !raw.equals("application/octet-stream") && !raw.equals("text/plain") && !byName.equals(provided)))
            throw new Failure(Code.UNSUPPORTED);
        return byName;
    }
    static String fallback(String rawMime) {
        String type = canonicalMime(rawMime);
        if ("application/json".equals(type)) return "shared.json";
        if ("text/markdown".equals(type)) return "shared.md";
        if ("application/x-bibtex".equals(type)) return "shared.bib";
        if ("application/x-research-info-systems".equals(type)) return "shared.ris";
        return "shared.txt";
    }
    static byte[] encode(String text, int limit) throws Failure {
        if (text == null || text.length() > limit) throw new Failure(text == null ? Code.INVALID : Code.TOO_LARGE);
        if (text.isEmpty()) throw new Failure(Code.INVALID);
        // Validate UTF-16 before getBytes can replace an unpaired surrogate. Avoid
        // the encoder's 3x buffer and a second decoded 4MiB String for each commit.
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isISOControl(c) && c != '\t' && c != '\r' && c != '\n') throw new Failure(Code.INVALID);
            if (Character.isHighSurrogate(c)) {
                if (++i >= text.length() || !Character.isLowSurrogate(text.charAt(i))) throw new Failure(Code.INVALID);
            } else if (Character.isLowSurrogate(c)) throw new Failure(Code.INVALID);
        }
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > limit) throw new Failure(Code.TOO_LARGE);
        return bytes;
    }
    static String decode(byte[] bytes, int limit) throws Failure {
        if (bytes == null || bytes.length == 0) throw new Failure(Code.INVALID);
        if (bytes.length > limit) throw new Failure(Code.TOO_LARGE);
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (Character.isISOControl(c) && c != '\t' && c != '\r' && c != '\n') throw new Failure(Code.INVALID);
            }
            return text;
        } catch (CharacterCodingException e) { throw new Failure(Code.INVALID); }
    }
}
