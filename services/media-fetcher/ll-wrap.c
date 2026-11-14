/* Landlock wrapper for radio ffmpeg. UAPI inlined — bookworm headers lack net/fs fields.
 * Mandatory: ABI >= 4 TCP CONNECT to the job shim port + filesystem allow-list.
 * ABI >= 9 also handles pathname UNIX resolve (denied; no path grants it).
 * Fail closed if any mandatory rule cannot be installed. Never allow /jobs or /ctl. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_ACCESS_NET_CONNECT_TCP (1ULL << 1)
#define LANDLOCK_RULE_PATH_BENEATH 1
#define LANDLOCK_RULE_NET_PORT 2
#define LANDLOCK_MIN_ABI 4

#define LANDLOCK_ACCESS_FS_EXECUTE      (1ULL << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE   (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE    (1ULL << 2)
#define LANDLOCK_ACCESS_FS_READ_DIR     (1ULL << 3)
#define LANDLOCK_ACCESS_FS_REMOVE_DIR   (1ULL << 4)
#define LANDLOCK_ACCESS_FS_REMOVE_FILE  (1ULL << 5)
#define LANDLOCK_ACCESS_FS_MAKE_CHAR    (1ULL << 6)
#define LANDLOCK_ACCESS_FS_MAKE_DIR     (1ULL << 7)
#define LANDLOCK_ACCESS_FS_MAKE_REG     (1ULL << 8)
#define LANDLOCK_ACCESS_FS_MAKE_SOCK    (1ULL << 9)
#define LANDLOCK_ACCESS_FS_MAKE_FIFO    (1ULL << 10)
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK   (1ULL << 11)
#define LANDLOCK_ACCESS_FS_MAKE_SYM     (1ULL << 12)
#define LANDLOCK_ACCESS_FS_REFER        (1ULL << 13)
#define LANDLOCK_ACCESS_FS_TRUNCATE     (1ULL << 14)
#define LANDLOCK_ACCESS_FS_IOCTL_DEV    (1ULL << 15)
#define LANDLOCK_ACCESS_FS_RESOLVE_UNIX (1ULL << 16)

struct landlock_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
};
struct landlock_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
};
struct landlock_net_port_attr {
  uint64_t allowed_access;
  uint64_t port;
};

static int landlock_abi(void) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) return -errno;
  return (int)abi;
}

static uint64_t fs_handled_for_abi(int abi) {
  uint64_t fs =
      LANDLOCK_ACCESS_FS_EXECUTE |
      LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_CHAR |
      LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG |
      LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO |
      LANDLOCK_ACCESS_FS_MAKE_BLOCK |
      LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) fs |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) fs |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) fs |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  if (abi >= 9) fs |= LANDLOCK_ACCESS_FS_RESOLVE_UNIX;
  return fs;
}

static int add_path(int ruleset, const char *path, uint64_t access, uint64_t handled) {
  uint64_t allowed = access & handled;
  if (!allowed) return 0;
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    /* Optional paths (e.g. /lib64) may be absent. */
    if (errno == ENOENT) return 0;
    fprintf(stderr, "ll-wrap: open %s: %s\n", path, strerror(errno));
    return -1;
  }
  struct landlock_path_beneath_attr path_beneath = {
    .allowed_access = allowed,
    .parent_fd = fd,
  };
  if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &path_beneath, 0) != 0) {
    fprintf(stderr, "ll-wrap: add path %s: %s\n", path, strerror(errno));
    close(fd);
    return -1;
  }
  close(fd);
  return 0;
}

static int add_fs_allowlist(int ruleset, uint64_t handled) {
  const uint64_t ro_tree =
      LANDLOCK_ACCESS_FS_EXECUTE |
      LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_READ_DIR;
  const uint64_t ro_file = LANDLOCK_ACCESS_FS_READ_FILE;
  const uint64_t rw_dev =
      LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_IOCTL_DEV;
  const uint64_t tmp =
      LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_REG |
      LANDLOCK_ACCESS_FS_TRUNCATE;

  /* Intentionally omit /jobs and /ctl — secrets and control sockets stay denied. */
  struct {
    const char *path;
    uint64_t access;
    int required;
  } paths[] = {
    { "/usr", ro_tree, 1 },
    { "/lib", ro_tree, 0 },
    { "/lib64", ro_tree, 0 },
    { "/etc/ssl", ro_tree, 1 },
    { "/etc/hosts", ro_file, 0 },
    { "/etc/resolv.conf", ro_file, 0 },
    { "/etc/nsswitch.conf", ro_file, 0 },
    { "/dev/null", rw_dev, 1 },
    { "/dev/urandom", ro_file | LANDLOCK_ACCESS_FS_IOCTL_DEV, 1 },
    { "/dev/random", ro_file | LANDLOCK_ACCESS_FS_IOCTL_DEV, 0 },
    { "/tmp", tmp, 1 },
  };
  for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
    int fd = open(paths[i].path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
      if (!paths[i].required && errno == ENOENT) continue;
      fprintf(stderr, "ll-wrap: open %s: %s\n", paths[i].path, strerror(errno));
      return -1;
    }
    close(fd);
    if (add_path(ruleset, paths[i].path, paths[i].access, handled) != 0) return -1;
  }
  return 0;
}

static void close_extra_fds(void) {
  for (int fd = 3; fd < 256; fd++) close(fd);
}

static int enforce(unsigned long port) {
  int abi = landlock_abi();
  if (abi < LANDLOCK_MIN_ABI) {
    fprintf(stderr, "ll-wrap: landlock ABI %d < 4\n", abi);
    return 1;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "ll-wrap: no_new_privs: %s\n", strerror(errno));
    return 1;
  }
  uint64_t handled_fs = fs_handled_for_abi(abi);
  struct landlock_ruleset_attr rs = {
    .handled_access_fs = handled_fs,
    .handled_access_net = LANDLOCK_ACCESS_NET_CONNECT_TCP,
  };
  int fd = (int)syscall(__NR_landlock_create_ruleset, &rs, sizeof(rs), 0);
  if (fd < 0) {
    fprintf(stderr, "ll-wrap: landlock unavailable (%s)\n", strerror(errno));
    return 1;
  }
  if (add_fs_allowlist(fd, handled_fs) != 0) {
    close(fd);
    return 1;
  }
  struct landlock_net_port_attr net = {
    .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP,
    .port = port,
  };
  if (syscall(__NR_landlock_add_rule, fd, LANDLOCK_RULE_NET_PORT, &net, 0) != 0) {
    fprintf(stderr, "ll-wrap: add port: %s\n", strerror(errno));
    close(fd);
    return 1;
  }
  if (syscall(__NR_landlock_restrict_self, fd, 0) != 0) {
    fprintf(stderr, "ll-wrap: restrict: %s\n", strerror(errno));
    close(fd);
    return 1;
  }
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--check") == 0) {
    int abi = landlock_abi();
    if (abi < LANDLOCK_MIN_ABI) {
      fprintf(stderr, "ll-wrap: landlock ABI %d < 4\n", abi);
      return 1;
    }
    if (enforce(1) != 0) return 1;
    printf("landlock_abi=%d\n", abi);
    printf("landlock_fs=1\n");
    if (abi >= 9) printf("landlock_resolve_unix=1\n");
    else printf("landlock_resolve_unix=0\n");
    return 0;
  }
  if (argc < 3) return 2;
  unsigned long port = strtoul(argv[1], NULL, 10);
  if (port < 1 || port > 65535) return 2;
  if (enforce(port) != 0) return 1;
  close_extra_fds();
  execvp(argv[2], argv + 2);
  fprintf(stderr, "ll-wrap: exec: %s\n", strerror(errno));
  return 127;
}
