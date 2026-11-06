// SQLite's public VFS/system-call interfaces keep its native locking, WAL,
// mmap and durability implementation. Only pathname resolution is replaced.
// This file is included after the retained-handle filesystem primitives.
#include "sqlite-api/sqlite3ext.h"
#include <map>
#include <mutex>
#include <new>
#include <cstddef>
#include <set>
SQLITE_EXTENSION_INIT1

namespace sqliteBoundary {
struct Capability {
  Parent parent;
  Name key;
  unsigned leases = 0, files = 0;
  explicit Capability(const std::string& path) : parent(path, false), key(wide(path)) {}
};
static std::mutex mutex;
static std::map<Name, std::shared_ptr<Capability>> capabilities;
static sqlite3_vfs* original = nullptr;
static sqlite3_vfs vfs{};
static constexpr const char* VfsName = "paperquay-pinned";
static Name key(Name input) {
#ifdef _WIN32
  std::replace(input.begin(), input.end(), L'/', L'\\');
  if (input.rfind(L"\\\\?\\UNC\\", 0) == 0) input = L"\\\\" + input.substr(8);
  else if (input.rfind(L"\\\\?\\", 0) == 0) input = input.substr(4);
  // Normalize the spelling used by SQLite's UTF-16 system calls.
  if (!input.empty()) CharLowerBuffW(input.data(), (DWORD)input.size());
#endif
  return input;
}
struct Match { std::shared_ptr<Capability> capability; Name leaf; };
static Match match(const Name& path) {
  const auto wanted = key(path);
  std::lock_guard<std::mutex> lock(mutex);
  const auto exact = capabilities.find(wanted);
  if (exact != capabilities.end()) return {exact->second, exact->second->parent.leaf()};
  for (const auto& entry : capabilities) {
    const auto& base = entry.first;
    // SQLite guarantees a suffix of '-' and at most 11 ASCII alphanumerics
    // or hyphens for WAL, SHM, rollback and multi-database journals.
    if (wanted.size() > base.size() + 1 && wanted.size() <= base.size() + 12 &&
        wanted.compare(0, base.size(), base) == 0 && wanted[base.size()] == '-') {
      const auto suffix = wanted.substr(base.size());
      if (std::all_of(suffix.begin(), suffix.end(), [](auto c) {
        return c == '-' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
      })) return {entry.second, entry.second->parent.leaf() + suffix};
    }
  }
  return {};
}
static void collect(const std::shared_ptr<Capability>& cap) {
  if (!cap->leases && !cap->files) capabilities.erase(cap->key);
}
static bool safeFile(Handle file) {
  const auto details = info(file);
  return !details.directory && !details.reparse && details.links == 1;
}

#ifdef _WIN32
using OpenFn = HANDLE (WINAPI*)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
static OpenFn previousOpen;
static BOOL (WINAPI* previousDelete)(LPCWSTR);
static DWORD (WINAPI* previousAttributes)(LPCWSTR);
static BOOL (WINAPI* previousAttributesEx)(LPCWSTR, GET_FILEEX_INFO_LEVELS, LPVOID);
static DWORD windowsError(const Failure& failure) {
  if (failure.code == "ENOENT") return ERROR_FILE_NOT_FOUND;
  if (failure.code == "EEXIST") return ERROR_FILE_EXISTS;
  if (failure.code == "EBUSY") return ERROR_SHARING_VIOLATION;
  if (failure.code == "ENOSPC") return ERROR_DISK_FULL;
  return ERROR_ACCESS_DENIED;
}
static HANDLE WINAPI guardedOpen(LPCWSTR path, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
                                 DWORD creation, DWORD flags, HANDLE templateFile) {
  try {
    const auto target = match(path);
    if (!target.capability) return previousOpen(path, access, share, security, creation, flags, templateFile);
    // Resolve against the retained directory object, including if a supplier
    // changes an ancestor's reparse data in place without renaming it.
    const DWORD supported = FILE_ATTRIBUTE_NORMAL | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY |
      FILE_FLAG_RANDOM_ACCESS | FILE_FLAG_SEQUENTIAL_SCAN | FILE_FLAG_WRITE_THROUGH |
      FILE_FLAG_NO_BUFFERING | FILE_FLAG_DELETE_ON_CLOSE | FILE_FLAG_OPEN_REPARSE_POINT;
    if (security || templateFile || (flags & ~supported)) unsafe("Unsupported SQLite file-open flags.");
    const bool truncate = creation == CREATE_ALWAYS || creation == TRUNCATE_EXISTING;
    const ULONG disposition = creation == CREATE_NEW ? 2 : creation == CREATE_ALWAYS || creation == OPEN_ALWAYS ? 3 : 1;
    ULONG options = 0;
    if (flags & FILE_FLAG_RANDOM_ACCESS) options |= 0x800;
    if (flags & FILE_FLAG_SEQUENTIAL_SCAN) options |= 0x4;
    if (flags & FILE_FLAG_WRITE_THROUGH) options |= 0x2;
    if (flags & FILE_FLAG_NO_BUFFERING) options |= 0x8;
    if (flags & FILE_FLAG_DELETE_ON_CLOSE) { options |= 0x1000; access |= DELETE; }
    Owned file(relativeOpen(target.capability->parent.handle(), target.leaf, access, disposition, false,
      !(share & FILE_SHARE_DELETE), options, share & ~FILE_SHARE_DELETE, flags & 0xffff));
    if (!safeFile(file.value)) { closeHandle(file.release()); SetLastError(ERROR_ACCESS_DENIED); return Invalid; }
    if (truncate) {
      LARGE_INTEGER zero{};
      if (!SetFilePointerEx(file.value, zero, nullptr, FILE_BEGIN) || !SetEndOfFile(file.value)) return Invalid;
    }
    return file.release();
  } catch (const Failure& failure) { SetLastError(windowsError(failure)); return Invalid; }
  catch (...) { SetLastError(ERROR_ACCESS_DENIED); return Invalid; }
}
static BOOL WINAPI guardedDelete(LPCWSTR path) {
  try {
    const auto target = match(path);
    if (!target.capability) return previousDelete(path);
    Owned file(relativeOpen(target.capability->parent.handle(), target.leaf, DELETE, 1, false, false));
    if (info(file.value).directory) unsafe("SQLite cannot delete a directory.");
    deleteOpened(file.value, target.capability->parent.handle(), target.leaf);
    return TRUE;
  } catch (const Failure& failure) { SetLastError(windowsError(failure)); return FALSE; }
  catch (...) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
}
static BOOL WINAPI guardedAttributesEx(LPCWSTR path, GET_FILEEX_INFO_LEVELS level, LPVOID output) {
  try {
    const auto target = match(path);
    if (!target.capability) return previousAttributesEx(path, level, output);
    if (level != GetFileExInfoStandard || !output) unsafe("Unsupported SQLite file information request.");
    Owned file(relativeOpen(target.capability->parent.handle(), target.leaf, FILE_READ_ATTRIBUTES, 1, false, false));
    if (!safeFile(file.value)) unsafe("Linked SQLite file is not supported.");
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(file.value, &info)) winError(GetLastError(), "SQLite file information");
    auto* data = static_cast<WIN32_FILE_ATTRIBUTE_DATA*>(output);
    data->dwFileAttributes = info.dwFileAttributes;
    data->ftCreationTime = info.ftCreationTime; data->ftLastAccessTime = info.ftLastAccessTime; data->ftLastWriteTime = info.ftLastWriteTime;
    data->nFileSizeHigh = info.nFileSizeHigh; data->nFileSizeLow = info.nFileSizeLow;
    return TRUE;
  } catch (const Failure& failure) { SetLastError(windowsError(failure)); return FALSE; }
  catch (...) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
}
static DWORD WINAPI guardedAttributes(LPCWSTR path) {
  try {
    if (!match(path).capability) return previousAttributes(path);
    WIN32_FILE_ATTRIBUTE_DATA data{};
    return guardedAttributesEx(path, GetFileExInfoStandard, &data) ? data.dwFileAttributes : INVALID_FILE_ATTRIBUTES;
  } catch (...) { SetLastError(ERROR_ACCESS_DENIED); return INVALID_FILE_ATTRIBUTES; }
}
#else
using OpenFn = int (*)(const char*, int, int);
using StatFn = int (*)(const char*, struct stat*);
static OpenFn previousOpen;
static StatFn previousStat, previousLstat;
static int (*previousAccess)(const char*, int);
static int (*previousUnlink)(const char*);
static int (*previousOpenDirectory)(const char*, int*);
static int guardedOpen(const char* path, int flags, int mode) {
  try {
    const auto target = match(path);
    if (!target.capability) return previousOpen(path, flags, mode);
    Owned file(openat(target.capability->parent.handle(), target.leaf.c_str(),
      (flags & ~O_TRUNC) | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, mode));
    if (file.value == Invalid) return Invalid;
    if (!safeFile(file.value)) { closeHandle(file.release()); errno = EPERM; return Invalid; }
    if ((flags & O_TRUNC) && ftruncate(file.value, 0)) return Invalid;
    return file.release();
  } catch (...) { errno = EPERM; return Invalid; }
}
static int guardedStatImpl(const char* path, struct stat* output, StatFn fallback) {
  try {
    const auto target = match(path);
    if (!target.capability) return fallback(path, output);
    if (fstatat(target.capability->parent.handle(), target.leaf.c_str(), output, AT_SYMLINK_NOFOLLOW)) return -1;
    if (!S_ISREG(output->st_mode) || output->st_nlink != 1) { errno = EPERM; return -1; }
    return 0;
  } catch (...) { errno = EPERM; return -1; }
}
static int guardedStat(const char* path, struct stat* output) { return guardedStatImpl(path, output, previousStat); }
static int guardedLstat(const char* path, struct stat* output) { return guardedStatImpl(path, output, previousLstat); }
static int guardedAccess(const char* path, int mode) {
  try {
    const auto target = match(path);
    if (!target.capability) return previousAccess(path, mode);
    struct stat details{};
    if (guardedStat(path, &details)) return -1;
    return faccessat(target.capability->parent.handle(), target.leaf.c_str(), mode, AT_EACCESS | AT_SYMLINK_NOFOLLOW);
  } catch (...) { errno = EPERM; return -1; }
}
static int guardedUnlink(const char* path) {
  try {
    const auto target = match(path);
    if (!target.capability) return previousUnlink(path);
    return unlinkat(target.capability->parent.handle(), target.leaf.c_str(), 0);
  } catch (...) { errno = EPERM; return -1; }
}
static int guardedOpenDirectory(const char* path, int* output) {
  try {
    const auto target = match(path);
    if (!target.capability) return previousOpenDirectory(path, output);
    // A new *directory* descriptor cannot release SQLite's inode locks.
    *output = openat(target.capability->parent.handle(), ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    return *output < 0 ? SQLITE_CANTOPEN : SQLITE_OK;
  } catch (...) { return SQLITE_CANTOPEN; }
}
#endif

struct Hook { const char* name; sqlite3_syscall_ptr replacement; sqlite3_syscall_ptr previous; };
static Hook hooks[] = {
  {"CreateFileW", reinterpret_cast<sqlite3_syscall_ptr>(guardedOpen), nullptr},
#ifdef _WIN32
  {"DeleteFileW", reinterpret_cast<sqlite3_syscall_ptr>(guardedDelete), nullptr},
  {"GetFileAttributesW", reinterpret_cast<sqlite3_syscall_ptr>(guardedAttributes), nullptr},
  {"GetFileAttributesExW", reinterpret_cast<sqlite3_syscall_ptr>(guardedAttributesEx), nullptr},
#else
  // The first name is changed to "open" below on POSIX.
  {"stat", reinterpret_cast<sqlite3_syscall_ptr>(guardedStat), nullptr},
  {"lstat", reinterpret_cast<sqlite3_syscall_ptr>(guardedLstat), nullptr},
  {"access", reinterpret_cast<sqlite3_syscall_ptr>(guardedAccess), nullptr},
  {"unlink", reinterpret_cast<sqlite3_syscall_ptr>(guardedUnlink), nullptr},
  {"openDirectory", reinterpret_cast<sqlite3_syscall_ptr>(guardedOpenDirectory), nullptr},
#endif
};
static bool hooksValid() {
  if (!original) return false;
  for (const auto& hook : hooks) if (original->xGetSystemCall(original, hook.name) != hook.replacement) return false;
  return sqlite3_vfs_find(VfsName) == &vfs;
}

// Retain capabilities until SQLite has closed EVERY related file, even if a
// connection closes with a deferred file close. Native I/O methods remain the
// platform's implementation; the proxy owns no data or locking algorithms.
struct Proxy {
  sqlite3_file base{};
  sqlite3_io_methods methods{};
  std::shared_ptr<Capability> capability;
};
static constexpr size_t ProxySize = (sizeof(Proxy) + alignof(std::max_align_t) - 1) & ~(alignof(std::max_align_t) - 1);
static sqlite3_file* inner(sqlite3_file* file) { return reinterpret_cast<sqlite3_file*>(reinterpret_cast<char*>(file) + ProxySize); }
static int close(sqlite3_file* file) {
  auto* proxy = reinterpret_cast<Proxy*>(file);
  const int result = inner(file)->pMethods->xClose(inner(file));
  if (proxy->capability) {
    std::lock_guard<std::mutex> lock(mutex);
    --proxy->capability->files; collect(proxy->capability);
  }
  proxy->~Proxy();
  file->pMethods = nullptr;
  return result;
}
#define PASS(NAME, PARAMS, ARGS) static int NAME PARAMS { auto* f = inner(file); return f->pMethods->NAME ARGS; }
PASS(xRead, (sqlite3_file* file, void* buffer, int size, sqlite3_int64 offset), (f, buffer, size, offset))
PASS(xWrite, (sqlite3_file* file, const void* buffer, int size, sqlite3_int64 offset), (f, buffer, size, offset))
PASS(xTruncate, (sqlite3_file* file, sqlite3_int64 size), (f, size))
PASS(xSync, (sqlite3_file* file, int flags), (f, flags))
PASS(xFileSize, (sqlite3_file* file, sqlite3_int64* size), (f, size))
PASS(xLock, (sqlite3_file* file, int level), (f, level))
PASS(xUnlock, (sqlite3_file* file, int level), (f, level))
PASS(xCheckReservedLock, (sqlite3_file* file, int* held), (f, held))
PASS(xFileControl, (sqlite3_file* file, int operation, void* argument), (f, operation, argument))
PASS(xSectorSize, (sqlite3_file* file), (f))
PASS(xDeviceCharacteristics, (sqlite3_file* file), (f))
PASS(xShmMap, (sqlite3_file* file, int page, int size, int extend, void volatile** output), (f, page, size, extend, output))
PASS(xShmLock, (sqlite3_file* file, int offset, int count, int flags), (f, offset, count, flags))
PASS(xShmUnmap, (sqlite3_file* file, int remove), (f, remove))
PASS(xFetch, (sqlite3_file* file, sqlite3_int64 offset, int size, void** output), (f, offset, size, output))
PASS(xUnfetch, (sqlite3_file* file, sqlite3_int64 offset, void* pointer), (f, offset, pointer))
#undef PASS
static void xShmBarrier(sqlite3_file* file) { auto* f = inner(file); f->pMethods->xShmBarrier(f); }
static int open(sqlite3_vfs*, const char* name, sqlite3_file* output, int flags, int* outFlags) {
  std::shared_ptr<Capability> cap;
  try {
    if (!hooksValid()) return SQLITE_CANTOPEN;
    if (name) { cap = match(wide(name)).capability; if (!cap) return SQLITE_CANTOPEN; }
    if (cap) { std::lock_guard<std::mutex> lock(mutex); ++cap->files; }
    auto* proxy = new (output) Proxy();
    proxy->capability = cap;
    auto* f = inner(output);
    memset(f, 0, original->szOsFile);
    const int result = original->xOpen(original, name, f, flags, outFlags);
    if (result != SQLITE_OK) {
      if (f->pMethods) f->pMethods->xClose(f);
      if (cap) { std::lock_guard<std::mutex> lock(mutex); --cap->files; collect(cap); }
      proxy->~Proxy(); output->pMethods = nullptr;
      return result;
    }
    proxy->methods = *f->pMethods;
    auto& m = proxy->methods;
    m.xClose = close;
#define WRAP(NAME) if (m.NAME) m.NAME = NAME
    WRAP(xRead); WRAP(xWrite); WRAP(xTruncate); WRAP(xSync); WRAP(xFileSize);
    WRAP(xLock); WRAP(xUnlock); WRAP(xCheckReservedLock); WRAP(xFileControl);
    WRAP(xSectorSize); WRAP(xDeviceCharacteristics);
    if (m.iVersion >= 2) { WRAP(xShmMap); WRAP(xShmLock); WRAP(xShmBarrier); WRAP(xShmUnmap); }
    if (m.iVersion >= 3) { WRAP(xFetch); WRAP(xUnfetch); }
#undef WRAP
    output->pMethods = &m;
    return SQLITE_OK;
  } catch (...) { return SQLITE_CANTOPEN; }
}
static int fullPath(sqlite3_vfs*, const char* name, int length, char* output) {
  try {
    if (!hooksValid() || !match(wide(name)).capability || strlen(name) >= size_t(length)) return SQLITE_CANTOPEN;
    memcpy(output, name, strlen(name) + 1); return SQLITE_OK;
  } catch (...) { return SQLITE_CANTOPEN; }
}
static int remove(sqlite3_vfs*, const char* name, int sync) {
  try {
    if (!hooksValid() || !match(wide(name)).capability) return SQLITE_IOERR_DELETE;
    return original->xDelete(original, name, sync);
  } catch (...) { return SQLITE_IOERR_DELETE; }
}
static int access(sqlite3_vfs*, const char* name, int flags, int* output) {
  try {
    if (!hooksValid() || !match(wide(name)).capability) return SQLITE_IOERR_ACCESS;
    return original->xAccess(original, name, flags, output);
  } catch (...) { return SQLITE_IOERR_ACCESS; }
}
static int initialize(const sqlite3_api_routines* api) {
  std::lock_guard<std::mutex> lock(mutex);
  if (original) return hooksValid() ? SQLITE_OK_LOAD_PERMANENTLY : SQLITE_ERROR;
  SQLITE_EXTENSION_INIT2(api);
  auto* candidate = sqlite3_vfs_find(nullptr);
  if (!candidate || candidate->iVersion < 3 || !candidate->xSetSystemCall || !candidate->xGetSystemCall) return SQLITE_ERROR;
#ifndef _WIN32
  hooks[0].name = "open";
#endif
  // Validate the whole required public interface before changing any callback.
  for (auto& hook : hooks) {
    hook.previous = candidate->xGetSystemCall(candidate, hook.name);
    if (!hook.previous || hook.previous == hook.replacement) return SQLITE_ERROR;
  }
  previousOpen = reinterpret_cast<OpenFn>(hooks[0].previous);
#ifdef _WIN32
  previousDelete = reinterpret_cast<decltype(previousDelete)>(hooks[1].previous);
  previousAttributes = reinterpret_cast<decltype(previousAttributes)>(hooks[2].previous);
  previousAttributesEx = reinterpret_cast<decltype(previousAttributesEx)>(hooks[3].previous);
#else
  previousStat = reinterpret_cast<StatFn>(hooks[1].previous);
  previousLstat = reinterpret_cast<StatFn>(hooks[2].previous);
  previousAccess = reinterpret_cast<decltype(previousAccess)>(hooks[3].previous);
  previousUnlink = reinterpret_cast<decltype(previousUnlink)>(hooks[4].previous);
  previousOpenDirectory = reinterpret_cast<decltype(previousOpenDirectory)>(hooks[5].previous);
#endif
  size_t installed = 0;
  for (auto& hook : hooks) {
    if (candidate->xSetSystemCall(candidate, hook.name, hook.replacement) != SQLITE_OK) {
      for (size_t i = 0; i < installed; ++i) candidate->xSetSystemCall(candidate, hooks[i].name, hooks[i].previous);
      return SQLITE_ERROR;
    }
    ++installed;
  }
  vfs = *candidate; vfs.zName = VfsName; vfs.pNext = nullptr;
  vfs.szOsFile = int(ProxySize) + candidate->szOsFile;
  vfs.xOpen = open; vfs.xFullPathname = fullPath; vfs.xDelete = remove; vfs.xAccess = access;
  if (sqlite3_vfs_register(&vfs, 0) != SQLITE_OK) {
    for (const auto& hook : hooks) candidate->xSetSystemCall(candidate, hook.name, hook.previous);
    return SQLITE_ERROR;
  }
  original = candidate;
  return SQLITE_OK_LOAD_PERMANENTLY;
}
struct Lease { std::shared_ptr<Capability> capability; };
static std::set<Lease*> leases;
static napi_value pin(napi_env env, napi_callback_info arguments) {
  size_t count = 1; napi_value values[1]; napi_get_cb_info(env, arguments, &count, values, nullptr, nullptr);
  try {
    if (count != 1 || !hooksValid()) unsafe("Pinned SQLite VFS unavailable.");
    const auto path = getString(env, values[0]);
    const auto wanted = key(wide(path));
    auto lease = std::make_unique<Lease>();
    {
      std::lock_guard<std::mutex> lock(mutex);
      auto found = capabilities.find(wanted);
      if (found == capabilities.end()) {
        auto cap = std::make_shared<Capability>(path); cap->key = wanted;
        found = capabilities.emplace(wanted, std::move(cap)).first;
      }
      ++found->second->leases;
      lease->capability = found->second;
      leases.insert(lease.get());
    }
    napi_value result;
    napi_create_external(env, lease.release(), [](napi_env, void* data, void*) {
      // SQLite's own GC finalizer has no ordering contract with JS finalizers.
      // An unclosed connection therefore retains its directory until process
      // exit. Explicit close() releases it after SQLite closes its files.
      std::lock_guard<std::mutex> lock(mutex);
      auto* lease = static_cast<Lease*>(data);
      leases.erase(lease); delete lease;
    }, nullptr, &result);
    return result;
  } catch (const Failure& error) { napi_throw(env, errorValue(env, error.code, error.what())); }
  catch (...) { napi_throw(env, errorValue(env, "EIO", "Could not retain SQLite directory.")); }
  return nullptr;
}
static napi_value release(napi_env env, napi_callback_info arguments) {
  size_t count = 1; napi_value values[1], result; void* data = nullptr;
  napi_get_cb_info(env, arguments, &count, values, nullptr, nullptr);
  if (count != 1 || napi_get_value_external(env, values[0], &data) != napi_ok || !data) {
    napi_throw_type_error(env, nullptr, "SQLite directory lease is required."); return nullptr;
  }
  auto* lease = static_cast<Lease*>(data);
  std::lock_guard<std::mutex> lock(mutex);
  if (!leases.count(lease)) { napi_throw_type_error(env, nullptr, "Unknown SQLite directory lease."); return nullptr; }
  if (lease->capability) {
    --lease->capability->leases; collect(lease->capability); lease->capability.reset();
  }
  napi_get_undefined(env, &result); return result;
}
} // namespace sqliteBoundary

extern "C"
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3*, char**, const sqlite3_api_routines* api) {
  try { return sqliteBoundary::initialize(api); } catch (...) { return SQLITE_ERROR; }
}
