// File operations below never re-open a pathname after validating it. Each
// component is opened relative to a retained, no-follow directory handle.
// No renderer input or authorization policy belongs in this low-level module.
#include <node_api.h>
#include <uv.h>
#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#if defined(_WIN32) && !_HAS_EXCEPTIONS
#error PaperQuay requires owning standard exceptions; remove node-gyp's _HAS_EXCEPTIONS=0.
#endif
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winternl.h>
#include <winioctl.h>
#include <io.h>
#include <fcntl.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>
#endif

struct Failure : std::runtime_error {
  std::string code;
  Failure(std::string code, std::string message) : std::runtime_error(message), code(code) {}
};
static void unsafe(const char* reason) { throw Failure("EPERM", reason); }

#ifdef _WIN32
using Name = std::wstring;
using Handle = HANDLE;
static const Handle Invalid = INVALID_HANDLE_VALUE;
static void closeHandle(Handle handle) { if (handle != Invalid) CloseHandle(handle); }
static Name wide(const std::string& text) {
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), (int)text.size(), nullptr, 0);
  if (!size && !text.empty()) unsafe("Invalid UTF-8 path.");
  Name result(size, 0);
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), (int)text.size(), result.data(), size);
  return result;
}
static std::string utf8(const Name& text) {
  int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), (int)text.size(), nullptr, 0, nullptr, nullptr);
  if (!size && !text.empty()) unsafe("Invalid Unicode path.");
  std::string result(size, 0);
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), (int)text.size(), result.data(), size, nullptr, nullptr);
  return result;
}
static std::string errorCode(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_ALREADY_EXISTS: case ERROR_FILE_EXISTS: return "EEXIST";
    case ERROR_DIRECTORY: return "ENOTDIR";
    case ERROR_ACCESS_DENIED: return "EACCES";
    case ERROR_SHARING_VIOLATION: case ERROR_LOCK_VIOLATION: return "EBUSY";
    case ERROR_DISK_FULL: case ERROR_HANDLE_DISK_FULL: return "ENOSPC";
    default: return "EIO";
  }
}
static void winError(DWORD error, const char* operation) {
  throw Failure(errorCode(error), std::string(operation) + " failed (Windows " + std::to_string(error) + ").");
}
using NtCreateFileFn = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
  PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtSetInformationFileFn = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
using RtlNtStatusToDosErrorFn = ULONG (WINAPI*)(NTSTATUS);
static const auto NtCreate = reinterpret_cast<NtCreateFileFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
static const auto NtSet = reinterpret_cast<NtSetInformationFileFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
static const auto NtError = reinterpret_cast<RtlNtStatusToDosErrorFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
static void ntCheck(NTSTATUS status, const char* op) { if (status < 0) winError(NtError(status), op); }
static Handle relativeOpen(Handle parent, const Name& name, ACCESS_MASK access, ULONG disposition,
                           bool directory, bool denyDelete = true) {
  if (!NtCreate || !NtSet || !NtError) unsafe("Native filesystem APIs unavailable.");
  if (name.size() > 32760) unsafe("Path component is too long.");
  UNICODE_STRING text{}; text.Buffer = const_cast<wchar_t*>(name.data());
  text.Length = (USHORT)(name.size() * sizeof(wchar_t)); text.MaximumLength = text.Length;
  OBJECT_ATTRIBUTES attributes{}; attributes.Length = sizeof(attributes); attributes.RootDirectory = parent;
  attributes.ObjectName = &text; attributes.Attributes = 0x40; // OBJ_CASE_INSENSITIVE
  IO_STATUS_BLOCK io{}; Handle result = Invalid;
  // OPEN_REPARSE_POINT is essential for the *single* component. A multi-part
  // relative name would still follow an intermediate junction.
  ntCheck(NtCreate(&result, access | SYNCHRONIZE | FILE_READ_ATTRIBUTES, &attributes, &io, nullptr,
    FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE | (denyDelete ? 0 : FILE_SHARE_DELETE),
    disposition, 0x00200000 /* FILE_OPEN_REPARSE_POINT */ | 0x20 /* FILE_SYNCHRONOUS_IO_NONALERT */ |
    (directory ? 0x1 /* FILE_DIRECTORY_FILE */ : 0), nullptr, 0), "Relative open");
  return result;
}
struct Info { bool directory; bool reparse; uint64_t size; uint64_t device; uint64_t inode; uint64_t links; uint64_t modified; };
static Info info(Handle handle) {
  BY_HANDLE_FILE_INFORMATION value{};
  if (!GetFileInformationByHandle(handle, &value)) winError(GetLastError(), "File information");
  return {bool(value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY), bool(value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT),
    (uint64_t(value.nFileSizeHigh) << 32) | value.nFileSizeLow, value.dwVolumeSerialNumber,
    (uint64_t(value.nFileIndexHigh) << 32) | value.nFileIndexLow, value.nNumberOfLinks,
    (uint64_t(value.ftLastWriteTime.dwHighDateTime) << 32) | value.ftLastWriteTime.dwLowDateTime};
}
static Name finalName(Handle handle) {
  DWORD length = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!length) winError(GetLastError(), "Final pathname");
  Name result(length, 0);
  DWORD actual = GetFinalPathNameByHandleW(handle, result.data(), length, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!actual || actual >= length) winError(GetLastError(), "Final pathname");
  result.resize(actual);
  if (result.rfind(L"\\\\?\\UNC\\", 0) == 0) return L"\\\\" + result.substr(8);
  if (result.rfind(L"\\\\?\\", 0) == 0) return result.substr(4);
  unsafe("Unsupported native filesystem namespace."); return {};
}
static Name reparseTarget(Handle handle) {
  std::vector<unsigned char> buffer(MAXIMUM_REPARSE_DATA_BUFFER_SIZE);
  DWORD returned = 0;
  if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, nullptr, 0, buffer.data(), (DWORD)buffer.size(), &returned, nullptr))
    winError(GetLastError(), "Read reparse point");
  if (returned < 16) unsafe("Malformed reparse data.");
  DWORD tag; memcpy(&tag, buffer.data(), sizeof(tag));
  USHORT offset, length;
  memcpy(&offset, buffer.data() + 8, sizeof(offset)); memcpy(&length, buffer.data() + 10, sizeof(length));
  const size_t base = tag == IO_REPARSE_TAG_SYMLINK ? 20 : tag == IO_REPARSE_TAG_MOUNT_POINT ? 16 : 0;
  if (!base || offset % 2 || length % 2 || base + offset + length > returned) unsafe("Unsupported reparse point.");
  Name target(reinterpret_cast<wchar_t*>(buffer.data() + base + offset), length / 2);
  if (target.rfind(L"\\??\\UNC\\", 0) == 0) target = L"\\\\" + target.substr(8);
  else if (target.rfind(L"\\??\\", 0) == 0) target = target.substr(4);
  return target;
}
#else
using Name = std::string;
using Handle = int;
static constexpr Handle Invalid = -1;
static void closeHandle(Handle handle) { if (handle != Invalid) close(handle); }
static Name wide(const std::string& text) { return text; }
static std::string utf8(const Name& text) { return text; }
static void posixError(const char* operation) {
  int saved = errno;
  const char* code = saved == ENOENT ? "ENOENT" : saved == EEXIST ? "EEXIST" : saved == ELOOP ? "EPERM" :
    saved == ENOTDIR ? "ENOTDIR" : saved == EISDIR ? "EISDIR" : saved == EACCES ? "EACCES" : saved == ENOSPC ? "ENOSPC" : "EIO";
  throw Failure(code, std::string(operation) + " failed: " + strerror(saved));
}
struct Info { bool directory; bool reparse; uint64_t size; uint64_t device; uint64_t inode; uint64_t links; uint64_t modified; };
static Info info(Handle handle) {
  struct stat value{}; if (fstat(handle, &value)) posixError("File information");
  if (!S_ISDIR(value.st_mode) && !S_ISREG(value.st_mode)) unsafe("Only regular files and directories are supported.");
#ifdef __APPLE__
  auto modified = value.st_mtimespec;
#else
  auto modified = value.st_mtim;
#endif
  return {bool(S_ISDIR(value.st_mode)), bool(S_ISLNK(value.st_mode)), uint64_t(value.st_size), uint64_t(value.st_dev), uint64_t(value.st_ino), uint64_t(value.st_nlink),
    uint64_t(modified.tv_sec) * 1000000000ULL + uint64_t(modified.tv_nsec)};
}
#endif

struct Owned {
  Handle value = Invalid;
  explicit Owned(Handle value = Invalid) : value(value) {}
  Owned(const Owned&) = delete; Owned& operator=(const Owned&) = delete;
  Owned(Owned&& other) noexcept : value(other.value) { other.value = Invalid; }
  Owned& operator=(Owned&& other) noexcept { if (this != &other) { closeHandle(value); value = other.value; other.value = Invalid; } return *this; }
  ~Owned() { closeHandle(value); }
  Handle release() { Handle result = value; value = Invalid; return result; }
};
struct Parsed { Name root; std::vector<Name> parts; };
static Parsed parse(const std::string& input) {
  if (input.empty() || input.find('\0') != std::string::npos) unsafe("Invalid absolute filesystem path.");
  Name value = wide(input); Parsed result;
#ifdef _WIN32
  std::replace(value.begin(), value.end(), L'/', L'\\');
  if (value.rfind(L"\\\\?\\", 0) == 0 || value.rfind(L"\\\\.\\", 0) == 0 || value.rfind(L"\\??\\", 0) == 0)
    unsafe("Device paths are not supported.");
  size_t start;
  if (value.size() >= 3 && ((value[0] >= L'a' && value[0] <= L'z') || (value[0] >= L'A' && value[0] <= L'Z')) && value[1] == L':' && value[2] == L'\\') {
    result.root = value.substr(0, 3); start = 3;
  } else if (value.rfind(L"\\\\", 0) == 0) {
    auto server = value.find(L'\\', 2); auto share = server == Name::npos ? Name::npos : value.find(L'\\', server + 1);
    if (server == Name::npos || server == 2 || server + 1 == value.size() || share == server + 1) unsafe("Invalid UNC root.");
    result.root = value.substr(0, share == Name::npos ? value.size() : share) + L'\\';
    if (result.root.find_first_of(L":?*", 2) != Name::npos) unsafe("Invalid UNC root.");
    start = share == Name::npos ? value.size() : share + 1;
  } else { unsafe("Absolute filesystem path required."); return {}; }
  for (size_t end; start < value.size(); start = end + 1) {
    end = value.find(L'\\', start); if (end == Name::npos) end = value.size();
    Name part = value.substr(start, end - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ' ||
        part.find_first_of(L":*?<>|\"") != Name::npos || std::any_of(part.begin(), part.end(), [](wchar_t c) { return c < 32; }))
      unsafe("Ambiguous filesystem component is not supported.");
    Name stem = part.substr(0, part.find(L'.')); std::transform(stem.begin(), stem.end(), stem.begin(), towupper);
    if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
        (stem.size() == 4 && (stem.substr(0, 3) == L"COM" || stem.substr(0, 3) == L"LPT") && stem[3] >= L'0' && stem[3] <= L'9'))
      unsafe("Reserved device name is not supported.");
    result.parts.push_back(part);
  }
#else
  if (value[0] != '/') unsafe("Absolute filesystem path required.");
  result.root = "/";
  for (size_t start = 1, end; start < value.size(); start = end + 1) {
    end = value.find('/', start); if (end == Name::npos) end = value.size();
    Name part = value.substr(start, end - start);
    if (part.empty() || part == "." || part == "..") unsafe("Ambiguous filesystem component is not supported.");
    result.parts.push_back(part);
  }
#endif
  return result;
}
static Name join(const Name& parent, const Name& child) {
#ifdef _WIN32
  return parent + (parent.back() == L'\\' ? L"" : L"\\") + child;
#else
  return parent + (parent.back() == '/' ? "" : "/") + child;
#endif
}
static Owned openRoot(const Parsed& value) {
#ifdef _WIN32
  Owned root(CreateFileW(value.root.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (root.value == Invalid) winError(GetLastError(), "Open filesystem root");
#else
  Owned root(open(value.root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (root.value == Invalid) posixError("Open filesystem root");
#endif
  auto details = info(root.value); if (!details.directory || details.reparse) unsafe("Linked filesystem root is not supported.");
  return root;
}
struct Parent {
  Parsed parsed; std::vector<Owned> chain;
  Parent(const std::string& file, bool create, bool includeLeaf = false) : parsed(parse(file)) {
    if (!includeLeaf && parsed.parts.empty()) unsafe("A file leaf is required.");
    chain.emplace_back(openRoot(parsed));
    const size_t count = parsed.parts.size() - (includeLeaf ? 0 : 1);
    for (size_t i = 0; i < count; ++i) {
      const auto& name = parsed.parts[i];
#ifdef _WIN32
      Owned child(relativeOpen(handle(), name, FILE_LIST_DIRECTORY, create ? 3 /* OPEN_IF */ : 1 /* OPEN */, true));
#else
      if (create && mkdirat(handle(), name.c_str(), 0777) && errno != EEXIST) posixError("Create directory");
      Owned child(openat(handle(), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
      if (child.value == Invalid) posixError("Open directory");
#endif
      const auto details = info(child.value);
      if (!details.directory || details.reparse) unsafe("Approved path changed: linked directory is not supported.");
      chain.emplace_back(std::move(child));
    }
  }
  Handle handle() const { return chain.back().value; }
  const Name& leaf() const { return parsed.parts.back(); }
};
static Owned readLeaf(Parent& parent, bool forDelete = false) {
#ifdef _WIN32
  Owned result(relativeOpen(parent.handle(), parent.leaf(), FILE_READ_DATA | (forDelete ? DELETE : 0), 1, false, true));
#else
  Owned result(openat(parent.handle(), parent.leaf().c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC));
  if (result.value == Invalid) posixError("Open file");
#endif
  const auto details = info(result.value);
  if (details.reparse) unsafe("Approved path changed: linked file is not supported.");
  if (details.directory) throw Failure("EISDIR", "Read path is not a file.");
  return result;
}
static std::string identity(const Info& details) { return std::to_string(details.device) + ":" + std::to_string(details.inode); }
static std::string version(const Info& details) { return std::to_string(details.size) + ":" + std::to_string(details.modified); }
static void deleteOpened(Handle handle, Handle parent, const Name& leaf) {
#ifdef _WIN32
  struct Disposition { BOOLEAN remove; } disposition{TRUE}; IO_STATUS_BLOCK io{};
  ntCheck(NtSet(handle, &io, &disposition, sizeof(disposition), (FILE_INFORMATION_CLASS)13), "Delete opened file");
#else
  // unlinkat never follows the leaf. The pinned parent prevents a supplier's
  // ancestor replacement from redirecting deletion into another directory.
  if (unlinkat(parent, leaf.c_str(), 0)) posixError("Delete file");
#endif
}
static size_t readSome(Handle handle, char* bytes, size_t size) {
#ifdef _WIN32
  DWORD amount = 0; if (!ReadFile(handle, bytes, (DWORD)size, &amount, nullptr)) winError(GetLastError(), "Read file"); return amount;
#else
  ssize_t amount; do { amount = read(handle, bytes, size); } while (amount < 0 && errno == EINTR);
  if (amount < 0) posixError("Read file"); return size_t(amount);
#endif
}
static void writeAll(Handle handle, const char* bytes, size_t size) {
  while (size) {
#ifdef _WIN32
    DWORD amount = 0;
    if (!WriteFile(handle, bytes, (DWORD)std::min(size, size_t(1 << 20)), &amount, nullptr)) winError(GetLastError(), "Write file");
#else
    ssize_t amount; do { amount = write(handle, bytes, std::min(size, size_t(1 << 20))); } while (amount < 0 && errno == EINTR);
    if (amount < 0) posixError("Write file");
#endif
    if (!amount) throw Failure("EIO", "Write made no progress."); bytes += amount; size -= amount;
  }
}
static void flush(Handle handle) {
#ifdef _WIN32
  if (!FlushFileBuffers(handle)) winError(GetLastError(), "Flush file");
#else
  if (fsync(handle)) posixError("Flush file");
#endif
}
struct Request {
  std::string operation, path, destination, temporary, expectedIdentity, expectedVersion;
  std::vector<char> bytes;
  bool exclusive = false, singleLink = false; unsigned mode = 0666;
  uint32_t maxBytes = 0;
};
struct Result {
  Info stat{}; bool exists = true; int fd = -1;
  std::vector<char> bytes; std::string actual, linkPath, target, suffix;
  std::vector<std::string> entries;
};
static void atomicWrite(Parent& parent, const Request& request, Handle source, Result& output) {
  // Random single-component names are supplied by node:crypto. Windows retains
  // the temp HANDLE through publication, never reopening its mutable name.
  const auto tempParsed = parse(utf8(join(parent.parsed.root, wide(request.temporary))));
  if (tempParsed.parts.size() != 1 || request.temporary.rfind(".paperquay-", 0) != 0) unsafe("Invalid temporary name.");
  Name temp = wide(request.temporary);
#ifdef _WIN32
  Owned opened(relativeOpen(parent.handle(), temp, FILE_WRITE_DATA | DELETE, 2 /* CREATE */, false, true));
#else
  Owned opened(openat(parent.handle(), temp.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, request.mode));
  if (opened.value == Invalid) posixError("Create temporary file");
#endif
  bool published = false;
  try {
    if (source != Invalid) {
      char buffer[64 * 1024];
      for (size_t length; (length = readSome(source, buffer, sizeof(buffer))); ) writeAll(opened.value, buffer, length);
    } else writeAll(opened.value, request.bytes.data(), request.bytes.size());
    flush(opened.value); output.stat = info(opened.value);
#ifdef _WIN32
    struct Rename { BOOLEAN replace; HANDLE root; ULONG length; WCHAR name[1]; };
    const auto& leaf = parent.leaf();
    std::vector<unsigned char> storage(offsetof(Rename, name) + leaf.size() * sizeof(wchar_t));
    auto* rename = reinterpret_cast<Rename*>(storage.data());
    rename->replace = !request.exclusive; rename->root = parent.handle(); rename->length = (ULONG)(leaf.size() * sizeof(wchar_t));
    memcpy(rename->name, leaf.data(), rename->length); IO_STATUS_BLOCK io{};
    ntCheck(NtSet(opened.value, &io, rename, (ULONG)storage.size(), (FILE_INFORMATION_CLASS)10), "Publish opened file");
    published = true;
#else
    struct stat current{};
    if (fstatat(parent.handle(), temp.c_str(), &current, AT_SYMLINK_NOFOLLOW)) posixError("Verify temporary file");
    if (uint64_t(current.st_dev) != output.stat.device || uint64_t(current.st_ino) != output.stat.inode) unsafe("Temporary file changed before publication.");
    if (request.exclusive) {
      if (linkat(parent.handle(), temp.c_str(), parent.handle(), parent.leaf().c_str(), 0)) posixError("Publish exclusive file");
      if (unlinkat(parent.handle(), temp.c_str(), 0)) posixError("Remove temporary link");
    } else if (renameat(parent.handle(), temp.c_str(), parent.handle(), parent.leaf().c_str())) posixError("Publish file");
    published = true;
    if (fstatat(parent.handle(), parent.leaf().c_str(), &current, AT_SYMLINK_NOFOLLOW)) posixError("Verify published file");
    if (uint64_t(current.st_dev) != output.stat.device || uint64_t(current.st_ino) != output.stat.inode) unsafe("Published file changed concurrently.");
#endif
  } catch (...) {
    if (!published) {
#ifdef _WIN32
      try { deleteOpened(opened.value, parent.handle(), temp); } catch (...) {}
#else
      struct stat current{};
      if (!fstatat(parent.handle(), temp.c_str(), &current, AT_SYMLINK_NOFOLLOW)) {
        auto expected = info(opened.value);
        if (uint64_t(current.st_dev) == expected.device && uint64_t(current.st_ino) == expected.inode) unlinkat(parent.handle(), temp.c_str(), 0);
      }
#endif
    }
    throw;
  }
}
static Result inspect(const std::string& file) {
  auto parsed = parse(file); std::vector<Owned> chain; chain.emplace_back(openRoot(parsed));
  Name current = parsed.root; Result output;
  for (size_t i = 0; i < parsed.parts.size(); ++i) {
    auto next = join(current, parsed.parts[i]);
#ifdef _WIN32
    Owned child;
    try { child = Owned(relativeOpen(chain.back().value, parsed.parts[i], FILE_READ_ATTRIBUTES, 1, false)); }
    catch (const Failure& error) {
      if (error.code != "ENOENT") throw;
      for (; i < parsed.parts.size(); ++i) current = join(current, parsed.parts[i]);
      output.actual = utf8(current); output.exists = false; return output;
    }
    auto details = info(child.value);
    if (details.reparse) {
      output.linkPath = utf8(next); output.target = utf8(reparseTarget(child.value));
      for (++i; i < parsed.parts.size(); ++i) output.suffix = output.suffix.empty() ? utf8(parsed.parts[i]) : output.suffix + "/" + utf8(parsed.parts[i]);
      return output;
    }
    if (i + 1 != parsed.parts.size() && !details.directory) throw Failure("ENOTDIR", "Path parent is not a directory.");
    current = finalName(child.value); output.stat = details; chain.emplace_back(std::move(child));
#else
    struct stat st{};
    if (fstatat(chain.back().value, parsed.parts[i].c_str(), &st, AT_SYMLINK_NOFOLLOW)) {
      if (errno != ENOENT) posixError("Inspect path");
      for (; i < parsed.parts.size(); ++i) current = join(current, parsed.parts[i]);
      output.actual = current; output.exists = false; return output;
    }
    if (S_ISLNK(st.st_mode)) {
      std::vector<char> text(65536);
      ssize_t length = readlinkat(chain.back().value, parsed.parts[i].c_str(), text.data(), text.size());
      if (length < 0) posixError("Inspect symbolic link");
      if (size_t(length) == text.size()) unsafe("Symbolic link target is too long.");
      output.linkPath = next; output.target.assign(text.data(), length);
      for (++i; i < parsed.parts.size(); ++i) output.suffix = output.suffix.empty() ? parsed.parts[i] : output.suffix + "/" + parsed.parts[i];
      return output;
    }
    Owned child(openat(chain.back().value, parsed.parts[i].c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
    if (child.value == Invalid) posixError("Inspect path");
    auto details = info(child.value);
    if (i + 1 != parsed.parts.size() && !details.directory) throw Failure("ENOTDIR", "Path parent is not a directory.");
    current = next; output.stat = details; chain.emplace_back(std::move(child));
#endif
  }
  output.actual = utf8(current); return output;
}
static Result execute(const Request& request) {
  Result output;
  if (request.operation == "inspect") return inspect(request.path);
  if (request.operation == "mkdir") { Parent directory(request.path, true, true); output.stat = info(directory.handle()); return output; }
  if (request.operation == "list") {
    Parent directory(request.path, false, true);
#ifdef _WIN32
    std::vector<unsigned char> buffer(64 * 1024);
    for (;;) {
      if (!GetFileInformationByHandleEx(directory.handle(), FileIdBothDirectoryInfo, buffer.data(), (DWORD)buffer.size())) {
        if (GetLastError() == ERROR_NO_MORE_FILES) break;
        winError(GetLastError(), "List directory");
      }
      auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
      for (;;) {
        Name name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
        if (name != L"." && name != L"..") output.entries.push_back(utf8(name));
        if (!entry->NextEntryOffset) break;
        entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<unsigned char*>(entry) + entry->NextEntryOffset);
      }
    }
#else
    int duplicate = dup(directory.handle());
    if (duplicate < 0) posixError("Duplicate directory");
    DIR* raw = fdopendir(duplicate);
    if (!raw) { close(duplicate); posixError("List directory"); }
    std::unique_ptr<DIR, decltype(&closedir)> listing(raw, closedir);
    for (;;) {
      errno = 0; auto* entry = readdir(listing.get());
      if (!entry) { if (errno) posixError("List directory"); break; }
      std::string name(entry->d_name);
      if (name != "." && name != "..") output.entries.push_back(name);
    }
#endif
    return output;
  }
  if (request.operation == "write") { Parent parent(request.path, true); atomicWrite(parent, request, Invalid, output); return output; }
  Parent parent(request.path, false);
  Owned source = readLeaf(parent, request.operation == "remove");
  output.stat = info(source.value);
  if (request.singleLink && output.stat.links != 1) unsafe("Linked companion files are not supported.");
  if (!request.expectedIdentity.empty() && request.expectedIdentity != identity(output.stat)) unsafe("Approved file identity changed before use.");
  if (!request.expectedVersion.empty() && request.expectedVersion != version(output.stat)) unsafe("Approved file contents changed before use.");
  if (request.operation == "remove") { deleteOpened(source.value, parent.handle(), parent.leaf()); return output; }
  if (request.operation == "copy") {
    Parent destination(request.destination, true); atomicWrite(destination, request, source.value, output); return output;
  }
  if (request.operation == "openRead") {
#ifdef _WIN32
    // libuv owns Node's descriptor table; using the addon's CRT table yields
    // invalid fds when Node/Electron and this addon use different CRTs.
    output.fd = uv_open_osfhandle(reinterpret_cast<uv_os_fd_t>(source.value));
    if (output.fd < 0) throw Failure("EIO", "Could not transfer file handle.");
    source.release();
#else
    output.fd = source.release();
#endif
    return output;
  }
  if (request.operation == "read") {
    if (request.maxBytes && output.stat.size > request.maxBytes) unsafe("File exceeds the allowed size.");
    char buffer[64 * 1024];
    for (size_t size; (size = readSome(source.value, buffer, sizeof(buffer))); ) {
      if (request.maxBytes && output.bytes.size() + size > request.maxBytes) unsafe("File exceeds the allowed size.");
      output.bytes.insert(output.bytes.end(), buffer, buffer + size);
    }
    return output;
  }
  unsafe("Unknown native file operation."); return output;
}

static napi_value string(napi_env env, const std::string& text) { napi_value value; napi_create_string_utf8(env, text.data(), text.size(), &value); return value; }
static napi_value property(napi_env env, napi_value value, const char* name) { napi_value result; napi_get_named_property(env, value, name, &result); return result; }
static std::string getString(napi_env env, napi_value value) {
  napi_valuetype type; napi_typeof(env, value, &type); if (type != napi_string) return {};
  size_t size; napi_get_value_string_utf8(env, value, nullptr, 0, &size);
  std::vector<char> text(size + 1); napi_get_value_string_utf8(env, value, text.data(), text.size(), &size);
  return std::string(text.data(), size);
}
static Request arguments(napi_env env, napi_value value) {
  Request result;
  result.operation = getString(env, property(env, value, "operation")); result.path = getString(env, property(env, value, "path"));
  result.destination = getString(env, property(env, value, "destination")); result.temporary = getString(env, property(env, value, "temporary"));
  result.expectedIdentity = getString(env, property(env, value, "expectedIdentity"));
  result.expectedVersion = getString(env, property(env, value, "expectedVersion"));
  napi_get_value_bool(env, property(env, value, "exclusive"), &result.exclusive);
  napi_get_value_bool(env, property(env, value, "singleLink"), &result.singleLink);
  napi_get_value_uint32(env, property(env, value, "mode"), &result.mode);
  napi_get_value_uint32(env, property(env, value, "maxBytes"), &result.maxBytes);
  auto buffer = property(env, value, "bytes"); bool isBuffer = false; napi_is_buffer(env, buffer, &isBuffer);
  if (isBuffer) { void* data; size_t size; napi_get_buffer_info(env, buffer, &data, &size); result.bytes.assign((char*)data, (char*)data + size); }
  return result;
}
static napi_value resultValue(napi_env env, const Result& output) {
  napi_value object; napi_create_object(env, &object);
  auto put = [&](const char* key, napi_value value) { napi_set_named_property(env, object, key, value); };
  napi_value size; napi_create_double(env, (double)output.stat.size, &size); put("size", size);
  put("identity", string(env, identity(output.stat))); put("actual", string(env, output.actual));
  put("version", string(env, version(output.stat)));
  put("linkPath", string(env, output.linkPath)); put("target", string(env, output.target)); put("suffix", string(env, output.suffix));
  napi_value exists; napi_get_boolean(env, output.exists, &exists); put("exists", exists);
  napi_value directory; napi_get_boolean(env, output.stat.directory, &directory); put("directory", directory);
  napi_value fd; napi_create_int32(env, output.fd, &fd); put("fd", fd);
  napi_value bytes; napi_create_buffer_copy(env, output.bytes.size(), output.bytes.data(), nullptr, &bytes); put("bytes", bytes);
  napi_value entries; napi_create_array_with_length(env, output.entries.size(), &entries);
  for (size_t i = 0; i < output.entries.size(); ++i) napi_set_element(env, entries, (uint32_t)i, string(env, output.entries[i]));
  put("entries", entries);
  return object;
}
static napi_value errorValue(napi_env env, const std::string& code, const std::string& message) {
  napi_value error; napi_create_error(env, string(env, code), string(env, message), &error); return error;
}
struct Work {
  napi_env env; napi_async_work work; napi_deferred deferred; Request request; Result result; std::string error, code;
};
static napi_value run(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 1) { napi_throw_type_error(env, nullptr, "Native operation request is required."); return nullptr; }
  auto job = std::make_unique<Work>(); job->env = env; job->request = arguments(env, args[0]);
  napi_value promise; napi_create_promise(env, &job->deferred, &promise);
  napi_create_async_work(env, nullptr, string(env, "PaperQuayBoundFile"), [](napi_env, void* data) {
    auto* work = static_cast<Work*>(data);
    try { work->result = execute(work->request); }
    catch (const Failure& error) { work->error = error.what(); work->code = error.code; }
    catch (const std::exception& error) { work->error = error.what(); work->code = "EIO"; }
  }, [](napi_env env, napi_status status, void* data) {
    std::unique_ptr<Work> work(static_cast<Work*>(data));
    if (status != napi_ok && work->error.empty()) { work->code = "EIO"; work->error = "Native file operation canceled."; }
    if (work->error.empty()) napi_resolve_deferred(env, work->deferred, resultValue(env, work->result));
    else napi_reject_deferred(env, work->deferred, errorValue(env, work->code, work->error));
    napi_delete_async_work(env, work->work);
  }, job.get(), &job->work);
  napi_queue_async_work(env, job->work); job.release(); return promise;
}
static napi_value runSync(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 1) { napi_throw_type_error(env, nullptr, "Native operation request is required."); return nullptr; }
  try { return resultValue(env, execute(arguments(env, args[0]))); }
  catch (const Failure& error) { napi_throw(env, errorValue(env, error.code, error.what())); }
  catch (const std::exception& error) { napi_throw(env, errorValue(env, "EIO", error.what())); }
  return nullptr;
}
static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {{"run", nullptr, run, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"runSync", nullptr, runSync, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 2, descriptors); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
