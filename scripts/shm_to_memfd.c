// LD_PRELOAD shim: hijack shm_open() and redirect to memfd_create()
// so callers get an unlimited anonymous file instead of a 64 MB tmpfs file.
//
// Docker containers default /dev/shm to 64 MB. Dolphin's memory arena uses
// shm_open + ftruncate + mmap MAP_SHARED, then triggers SIGBUS the moment
// it touches a page past the tmpfs limit. memfd_create backs to internal
// kernel shmfs which has no size cap in this environment.
//
// Build: gcc -O2 -fPIC -shared -o shm_to_memfd.so shm_to_memfd.c -ldl
// Use:   LD_PRELOAD=/path/to/shm_to_memfd.so <program>

#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

// memfd_create wasn't in older glibcs; syscall directly for portability
static int memfd(const char *name, unsigned int flags) {
    return (int)syscall(SYS_memfd_create, name, flags);
}

// shm_open signature: int shm_open(const char *name, int oflag, mode_t mode)
int shm_open(const char *name, int oflag, mode_t mode) {
    // Only intercept O_CREAT | O_RDWR flavor — that's what arenas use.
    // If callers open an EXISTING shared segment by name, memfd won't help;
    // pass through to the real shm_open in that case. (Dolphin only creates.)
    if (!(oflag & O_CREAT)) {
        static int (*real)(const char *, int, mode_t) = NULL;
        if (!real) real = dlsym(RTLD_NEXT, "shm_open");
        if (real) return real(name, oflag, mode);
    }
    // Strip leading slash if present (memfd names can't start with /)
    const char *n = (name && name[0] == '/') ? name + 1 : (name ? name : "shim");
    int fd = memfd(n, 0);
    return fd;   // -1 on failure with errno set
}

// shm_unlink: on memfd-backed fds there's no name to unlink; NOP success.
int shm_unlink(const char *name) {
    (void)name;
    return 0;
}
